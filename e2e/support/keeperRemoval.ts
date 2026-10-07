import { createApp, h, ref } from "vue"
import KeeperDiscovery from "../../src/components/KeeperDiscovery.vue"

export async function mountKeeperRemoval(options: {
  legacyWithoutServiceDescriptor?: boolean
  legacyRevokeFails?: boolean
  legacyMissingBoardList?: boolean
  reopenPersistedLegacyPending?: boolean
  canonicalService?: { origin: string; personId: string; deviceId: string; publicKey: string; certificates: unknown[] }
} = {}) {
  const profile = await (await import("../../src/domain/identity")).bootstrapIdentity()
  const keeperPersonId = options.canonicalService?.personId ?? "old-keeper"
  const keeperDeviceId = options.canonicalService?.deviceId ?? "old-device"
  const { ownerKeepers, saveKeeperIntegrationReference, saveOwnerKeeper } = await import("../../src/sync/ownerKeeper")
  const { defaultStorage } = await import("../../src/storage")
  const { initializePersonalRootCatalog } = await import("../../src/statePersonalRoot")
  if (!options.reopenPersistedLegacyPending) await initializePersonalRootCatalog(defaultStorage, profile)
  if (!options.reopenPersistedLegacyPending) await saveKeeperIntegrationReference({
    integrationId: "integration-old",
    serviceOrigin: options.canonicalService?.origin ?? "https://rusty.example",
    servicePersonId: keeperPersonId,
    serviceDeviceId: keeperDeviceId,
    servicePublicKey: options.canonicalService?.publicKey ?? "verified-test-key",
    serviceCertificates: options.canonicalService?.certificates ?? [],
    workspaceIds: ["board"],
    scopeReceipts: [{ workspaceId: "board", grantEpoch: 1, activationOperationId: "activation-test" }],
    futureBoards: false,
    futureBoardBaselineIds: ["board"],
    revision: 1,
    state: "active",
    verifiedAt: new Date().toISOString(),
  })
  if (options.legacyWithoutServiceDescriptor && !options.reopenPersistedLegacyPending) {
    const rootDocument = await defaultStorage.loadPersonalRoot()
    if (rootDocument?.keeperIntegrations) {
      delete rootDocument.keeperIntegrations["integration-old"]
      await defaultStorage.savePersonalRoot(rootDocument)
    }
  }
  if (!options.reopenPersistedLegacyPending) {
    await saveOwnerKeeper(profile.identity.personId, {
      personId: keeperPersonId,
      role: "editor",
      ...(options.canonicalService ? { details: {
        origin: options.canonicalService.origin, boardIds: ["board"], futureBoards: false, futureBoardBaselineIds: ["board"],
        integrationId: "integration-old", servicePersonId: keeperPersonId, serviceDeviceId: keeperDeviceId,
        servicePublicKey: options.canonicalService.publicKey, serviceCertificates: options.canonicalService.certificates, revision: 1,
      } } : options.legacyWithoutServiceDescriptor && !options.legacyMissingBoardList ? { details: { boardIds: ["board"], futureBoards: false } } : {}),
    })
  }
  const root = document.createElement("div")
  document.body.appendChild(root)
  const keepers = ref([{ personId: keeperPersonId, name: "Old Lighthouse", role: "visitor" as const, self: false,
    online: false, reconnecting: false, onlineDevices: 0, devices: 1,
    deviceList: [{ deviceId: keeperDeviceId, name: "Old worker", userAgent: "mesh-lighthouse/0.1.0",
      description: "Lighthouse", online: false, reconnecting: false, tabs: 1, lastSeen: "2026-09-25T12:00:00Z" }],
  }])
  let attempt: { complete(): void; fail(): void } | undefined
  let removalAttempts = 0
  const revokedScopes: string[] = []
  const removeKeeper = (_personId: string, _discovery?: unknown, knownServiceDeviceIds?: string[]) => {
    removalAttempts += 1
    if (options.canonicalService) {
      return import("../../src/sync/deviceSyncKeeper").then(({ removeKeeperAccess }) => removeKeeperAccess(keeperPersonId, {
        getProfile: async () => profile,
        workspaces: [{ id: "board" }],
        workspaceOwner: async () => profile.identity.personId,
        mesh: async () => ({ revokePerson: async () => {} }) as never,
        knownServiceDeviceIds,
      }).then(result => {
        if (result === "removed") keepers.value = []
        return result
      }))
    }
    if (options.legacyWithoutServiceDescriptor) {
      return import("../../src/sync/deviceSyncKeeper").then(({ removeKeeperAccess }) => removeKeeperAccess("old-keeper", {
        getProfile: async () => profile,
        workspaces: [{ id: "board" }],
        workspaceOwner: async () => profile.identity.personId,
        mesh: async () => ({ revokePerson: async (workspaceId: string) => {
          if (options.legacyRevokeFails) throw new Error("Local board revocation failed")
          revokedScopes.push(workspaceId)
        } }) as never,
        knownServiceDeviceIds,
      }).then(result => {
        if (result === "removed") keepers.value = []
        return result
      }))
    }
    return new Promise<"removed">((resolve, reject) => {
      attempt = {
      complete: () => { keepers.value = []; resolve("removed") },
      fail: () => reject(new Error("Could not revoke keeper")),
    }
    })
  }
  createApp({ setup: () => () => h(KeeperDiscovery, { ownedWorkspaces: [{ id: "board", title: "Board" }], keepers: keepers.value,
    provisionKeeper: async () => "active" as const, removeKeeper }) }).mount(root)
  Object.assign(window, { keeperRemoval: {
    complete: () => attempt?.complete(),
    fail: () => attempt?.fail(),
    attempts: () => removalAttempts,
    revokedScopes: () => revokedScopes,
    legacyPending: async () => (await ownerKeepers(profile.identity.personId)).find(record => record.personId === keeperPersonId)?.details,
  } })
}
