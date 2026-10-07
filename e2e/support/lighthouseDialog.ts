import { createApp } from "vue"
import SyncDialog from "../../src/components/SyncDialog.vue"

export function mountLighthouseDialog(keeperName = "Lighthouse service") {
    const root = document.createElement("div")
    document.body.appendChild(root)
    createApp(SyncDialog, {
      step: "members", title: "Device sync", qrCode: "", inviteUrl: "", copyNotice: "", error: "", hasMesh: true,
      meshMembers: [{ personId: "fixture-person", name: "Mesh participant", role: "editor", self: false,
        online: true, reconnecting: false, onlineDevices: 1, devices: 1,
        deviceList: [
          { deviceId: "browser-device", name: "Lighthouse", userAgent: "Mozilla/5.0 Chrome/140.0 Linux", description: "Likely Chrome · Linux", online: true, reconnecting: false, tabs: 1, lastSeen: "2026-09-25T12:00:00Z" },
      ],
      }, { personId: "fixture-keeper", name: keeperName, role: "visitor", self: false,
        online: true, reconnecting: false, onlineDevices: 1, devices: 1,
        deviceList: [{ deviceId: "native-device", name: "Renamed worker", userAgent: "mesh-lighthouse/0.1.0", description: "Lighthouse", online: false, reconnecting: false, tabs: 1, lastSeen: "2026-09-25T12:00:00Z" }],
      }],
    }).mount(root)
}

export function mountMobileDeviceListDialog() {
  const root = document.createElement("div")
  document.body.appendChild(root)
  const app = createApp(SyncDialog, {
    step: "members", title: "Device sync", qrCode: "", inviteUrl: "", copyNotice: "", error: "", hasMesh: true,
    meshMembers: [{ personId: "mobile-fixture", name: "Mobile test participant", role: "editor", self: false,
      online: true, reconnecting: false, onlineDevices: 20, devices: 20,
      deviceList: Array.from({ length: 20 }, (_, index) => ({
        deviceId: `phone-${index}`, name: `Phone ${index + 1}`, userAgent: "Mozilla/5.0 Chrome/140.0 Linux",
        description: "Likely Chrome · Linux", online: true, reconnecting: false, tabs: 1, lastSeen: "2026-10-02T12:00:00Z",
      })),
    }],
    onClose: () => { app.unmount(); root.remove() },
  })
  app.mount(root)
}
