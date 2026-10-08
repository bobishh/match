import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  ownerKeepers: vi.fn(),
  keeperIntegrationReferences: vi.fn(),
}))

vi.mock("./ownerKeeper", () => ({
  ownerKeepers: mocks.ownerKeepers,
  keeperIntegrationReferences: mocks.keeperIntegrationReferences,
  mayOfferFutureKeeperWorkspace: vi.fn(),
  saveOwnerKeeper: vi.fn(),
}))

import { ownerKeeperOfferPolicy } from "./durableMeshCredentials"
import type { KeeperIntegrationReference } from "../domain/model"
import type { LocalProfile } from "../domain/identity"

const profile = { identity: { personId: "owner" } } as LocalProfile

function reference(integrationId: string, revision: number, state: KeeperIntegrationReference["state"], extra: Partial<KeeperIntegrationReference> = {}): KeeperIntegrationReference {
  return {
    integrationId, serviceOrigin: "https://rusty.example", servicePersonId: "keeper", serviceDeviceId: "device",
    servicePublicKey: "key", serviceCertificates: [], workspaceIds: [integrationId], futureBoards: false,
    revision, state, verifiedAt: "2026-10-08T00:00:00.000Z", ...extra,
  }
}

describe("owner keeper offer policy", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.ownerKeepers.mockResolvedValue([{ personId: "keeper", role: "editor" }])
    mocks.keeperIntegrationReferences.mockResolvedValue({ integrations: {} })
  })

  it("uses the single live integration despite a removed legacy reference with a larger revision", async () => {
    mocks.keeperIntegrationReferences.mockResolvedValue({ integrations: {
      removedLegacy: reference("removedLegacy", 99, "removed"),
      activeCanonical: reference("activeCanonical", 2, "active"),
    } })

    const result = await ownerKeeperOfferPolicy(profile, "keeper")

    expect(result).toMatchObject({ allowed: true, keeper: { details: { integrationId: "activeCanonical", boardIds: ["activeCanonical"] } } })
  })

  it("fails closed when multiple live integration references share one service identity", async () => {
    mocks.keeperIntegrationReferences.mockResolvedValue({ integrations: {
      first: reference("first", 2, "active"),
      second: reference("second", 1, "active"),
    } })

    await expect(ownerKeeperOfferPolicy(profile, "keeper")).resolves.toEqual({ allowed: false })
  })

  it("does not fall back to cached owner policy when every durable reference is removed", async () => {
    mocks.keeperIntegrationReferences.mockResolvedValue({ integrations: {
      removed: reference("removed", 99, "removed"),
    } })

    await expect(ownerKeeperOfferPolicy(profile, "keeper")).resolves.toEqual({ allowed: false })
  })

  it("blocks new grants while a settings operation has unresolved policy", async () => {
    mocks.keeperIntegrationReferences.mockResolvedValue({ integrations: {
      active: reference("active", 2, "active", { pendingSettings: {
        operationId: "settings-op", expectedRevision: 2, futureBoards: false, scopes: [],
      } }),
    } })

    await expect(ownerKeeperOfferPolicy(profile, "keeper")).resolves.toEqual({ allowed: false })
  })

  it("preserves legacy cache behavior when no durable integration reference exists", async () => {
    await expect(ownerKeeperOfferPolicy(profile, "keeper")).resolves.toMatchObject({ allowed: true, keeper: { role: "editor" } })
  })
})
