import { createApp, h, ref } from "vue"
import KeeperDiscovery from "../../src/components/KeeperDiscovery.vue"

export async function mountKeeperRemoval(options: {
  legacyWithoutServiceDescriptor?: boolean
  legacyRevokeFails?: boolean
  legacyMissingBoardList?: boolean
  reopenPersistedLegacyPending?: boolean
  completedRemovalZombie?: boolean
  zombieRevokeFails?: boolean
  canonicalService?: { origin: string; personId: string; deviceId: string; publicKey: string; certificates: unknown[] }
  verifiedService?: { origin: string; personId: string; deviceId: string; publicKey: string; certificates: unknown[] }
} = {}) {
  const profile = await (await import("../../src/domain/identity")).bootstrapIdentity()
  const service = options.canonicalService ?? options.verifiedService
  const keeperPersonId = service?.personId ?? "old-keeper"
  const keeperDeviceId = service?.deviceId ?? "old-device"
  const { ownerKeepers, saveKeeperIntegrationReference, saveOwnerKeeper } = await import("../../src/sync/ownerKeeper")
  const { defaultStorage } = await import("../../src/storage")
  const { initializePersonalRootCatalog } = await import("../../src/statePersonalRoot")
  if (!options.reopenPersistedLegacyPending) await initializePersonalRootCatalog(defaultStorage, profile)
  if (!options.reopenPersistedLegacyPending) await saveKeeperIntegrationReference({
    integrationId: "integration-old",
    serviceOrigin: service?.origin ?? "https://rusty.example",
    servicePersonId: keeperPersonId,
    serviceDeviceId: keeperDeviceId,
    servicePublicKey: service?.publicKey ?? "verified-test-key",
    serviceCertificates: service?.certificates ?? [],
    workspaceIds: options.completedRemovalZombie ? [] : ["board"],
    scopeReceipts: options.completedRemovalZombie ? [] : [{ workspaceId: "board", grantEpoch: 1, activationOperationId: "activation-test" }],
    futureBoards: false,
    futureBoardBaselineIds: ["board"],
    revision: options.completedRemovalZombie ? 2 : 1,
    state: options.completedRemovalZombie ? "removed" : "active",
    verifiedAt: new Date().toISOString(),
    ...(options.completedRemovalZombie ? { completedRemoval: {
      operationId: "prior-removal", scopes: [{ workspaceId: "board", grantEpoch: 1 }],
    } } : {}),
  })
  if (options.legacyWithoutServiceDescriptor && !options.reopenPersistedLegacyPending) {
    const rootDocument = await defaultStorage.loadPersonalRoot()
    if (rootDocument?.keeperIntegrations) {
      delete rootDocument.keeperIntegrations["integration-old"]
      await defaultStorage.savePersonalRoot(rootDocument)
    }
  }
  if (!options.reopenPersistedLegacyPending && !options.completedRemovalZombie) {
    await saveOwnerKeeper(profile.identity.personId, {
      personId: keeperPersonId,
      role: "editor",
      ...(service ? { details: {
        origin: service.origin, boardIds: ["board"], futureBoards: false, futureBoardBaselineIds: ["board"],
        integrationId: "integration-old", servicePersonId: keeperPersonId, serviceDeviceId: keeperDeviceId,
        servicePublicKey: service.publicKey, serviceCertificates: service.certificates, revision: 1,
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
  const zombiePeers = ref(options.completedRemovalZombie ? [{ workspaceId: "board", personId: keeperPersonId,
    deviceId: "board-peer-device", role: "editor" as const, endpoint: "board-peer-endpoint", online: false,
    lastSeen: new Date(0).toISOString(), revokedAt: null as string | null,
    grantEpoch: 3, priorRevocationEpoch: 2 }] : [])
  const removeKeeper = (_personId: string, _discovery?: unknown, knownServiceDeviceIds?: string[]) => {
    removalAttempts += 1
    if (options.canonicalService) {
      return import("../../src/sync/deviceSyncKeeper").then(({ removeKeeperAccess }) => removeKeeperAccess(keeperPersonId, {
        getProfile: async () => profile,
        workspaces: [{ id: "board" }],
        workspaceOwner: async () => profile.identity.personId,
        mesh: async () => ({
          views: async () => zombiePeers.value,
          revokePerson: async (workspaceId: string, targetPersonId: string) => {
            if (options.zombieRevokeFails) throw new Error("Local board revocation failed")
            revokedScopes.push(workspaceId)
            zombiePeers.value = zombiePeers.value.map(peer => peer.personId === targetPersonId && peer.workspaceId === workspaceId
              ? { ...peer, revokedAt: new Date().toISOString() } : peer)
          },
        }) as never,
        knownServiceDeviceIds,
      }).then(result => {
        if (result === "removed") keepers.value = options.completedRemovalZombie
          ? zombiePeers.value.filter(peer => !peer.revokedAt).map(() => ({ ...keepers.value[0]! })) : []
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
    allowZombieRetry: () => { options.zombieRevokeFails = false },
    revokedScopes: () => revokedScopes,
    peerProjection: () => zombiePeers.value,
    legacyPending: async () => (await ownerKeepers(profile.identity.personId)).find(record => record.personId === keeperPersonId)?.details,
  } })
}
