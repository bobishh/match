import { createApp, h, ref } from "vue"
import KeeperDiscovery from "../../src/components/KeeperDiscovery.vue"

export async function mountKeeperSettings(mode?: "error" | "off" | "empty" | "unsupported" | "pending") {
  const profile = await (await import("../../src/domain/identity")).bootstrapIdentity()
  const { saveKeeperIntegrationReference, saveOwnerKeeper } = await import("../../src/sync/ownerKeeper")
  const { keeperApi } = await import("../../src/app/keeperApi")
  const { defaultStorage } = await import("../../src/storage")
  const { initializePersonalRootCatalog } = await import("../../src/statePersonalRoot")
  await initializePersonalRootCatalog(defaultStorage, profile)
  await saveKeeperIntegrationReference({
    integrationId: "integration-settings-test", serviceOrigin: "http://127.0.0.1:4244",
    servicePersonId: "settings-rusty-person", serviceDeviceId: "settings-rusty-device",
    servicePublicKey: "settings-test-public-key", serviceCertificates: [],
    workspaceIds: mode === "empty" ? [] : ["board-current"], integrationSettingsSupported: mode !== "unsupported",
    scopeReceipts: mode === "empty" ? [] : [{ workspaceId: "board-current", grantEpoch: 4, activationOperationId: "activation-current" }],
    futureBoards: mode !== "off" && mode !== "empty", futureBoardBaselineIds: ["board-current", "board-unselected"], revision: 8,
    state: "active", verifiedAt: new Date().toISOString(),
  })
  await saveOwnerKeeper(profile.identity.personId, { personId: "settings-rusty-person", role: "editor", details: {
    origin: "http://127.0.0.1:4244", boardIds: mode === "empty" ? [] : ["board-current"], futureBoards: mode !== "off" && mode !== "empty",
    futureBoardBaselineIds: ["board-current", "board-unselected"], integrationId: "integration-settings-test",
    servicePersonId: "settings-rusty-person", serviceDeviceId: "settings-rusty-device",
    servicePublicKey: "settings-test-public-key", serviceCertificates: [], revision: 8,
    integrationSettingsSupported: true,
  } })
  if (mode === "pending") {
    const { savePendingKeeperWithdrawal } = await import("../../src/sync/ownerKeeper")
    await savePendingKeeperWithdrawal("saved-cancel-pairing", "saved-cancel-operation", {
      pairingId: "saved-cancel-pairing", integrationId: "integration-settings-test", operatorUrl: "http://127.0.0.1:4244/operator",
      comparisonCode: "518407", expiresAt: Math.floor(Date.now() / 1000) + 300, transcriptHash: "saved-transcript",
      challengeNonce: "saved-nonce", controllerFingerprint: "fingerprint",
      discovery: { origin: "http://127.0.0.1:4244", displayName: "Rusty", personId: "settings-rusty-person",
        publicKey: "public-key", deviceId: "settings-rusty-device", certificates: [], fingerprint: "fingerprint",
        capabilities: { modes: ["replicate"], documentReplication: true, chatReplication: true, blobReplication: true, pairing: true } },
      workspaces: [{ id: "board-current", title: "Current board" }],
    })
  }
  keeperApi.keeperDetails = async () => ({ origin: "http://127.0.0.1:4244", boardIds: mode === "empty" ? [] : ["board-current"],
    futureBoards: mode !== "off" && mode !== "empty", futureBoardBaselineIds: ["board-current", "board-unselected"],
    integrationId: "integration-settings-test", servicePersonId: "settings-rusty-person",
    serviceDeviceId: "settings-rusty-device", revision: 8, integrationSettingsSupported: mode !== "unsupported" })
  keeperApi.decidePairing = async () => {}
  keeperApi.pairingStatusInfo = async () => ({ status: "approved" as const })
  if (mode === "empty" || mode === "unsupported") {
    const fakeDiscovery = { origin: "http://127.0.0.1:4244", displayName: "Rusty", personId: "settings-rusty-person",
      publicKey: "public-key", deviceId: "settings-rusty-device", certificates: [], fingerprint: "fingerprint",
      capabilities: { modes: ["replicate"], documentReplication: true, chatReplication: true,
        blobReplication: true, pairing: true } }
    keeperApi.discover = async () => fakeDiscovery
    keeperApi.eligibleWorkspaces = async (workspaces) => workspaces
    keeperApi.integrationStatus = async () => ({ integrationSettingsSupported: mode !== "unsupported", signerKeyId: "settings-rusty-device",
      signature: "signed", revision: 9, integrations: [{ integrationId: "integration-settings-test", revision: 9,
        futureBoards: false, baselineWorkspaceIds: ["board-current", "board-unselected"],
        scopes: mode === "empty" ? [] : [{ workspaceId: "board-current", grantEpoch: 4, state: "active" as const,
          activationOperationId: "activation-current" }], tombstones: [] }] })
    keeperApi.beginPairing = async (_discovery, workspaces) => ({
      pairingId: "add-board-pairing", integrationId: "integration-settings-test", operatorUrl: "http://127.0.0.1:4244/operator",
      comparisonCode: "611204", expiresAt: Math.floor(Date.now() / 1000) + 300, transcriptHash: "add-board-transcript",
      challengeNonce: "add-board-nonce", controllerFingerprint: "fingerprint", discovery: fakeDiscovery,
      workspaces, futureBoards: false, futureBoardBaselineIds: ["board-current", "board-unselected"],
      expectedIntegrationRevision: 9, integrationUpdate: { integrationId: "integration-settings-test", expectedRevision: 9,
        scopeWorkspaceIds: workspaces.map(workspace => workspace.id),
        policy: { futureBoards: false, baselineWorkspaceIds: ["board-current", "board-unselected"] } },
    })
  }
  const root = document.createElement("div")
  document.body.appendChild(root)
  const keepers = ref([{ personId: "settings-rusty-person", name: "Rusty keeper", role: "editor" as const,
    self: false, online: true, reconnecting: false, onlineDevices: 1, devices: 1,
    deviceList: [{ deviceId: "settings-rusty-device", name: "Rusty", userAgent: "mesh-lighthouse/1.0.0",
      description: "Rusty", online: true, reconnecting: false, tabs: 1, lastSeen: new Date().toISOString() }],
  }])
  const updateKeeperSettings = async (personId: string, futureBoards: boolean, removeWorkspaceIds: string[]) => {
    ;(window as unknown as { keeperSettingsRequest?: unknown }).keeperSettingsRequest = { personId, futureBoards, removeWorkspaceIds }
    if (mode === "error") throw new Error("Integration revision changed")
    return "updated" as const
  }
  const beginPolicyUpdate = async (personId: string, baselineWorkspaceIds: string[]) => {
    ;(window as unknown as { keeperPolicyRequest?: unknown }).keeperPolicyRequest = { personId, baselineWorkspaceIds }
    return {
      pairingId: "policy-only-pairing", integrationId: "integration-settings-test", operatorUrl: "http://127.0.0.1:4244/operator",
      comparisonCode: "518407", expiresAt: Math.floor(Date.now() / 1000) + 300, transcriptHash: "policy-transcript",
      challengeNonce: "policy-nonce", controllerFingerprint: "fingerprint",
      discovery: { origin: "http://127.0.0.1:4244", displayName: "Rusty", personId: "settings-rusty-person",
        publicKey: "public-key", deviceId: "settings-rusty-device", certificates: [], fingerprint: "fingerprint",
        capabilities: { modes: ["replicate"], documentReplication: true, chatReplication: true,
          blobReplication: true, pairing: true } },
      workspaces: [], futureBoards: true, futureBoardBaselineIds: baselineWorkspaceIds, expectedIntegrationRevision: 8,
      integrationUpdate: { integrationId: "integration-settings-test", expectedRevision: 8,
        scopeWorkspaceIds: [], policy: { futureBoards: true, baselineWorkspaceIds }, policyOnly: true },
    }
  }
  createApp({ setup: () => () => h(KeeperDiscovery, { ownedWorkspaces: [
    { id: "board-current", title: "Current board" }, { id: "board-unselected", title: "Existing unselected board" },
    { id: "board-new", title: "New board" },
  ], keepers: keepers.value, provisionKeeper: async () => "active" as const,
  cancelKeeper: async () => "cancel_pending" as const, updateKeeperSettings, beginPolicyUpdate }) }).mount(root)
}
