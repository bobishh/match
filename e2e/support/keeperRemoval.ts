import { createApp, h, ref } from "vue"
import KeeperDiscovery from "../../src/components/KeeperDiscovery.vue"

export function mountKeeperRemoval() {
  const root = document.createElement("div")
  document.body.appendChild(root)
  const keepers = ref([{ personId: "old-keeper", name: "Old Lighthouse", role: "visitor" as const, self: false,
    online: false, reconnecting: false, onlineDevices: 0, devices: 1,
    deviceList: [{ deviceId: "old-device", name: "Old worker", userAgent: "mesh-lighthouse/0.1.0",
      description: "Lighthouse", online: false, reconnecting: false, tabs: 1, lastSeen: "2026-09-25T12:00:00Z" }],
  }])
  let resolveRemoval: (() => void) | undefined
  let rejectRemoval: ((reason: Error) => void) | undefined
  const removeKeeper = () => new Promise<void>((resolve, reject) => {
    keepers.value = []
    resolveRemoval = resolve
    rejectRemoval = reject
  })
  createApp({ setup: () => () => h(KeeperDiscovery, { ownedWorkspaces: [{ id: "board", title: "Board" }], keepers: keepers.value,
    provisionKeeper: async () => "active" as const, removeKeeper }) }).mount(root)
  Object.assign(window, { keeperRemoval: {
    complete: () => resolveRemoval?.(),
    fail: () => rejectRemoval?.(new Error("Could not revoke keeper")),
  } })
}
