import { createApp, h, ref } from "vue"
import KeeperDiscovery from "../../src/components/KeeperDiscovery.vue"

export async function mountKeeperRemoval() {
  const profile = await (await import("../../src/domain/identity")).bootstrapIdentity()
  const { saveKeeperIntegrationReference, saveOwnerKeeper } = await import("../../src/sync/ownerKeeper")
  const { defaultStorage } = await import("../../src/storage")
  const { initializePersonalRootCatalog } = await import("../../src/statePersonalRoot")
  await initializePersonalRootCatalog(defaultStorage, profile)
  await saveKeeperIntegrationReference({
    integrationId: "integration-old",
    serviceOrigin: "https://rusty.example",
    servicePersonId: "old-keeper",
    serviceDeviceId: "old-device",
    servicePublicKey: "verified-test-key",
    serviceCertificates: [],
    workspaceIds: ["board"],
    scopeReceipts: [{ workspaceId: "board", grantEpoch: 1, activationOperationId: "activation-test" }],
    futureBoards: false,
    futureBoardBaselineIds: ["board"],
    revision: 1,
    state: "active",
    verifiedAt: new Date().toISOString(),
  })
  await saveOwnerKeeper(profile.identity.personId, { personId: "old-keeper", role: "editor" })
  const root = document.createElement("div")
  document.body.appendChild(root)
  const keepers = ref([{ personId: "old-keeper", name: "Old Lighthouse", role: "visitor" as const, self: false,
    online: false, reconnecting: false, onlineDevices: 0, devices: 1,
    deviceList: [{ deviceId: "old-device", name: "Old worker", userAgent: "mesh-lighthouse/0.1.0",
      description: "Lighthouse", online: false, reconnecting: false, tabs: 1, lastSeen: "2026-09-25T12:00:00Z" }],
  }])
  let attempt: { complete(): void; fail(): void } | undefined
  let removalAttempts = 0
  const removeKeeper = () => new Promise<void>((resolve, reject) => {
    removalAttempts += 1
    attempt = {
      complete: () => { keepers.value = []; resolve() },
      fail: () => reject(new Error("Could not revoke keeper")),
    }
  })
  createApp({ setup: () => () => h(KeeperDiscovery, { ownedWorkspaces: [{ id: "board", title: "Board" }], keepers: keepers.value,
    provisionKeeper: async () => "active" as const, removeKeeper }) }).mount(root)
  Object.assign(window, { keeperRemoval: {
    complete: () => attempt?.complete(),
    fail: () => attempt?.fail(),
    attempts: () => removalAttempts,
  } })
}
