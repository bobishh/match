import { describe, expect, it } from "vitest"
import { userMessage, useDeviceSync } from "./useDeviceSync"

describe("device sync errors", () => {
  it("Given a CRDT merge failure, when pairing reports it, then the UI does not blame the QR code", () => {
    expect(userMessage(new RangeError("Attempting to change an outdated document"), "Generate a new QR and try again.")).toBe(
      "Couldn’t merge workspace changes. Keep this tab open and try pairing again.",
    )
  })

  it("Given a malformed pairing link, when parsing fails, then the UI identifies the link", () => {
    expect(userMessage(new Error("Invalid pairing link"), "Generate a new QR and try again.")).toBe("This pairing link is invalid.")
  })
})

describe("useDeviceSync direct sync selection and custom workspace sets", () => {
  it("opens workspace selection directly with active workspace preselected without starting transport node", () => {
    let transportStarted = false
    const mockTransport = {
      start: async () => {
        transportStarted = true
        throw new Error("Should not start node on open")
      },
    }
    const availableWorkspaces = [
      { id: "ws_1", title: "Job search" },
      { id: "ws_2", title: "Reading list" },
    ]
    const sync = useDeviceSync({
      workspace: { getBytes: () => new Uint8Array(), mergeBytes: async () => {} },
      origin: () => "http://localhost:3000",
      transport: mockTransport as any,
      availableWorkspaces: { value: availableWorkspaces } as any,
      activeWorkspaceId: () => "ws_1",
    })

    sync.open()
    expect(sync.isOpen.value).toBe(true)
    expect(sync.step.value).toBe("workspace-select")
    expect(sync.selectedWorkspaceIds.value).toEqual(["ws_1"])
    expect(transportStarted).toBe(false)
  })

  it("handles empty workspace selection disabling generation", async () => {
    const sync = useDeviceSync({
      workspace: { getBytes: () => new Uint8Array(), mergeBytes: async () => {} },
      origin: () => "http://localhost:3000",
      availableWorkspaces: { value: [{ id: "ws_1", title: "Job search" }] } as any,
      activeWorkspaceId: () => "ws_1",
    })

    sync.open()
    sync.selectedWorkspaceIds.value = []
    await sync.generateWorkspaceInvite()
    // Generation must fail or be disabled when selection is empty
    expect(sync.step.value).toBe("workspace-select")
    expect(sync.inviteUrl.value).toBe("")
  })

  it("Given an editor, when they generate an invite, rejects before starting a network node", async () => {
    let transportStarted = false
    const sync = useDeviceSync({
      workspace: { getBytes: () => new Uint8Array(), mergeBytes: async () => {} },
      origin: () => "http://localhost:3000",
      transport: { start: async () => { transportStarted = true; throw new Error("must not start") } } as any,
      availableWorkspaces: { value: [{ id: "ws_1", title: "Shared" }] } as any,
      activeWorkspaceId: () => "ws_1",
      workspaceOwner: async () => "another-person",
    })

    sync.open()
    await sync.generateWorkspaceInvite()

    expect(transportStarted).toBe(false)
    expect(sync.step.value).toBe("error")
    expect(sync.error.value).toBe("Only the workspace owner can invite peers to Shared")
  })

  it("handles expired invitation by setting error state and preventing connection", async () => {
    const sync = useDeviceSync({
      workspace: { getBytes: () => new Uint8Array(), mergeBytes: async () => {} },
      origin: () => "http://localhost:3000",
    })

    const expiredUrl = "http://localhost:3000/pair#v=1&kind=workspace-join&invitationId=exp1&issuerPersonId=p1&issuerDeviceId=d1&issuerPublicKey=pk1&endpoint=ep1&createdAt=2020-01-01T00:00:00.000Z&expiresAt=2020-01-01T00:10:00.000Z&secret=sec1&workspaceId=ws1&workspaceTitle=WS&role=editor"
    await sync.prepareJoin(expiredUrl)

    expect(sync.step.value).toBe("error")
    expect(sync.error.value).toMatch(/This invitation has expired/i)
  })
})
