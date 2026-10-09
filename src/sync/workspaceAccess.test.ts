import { readFile } from "node:fs/promises"
import * as Automerge from "@automerge/automerge/slim"
import { beforeAll, expect, it, vi } from "vitest"
import { initializeAutomerge } from "../crdt"
import { createWorkspaceDoc } from "../domain/seeds"
import type { WorkspaceDocumentV2 } from "../domain/model"
import { decideAccess, inheritLocalMoveAccess } from "./workspaceAccess"

const decision = vi.hoisted(() => vi.fn(() => "editor"))
const stages = vi.hoisted(() => [] as string[])
vi.mock("./startupDiagnostics", () => ({ diagnoseStartupStep: async (stage: string, step: () => unknown) => {
  stages.push(`${stage}:started`)
  const result = await step()
  stages.push(`${stage}:completed`)
  return result
} }))
vi.mock("@meta-uber/mesh-replication/runtime", () => ({ meshRustRuntime: () => ({ state: { decideWorkspaceAccess: decision } }) }))
beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

it("Given uncached access, When checking permissions, Then checkpoints precede document serialization and policy execution", async () => {
  stages.length = 0
  const doc = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc(crypto.randomUUID(), "Access", "owner", "blank"))
  decision.mockImplementationOnce(() => {
    expect(stages).toEqual(["access-serialize:started", "access-serialize:completed", "access-policy:started"])
    return "editor"
  })
  await expect(decideAccess(doc, { snapshot: {} })).resolves.toBe("editor")
  expect(stages.at(-1)).toBe("access-policy:completed")
  Automerge.free(doc)
})

it("revalidates revoked authority after a trusted move instead of retaining cached editor rights", async () => {
  const doc = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc(crypto.randomUUID(), "Access", "owner", "blank"))
  const evidence = { snapshot: { ownerPersonId: "owner" }, revocations: [] as string[] }
  decision.mockReturnValue("editor")
  await expect(decideAccess(doc, evidence)).resolves.toBe("editor")
  const moved = Automerge.change(Automerge.clone(doc), draft => { draft.title = "Trusted local move fixture" })
  inheritLocalMoveAccess(doc, moved)
  const calls = decision.mock.calls.length
  await expect(decideAccess(moved, evidence)).resolves.toBe("editor")
  expect(decision).toHaveBeenCalledTimes(calls)
  decision.mockReturnValue("visitor")
  await expect(decideAccess(moved, { ...evidence, revocations: ["revoked device"] })).resolves.toBe("visitor")
  expect(decision).toHaveBeenCalledTimes(calls + 1)
})

it("revalidates an unrelated document change even with identical authority", async () => {
  const doc = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc(crypto.randomUUID(), "Access", "owner", "blank"))
  const evidence = { snapshot: { ownerPersonId: "owner" } }
  await decideAccess(doc, evidence)
  const calls = decision.mock.calls.length
  const changed = Automerge.change(Automerge.clone(doc), draft => { draft.ownerPersonId = "untrusted owner" })
  decision.mockReturnValue("visitor")
  await expect(decideAccess(changed, evidence)).resolves.toBe("visitor")
  expect(decision).toHaveBeenCalledTimes(calls + 1)
})
