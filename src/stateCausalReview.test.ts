import * as Automerge from "@automerge/automerge/slim"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { readFile } from "node:fs/promises"
import { initializeAutomerge } from "./crdt"
import { resolvedReviewLinks } from "./stateCausalReview"
import type { WorkspaceDocumentV2 } from "./domain/model"
import type { StoredCausalEvidence } from "./storageJournal"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

describe("quarantined review resolution", () => {
  it("requires the exact review clone to be admitted before hiding the source", () => {
    let doc = Automerge.from({ id: "review-test", title: "Original" } as unknown as WorkspaceDocumentV2)
    doc = Automerge.change(doc, { message: "source edit" }, draft => { draft.title = "Quarantined" })
    const sourceHash = Automerge.getChangesMetaSince(doc, []).at(-1)!.hash
    doc = Automerge.change(doc, {
      message: JSON.stringify({ action: "reviewQuarantinedChange", sourceChangeHash: sourceHash }),
    }, draft => { draft.title = "Authorized clone" })
    const changes = Automerge.getChangesMetaSince(doc, [])
    const source = changes.at(-2)
    const clone = changes.at(-1)
    const evidence: StoredCausalEvidence = {
      bytes: Automerge.save(doc),
      decisions: [
        { hash: sourceHash, status: { type: "quarantined", reason: "unsigned source" } },
        { hash: clone!.hash, status: { type: "quarantined", reason: "clone lacks admission" } },
      ],
      resolvedReviews: [{ sourceHash, authorizedChangeHash: clone!.hash }],
    }

    expect(source!.hash).toBe(sourceHash)
    expect(resolvedReviewLinks(evidence, doc).has(sourceHash)).toBe(false)

    evidence.decisions[1] = { hash: clone!.hash, status: { type: "admitted", role: "owner" } }
    expect(resolvedReviewLinks(evidence, doc).get(sourceHash)).toBe(clone!.hash)
  })
})
