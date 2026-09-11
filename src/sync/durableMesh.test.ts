import { describe, expect, it, vi } from "vitest"
import { DurableMesh } from "./durableMesh"

describe("DurableMesh peer catalog gossip", () => {
  it("Given one invalid peer record, when a catalog merges, then later valid peers still import", async () => {
    const credential = { workspaceId: "workspace-1" }
    const mesh = new DurableMesh({
      transport: {} as never,
      workspaceStore: {} as never,
      workspace: {} as never,
      getProfile: async () => ({} as never),
      store: { getWorkspaceCredential: async () => credential } as never,
    })
    const imported: string[] = []
    const internal = mesh as any
    internal.mergeOwnershipTransfers = async () => credential
    internal.mergeRevocations = async () => {}
    internal.putVerifiedBundle = vi.fn(async (_credential: unknown, bundle: { id: string }) => {
      if (bundle.id === "poisoned") throw new Error("Invalid workspace grant signature")
      imported.push(bundle.id)
    })
    internal.notify = async () => {}

    await mesh.mergeWorkspace("workspace-1", {
      version: 1,
      peers: [{ id: "poisoned" }, { id: "owner-phone" }],
      revocations: [],
    })

    expect(imported).toEqual(["owner-phone"])
    await mesh.dispose()
  })
})
