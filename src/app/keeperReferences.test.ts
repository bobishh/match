import { afterEach, describe, expect, it, vi } from "vitest"
import type { KeeperIntegrationReference } from "../domain/model"
import type { KeeperIntegrationStatus } from "../sync/keeperPairing"
import { keeperApi } from "./keeperApi"
import { keeperIntegrationAvailability } from "./keeperIntegrationAvailability"
import { loadKeeperReferenceViews } from "./keeperReferences"

const reference: KeeperIntegrationReference = {
  integrationId: "integration-a",
  serviceOrigin: "https://rusty.example",
  servicePersonId: "rusty-person",
  serviceDeviceId: "rusty-device",
  servicePublicKey: "pinned-public-key",
  serviceCertificates: [],
  workspaceIds: ["board-a"],
  scopeReceipts: [{ workspaceId: "board-a", grantEpoch: 5, activationOperationId: "activate-a" }],
  futureBoards: true,
  futureBoardBaselineIds: ["board-a"],
  revision: 7,
  state: "active",
  verifiedAt: "2026-10-08T00:00:00.000Z",
}

function signedIntegration(overrides: Partial<KeeperIntegrationStatus> = {}): KeeperIntegrationStatus {
  return {
    integrationId: reference.integrationId,
    revision: reference.revision,
    futureBoards: reference.futureBoards,
    baselineWorkspaceIds: reference.futureBoardBaselineIds,
    scopes: [{ workspaceId: "board-a", grantEpoch: 5, activationOperationId: "activate-a", state: "active" }],
    tombstones: [],
    ...overrides,
  }
}

function status(integration: KeeperIntegrationStatus) {
  return {
    integrations: [integration], integrationSettingsSupported: true,
    signerKeyId: "rusty-device", signature: "verified-by-probe", revision: integration.revision,
    signedStatus: { payload: {}, signerKeyId: "rusty-device", signature: "verified-by-probe" },
  }
}

afterEach(() => vi.restoreAllMocks())

