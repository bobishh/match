import { describe, expect, it } from "vitest"
import { keeperDotState, keeperRowStatus } from "./keeperStatus"
import type { MeshMemberView } from "./deviceInfo"

function keeper(overrides: Partial<MeshMemberView> = {}): MeshMemberView {
  return {
    ...overrides,
    personId: overrides.personId ?? "rusty",
    name: overrides.name ?? "Rusty",
    role: overrides.role ?? "editor",
    online: overrides.online ?? false,
    reconnecting: overrides.reconnecting ?? false,
    onlineDevices: overrides.onlineDevices ?? 0,
    devices: overrides.devices ?? 0,
    self: overrides.self ?? false,
    deviceList: overrides.deviceList ?? [],
  }
}

describe("keeper status projection", () => {
  it("keeps service availability distinct from board connectivity", () => {
    const row = keeper({ integrationBoardIds: ["other"], integrationAvailability: "available" })
    expect(keeperRowStatus(row, "current")).toBe("Service available · Not connected to this board")
    expect(keeperDotState(row)).toBe("service-available")
  })

  it("shows review, unreachable, and unknown service states without claiming a live peer", () => {
    for (const [availability, label, dot] of [
      ["unavailable", "Service unreachable", "service-unavailable"],
      ["needs-review", "Status needs review", "service-checking"],
      ["unknown", "Checking service", "service-checking"],
    ] as const) {
      const row = keeper({ integrationBoardIds: ["current"], integrationAvailability: availability })
      expect(keeperRowStatus(row, "current")).toBe(label)
      expect(keeperDotState(row)).toBe(dot)
    }
  })
})
