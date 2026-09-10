import { beforeAll, describe, expect, it, beforeEach, vi } from "vitest"
import { readFile } from "node:fs/promises"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "../crdt"
import {
  bootstrapIdentity,
  resetIdentityStorageForTest,
} from "./identity"
import { createWorkspaceDoc } from "./seeds"
import { projectDocumentHistory, projectEntityHistory } from "./history"
import type { WorkspaceDocumentV2 } from "./model"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

describe("Native history projection and attribution (Task 2.4)", () => {
  beforeEach(() => {
    resetIdentityStorageForTest()
  })

  it("projects history from document changes with author attribution", async () => {
    const profile = await bootstrapIdentity("Alice")
    const rawWs = createWorkspaceDoc("ws_hist", "History Board", profile.identity.personId, "blank")
    let doc = Automerge.from<WorkspaceDocumentV2>(rawWs)

    const meta = {
      version: 1,
      transactionId: "tx_1",
      action: "createTask",
      entityIds: ["task_abc"],
      personId: profile.identity.personId,
      deviceId: profile.device.deviceId,
    }

    doc = Automerge.change(doc, { message: JSON.stringify(meta) }, (draft) => {
      draft.title = "History Board Modified"
    })

    const history = projectDocumentHistory(doc)
    expect(history.length).toBeGreaterThan(0)
    const lastEntry = history[history.length - 1]
    expect(lastEntry.action).toBe("createTask")
    expect(lastEntry.personId).toBe(profile.identity.personId)
    expect(lastEntry.deviceId).toBe(profile.device.deviceId)
    expect(lastEntry.isLegacy).toBe(false)
  })

  it("labels changes without metadata as Legacy / imported", async () => {
    let doc = Automerge.init<any>()
    doc = Automerge.change(doc, { message: "Old legacy commit without JSON metadata" }, (draft) => {
      draft.something = 123
    })

    const history = projectDocumentHistory(doc)
    expect(history.length).toBe(1)
    expect(history[0].isLegacy).toBe(true)
    expect(history[0].authorLabel).toBe("Legacy / imported")
  })

  it("filters history for a specific entity ID", async () => {
    const profile = await bootstrapIdentity("Alice")
    const rawWs = createWorkspaceDoc("ws_filter", "Filter Board", profile.identity.personId, "blank")
    let doc = Automerge.from<WorkspaceDocumentV2>(rawWs)

    const metaTask1 = {
      version: 1,
      transactionId: "tx_1",
      action: "createTask",
      entityIds: ["task_1"],
      personId: profile.identity.personId,
      deviceId: profile.device.deviceId,
    }
    doc = Automerge.change(doc, { message: JSON.stringify(metaTask1) }, (draft) => {
      draft.title = "T1 Edit"
    })

    const metaTask2 = {
      version: 1,
      transactionId: "tx_2",
      action: "createTask",
      entityIds: ["task_2"],
      personId: profile.identity.personId,
      deviceId: profile.device.deviceId,
    }
    doc = Automerge.change(doc, { message: JSON.stringify(metaTask2) }, (draft) => {
      draft.title = "T2 Edit"
    })

    const task1History = projectEntityHistory(doc, "task_1")
    expect(task1History).toHaveLength(1)
    expect(task1History[0].entityIds).toContain("task_1")

    const task2History = projectEntityHistory(doc, "task_2")
    expect(task2History).toHaveLength(1)
    expect(task2History[0].entityIds).toContain("task_2")
  })
})

  it("preserves A/J author attribution when changes are relayed through peer K", async () => {
    const profileA = await bootstrapIdentity("Alice")
    const rawWs = createWorkspaceDoc("ws_relay", "Relay Board", profileA.identity.personId, "blank")
    let docA = Automerge.from<WorkspaceDocumentV2>(rawWs)

    // Alice on Device J makes a change
    const metaAlice = {
      version: 1,
      transactionId: "tx_alice_1",
      action: "createTask",
      entityIds: ["task_relay"],
      personId: profileA.identity.personId,
      deviceId: profileA.device.deviceId,
    }
    docA = Automerge.change(docA, { message: JSON.stringify(metaAlice) }, (draft) => {
      draft.title = "Relay Board - Alice Edit"
    })

    // Peer K receives and merges docA
    const profileK = await bootstrapIdentity("Kevin")
    let docK = Automerge.init<WorkspaceDocumentV2>()
    docK = Automerge.merge(docK, docA)

    // Project history on K
    const kHistory = projectEntityHistory(docK, "task_relay")
    expect(kHistory).toHaveLength(1)
    expect(kHistory[0].personId).toBe(profileA.identity.personId)
    expect(kHistory[0].deviceId).toBe(profileA.device.deviceId)
    expect(kHistory[0].isLegacy).toBe(false)
  })

  it("ensures timestamps never decide CRDT conflicts", () => {
    // Automerge conflict resolution is deterministic based on actor IDs and vector clocks, never wall clocks
    let doc1 = Automerge.from<{ text: string }>({ text: "initial" })
    let doc2 = Automerge.clone(doc1)

    // doc1 change has a future timestamp
    doc1 = Automerge.change(doc1, { time: 9999999999 }, (d) => {
      d.text = "doc1 text"
    })
    // doc2 change has an older timestamp
    doc2 = Automerge.change(doc2, { time: 1000 }, (d) => {
      d.text = "doc2 text"
    })

    const merged1 = Automerge.merge(Automerge.clone(doc1), doc2)
    const merged2 = Automerge.merge(Automerge.clone(doc2), doc1)

    // Convergence holds regardless of time
    expect(merged1.text).toBe(merged2.text)
  })