describe("keeper integration availability", () => {
  it("marks service available only when fresh signed integration matches saved scope and policy", async () => {
    const probe = vi.fn(async () => status(signedIntegration()))

    await expect(keeperIntegrationAvailability(reference, probe)).resolves.toEqual({ state: "available" })
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({
      origin: reference.serviceOrigin,
      personId: reference.servicePersonId,
      deviceId: reference.serviceDeviceId,
      publicKey: reference.servicePublicKey,
      certificates: reference.serviceCertificates,
    }))
  })

  it.each([
    ["revision", { revision: 8 }],
    ["scope epoch", { scopes: [{ workspaceId: "board-a", grantEpoch: 6, activationOperationId: "activate-a", state: "active" as const }] }],
    ["scope set", { scopes: [] }],
    ["policy", { futureBoards: false }],
    ["pending operation", { pendingOperation: { operationId: "pending", requestHash: "hash", expectedRevision: 7,
      scopes: [{ workspaceId: "board-a", expectedGrantEpoch: 5 }], status: "pending" as const } }],
  ])("needs review when signed %s differs from saved integration", async (_name, overrides) => {
    await expect(keeperIntegrationAvailability(reference, async () => status(signedIntegration(overrides))))
      .resolves.toMatchObject({ state: "needs-review" })
  })

  it("distinguishes transport failure from invalid or missing signed state", async () => {
    await expect(keeperIntegrationAvailability(reference, async () => { throw new TypeError("fetch failed") }))
      .resolves.toMatchObject({ state: "unavailable" })
    await expect(keeperIntegrationAvailability(reference, async () => { throw new Error("signature invalid") }))
      .resolves.toMatchObject({ state: "needs-review" })
    await expect(keeperIntegrationAvailability(reference, async () => ({ ...status(signedIntegration()), integrations: [] })))
      .resolves.toMatchObject({ state: "needs-review" })
  })

  it("returns saved integration immediately, then reports HTTP/native availability separately", async () => {
    vi.spyOn(keeperApi, "activeIntegrationReferences").mockResolvedValue([reference])
    vi.spyOn(keeperApi, "pendingRemovalReferences").mockResolvedValue([])
    let finishProbe: ((value: ReturnType<typeof status>) => void) | undefined
    const probe = vi.fn(() => new Promise<ReturnType<typeof status>>(resolve => { finishProbe = resolve }))
    const onAvailability = vi.fn()

    const views = await loadKeeperReferenceViews(onAvailability, probe)

    expect(views.saved).toMatchObject([{
      personId: reference.servicePersonId,
      integrationId: reference.integrationId,
      integrationRevision: reference.revision,
      online: false,
      reconnecting: false,
      integrationAvailability: "unknown",
      integrationBoardIds: ["board-a"],
    }])
    expect(probe).toHaveBeenCalledOnce()
    expect(onAvailability).not.toHaveBeenCalled()
    finishProbe?.(status(signedIntegration()))
    await vi.waitFor(() => expect(onAvailability).toHaveBeenCalledWith(reference.servicePersonId, reference.integrationId,
      reference.revision,
      { state: "available" }))
  })

  it("marks multiple active integrations for one keeper for review without probing either as authoritative", async () => {
    const other = { ...reference, integrationId: "integration-b", revision: 8, workspaceIds: ["board-b"] }
    vi.spyOn(keeperApi, "activeIntegrationReferences").mockResolvedValue([reference, other])
    vi.spyOn(keeperApi, "pendingRemovalReferences").mockResolvedValue([])
    const probe = vi.fn(async () => status(signedIntegration()))
    const onAvailability = vi.fn()

    const views = await loadKeeperReferenceViews(onAvailability, probe)

    expect(views.saved).toMatchObject([{
      personId: reference.servicePersonId,
      integrationAvailability: "needs-review",
      integrationAvailabilityReason: "Multiple saved Rusty integrations need review.",
      integrationBoardIds: ["board-a", "board-b"],
    }])
    expect(probe).not.toHaveBeenCalled()
    expect(onAvailability).not.toHaveBeenCalled()
  })

  it("delivers each availability result without waiting for slower service probes", async () => {
    const other: KeeperIntegrationReference = {
      ...reference, integrationId: "integration-b", servicePersonId: "rusty-person-b", revision: 8,
      workspaceIds: ["board-b"], scopeReceipts: [{ workspaceId: "board-b", grantEpoch: 9, activationOperationId: "activate-b" }],
      futureBoardBaselineIds: ["board-b"],
    }
    vi.spyOn(keeperApi, "activeIntegrationReferences").mockResolvedValue([reference, other])
    vi.spyOn(keeperApi, "pendingRemovalReferences").mockResolvedValue([])
    let finishSlow: ((value: ReturnType<typeof status>) => void) | undefined
    const probe = vi.fn((discovery: { personId: string }) => discovery.personId === reference.servicePersonId
      ? new Promise<ReturnType<typeof status>>(resolve => { finishSlow = resolve })
      : Promise.resolve(status({ ...signedIntegration(), integrationId: other.integrationId, revision: other.revision,
        scopes: [{ workspaceId: "board-b", grantEpoch: 9, activationOperationId: "activate-b", state: "active" }],
        baselineWorkspaceIds: ["board-b"] })))
    const onAvailability = vi.fn()

    const views = await loadKeeperReferenceViews(onAvailability, probe)

    expect(views.saved).toHaveLength(2)
    await vi.waitFor(() => expect(onAvailability).toHaveBeenCalledWith(other.servicePersonId, other.integrationId,
      other.revision, { state: "available" }))
    expect(onAvailability).not.toHaveBeenCalledWith(reference.servicePersonId, reference.integrationId,
      reference.revision, expect.anything())
    finishSlow?.(status(signedIntegration()))
    await vi.waitFor(() => expect(onAvailability).toHaveBeenCalledWith(reference.servicePersonId, reference.integrationId,
      reference.revision, { state: "available" }))
  })
})
