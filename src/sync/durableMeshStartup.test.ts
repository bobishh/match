import { describe, expect, it } from "vitest"
import { DurableMesh } from "./durableMesh"

describe("durable mesh transport demand", () => {
  it.each([
    { label: "local-only owner", peers: [], adopted: false, expected: false },
    { label: "own device route", peers: [{ workspaceId: "board", deviceId: "local" }], adopted: false, expected: false },
    { label: "known remote peer", peers: [{ workspaceId: "board", deviceId: "remote" }], adopted: false, expected: true },
    { label: "unrelated peer", peers: [{ workspaceId: "other", deviceId: "remote" }], adopted: false, expected: false },
    { label: "pairing handoff", peers: [], adopted: true, expected: true },
  ])("Given $label, when startup checks network demand, then transport demand is $expected", async ({ peers, adopted, expected }) => {
    const mesh = new DurableMesh({
      transport: {} as never, workspace: {} as never, workspaceStore: {} as never,
      getProfile: async () => ({ device: { deviceId: "local" } }) as never,
      store: { listWorkspaceCredentials: async () => [{ workspaceId: "board" }], listPeers: async () => peers } as never,
    })
    const internal = mesh as unknown as { adoptedNode?: unknown; canStartRuntime(): Promise<boolean> }
    if (adopted) internal.adoptedNode = {}
    expect(await internal.canStartRuntime()).toBe(expected)
  })
})
