import { beforeEach, describe, expect, it } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createWorkspaceGrant, ProofStore } from "../domain/proofs"
import type { getKeeperIntegrationStatus, KeeperPairing } from "./lighthousePairing"
import type { KeeperIntegrationStatus } from "./keeperIntegrationStatus"
import type { PendingKeeperWithdrawal } from "./ownerKeeper"
import { orphanStatusProvesCleanup, savedGrantEpoch, verifiedGrantEpochs } from "./keeperOrphanResolution"

const pairing = { pairingId: "pairing", integrationId: "integration", expectedIntegrationRevision: 7,
  discovery: { personId: "rusty" }, workspaces: [{ id: "board" }] } as KeeperPairing
const saved = { pairingId: "pairing", operationId: "operation", pairing: {}, grantScopes: [] } as PendingKeeperWithdrawal
const cleanIntegration: KeeperIntegrationStatus = { integrationId: "integration", revision: 8, futureBoards: false,
  scopes: [], tombstones: [] }
const status = (integration: KeeperIntegrationStatus = cleanIntegration) =>
  ({ revision: 8, integrations: [integration] } as unknown as Awaited<ReturnType<typeof getKeeperIntegrationStatus>>)

describe("keeper orphan status reconciliation", () => {
  beforeEach(() => resetIdentityStorageForTest())
  it("accepts exact clean status for a pairing with no saved issued grants", () => {
    expect(orphanStatusProvesCleanup(pairing, saved, status(), new Map())).toBe(true)
  })

  it("requires signed tombstone at or beyond every explicit locally saved epoch", () => {
    const grantEpochs = new Map([["board", 5]])
    expect(orphanStatusProvesCleanup(pairing, saved, status({ ...cleanIntegration, tombstones: [
      { workspaceId: "board", grantEpoch: 5, state: "removed" as const, cleanup: "complete" as const, operationId: "cleanup" },
    ] }), grantEpochs)).toBe(true)
    expect(orphanStatusProvesCleanup(pairing, saved, status({ ...cleanIntegration, tombstones: [
      { workspaceId: "board", grantEpoch: 4, state: "removed" as const, cleanup: "complete" as const, operationId: "cleanup" },
    ] }), grantEpochs)).toBe(false)
    expect(orphanStatusProvesCleanup(pairing, saved, status(), grantEpochs)).toBe(false)
  })

  it("keeps ambiguous identity, stale revision, active scope, pending operation, and unlinked tombstone blocked", () => {
    const pending = { operationId: "another-op", requestHash: "hash", expectedRevision: 7,
      scopes: [{ workspaceId: "board", expectedGrantEpoch: 5 }], status: "pending" as const }
    const cases = [
      { ...cleanIntegration, integrationId: "other-integration" },
      { ...cleanIntegration, revision: 6 },
      { ...cleanIntegration, scopes: [{ workspaceId: "board", grantEpoch: 5, state: "active" as const, activationOperationId: "op" }] },
      { ...cleanIntegration, pendingOperation: pending },
      { ...cleanIntegration, tombstones: [{ workspaceId: "board", grantEpoch: 5, state: "removed" as const, cleanup: "complete" as const, operationId: "unknown" }] },
    ]
    for (const candidate of cases) expect(orphanStatusProvesCleanup(pairing, saved, status(candidate), new Map())).toBe(false)
    expect(orphanStatusProvesCleanup(pairing, { ...saved, grantScopes: undefined }, status(), new Map())).toBe(false)
  })

  it("rejects missing or mismatched signed owner grant fields instead of defaulting epoch", () => {
    const grant = { signerKeyId: "owner-device", payload: { kind: "workspace-grant", version: 1,
      grantId: "grant", workspaceId: "board", personId: "rusty", role: "editor", accessEpoch: 5 } }
    expect(savedGrantEpoch(grant, "board", "rusty")).toBe(5)
    expect(savedGrantEpoch({ ...grant, payload: { ...grant.payload, accessEpoch: undefined } }, "board", "rusty")).toBeUndefined()
    expect(savedGrantEpoch(grant, "board", "another-service")).toBeUndefined()
    expect(savedGrantEpoch({ ...grant, payload: { ...grant.payload, role: "visitor" } }, "board", "rusty")).toBeUndefined()
  })

  it("requires grant signature and device certificate chain from the exact owner", async () => {
    const owner = await bootstrapIdentity("Owner")
    const grant = await createWorkspaceGrant(owner, "board", "rusty", "editor", 5)
    const proof = { ...saved, grantScopes: [{ workspaceId: "board", document: "doc",
      authorizationBundle: {}, grant }] } as PendingKeeperWithdrawal
    const store = new ProofStore(false)
    const certificates = await store.listCertificates()
    const verify = (savedProof: PendingKeeperWithdrawal, certificate = owner.certificate) =>
      verifiedGrantEpochs(pairing, savedProof, owner.identity.publicKey, owner.identity.personId, certificate, certificates)

    expect(await verify(proof)).toEqual(new Map([["board", 5]]))
    expect(await verify({ ...proof, grantScopes: [{ ...proof.grantScopes![0],
      grant: { ...grant, signature: "invalid" } }] })).toBeUndefined()
    resetIdentityStorageForTest()
    const otherOwner = await bootstrapIdentity("Other owner")
    expect(await verify(proof, otherOwner.certificate)).toBeUndefined()
  })
})
