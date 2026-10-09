import { expect, test } from "vitest"
import type { BlindReplicaConfig } from "./blindReplication"
import { replicaKey, replicaStatus, replicationPresence, type ReplicaHealth } from "./replicationHealth"
const board = { origin: "https://rusty.example", scopeId: "one", workspaceId: "board" } as BlindReplicaConfig
const other = { ...board, scopeId: "two", workspaceId: "other" }
const now = 100_000
const healthy: ReplicaHealth = { phase: "synced", lastSyncedAt: now - 1000 }

test("Given offline devices and a confirmed Rusty pass, then board status is connected", () => {
 expect(replicationPresence("offline", [board], { [replicaKey(board)]: healthy }, "board", now)).toBe("connected")
 expect(replicaStatus(board, healthy, now)).toBe("Synced")
})
test("Given saved Rusty settings, when no pass was confirmed, then no connected claim is shown", () => {
 expect(replicaStatus(board, undefined, now)).toBe("Not checked")
 expect(replicationPresence("offline", [board], {}, "board", now)).toBe("reconnecting")
})
test("Given two boards, when only the other board fails, then active board retains its confirmed status", () => {
 const states = { [replicaKey(board)]: healthy, [replicaKey(other)]: { phase: "error", error: "Server unavailable" } as ReplicaHealth }
 expect(replicationPresence("offline", [board, other], states, "board", now)).toBe("connected")
 expect(replicationPresence("empty", [board, other], states, "other", now)).toBe("offline")
 expect(replicationPresence("empty", [board, other], states, "unconfigured", now)).toBe("empty")
 expect(replicationPresence("connected", [board, other], states, "other", now)).toBe("connected")
})
test("Given a prior successful sync, when a request fails or confirmation expires, then status stops claiming healthy", () => {
 expect(replicaStatus(board, { ...healthy, phase: "error", error: "Offline" }, now)).toBe("Unavailable")
 expect(replicaStatus(board, healthy, now + 60_000)).toBe("Check overdue")
 expect(replicationPresence("empty", [board], { [replicaKey(board)]: healthy }, "board", now + 60_000)).toBe("offline")
 expect(replicaStatus({ ...board, removalPending: true }, healthy, now)).toBe("Removal pending")
 expect(replicationPresence("offline", [{ ...board, removalPending: true }], { [replicaKey(board)]: healthy }, "board", now)).toBe("offline")
 expect(replicaStatus(board, { ...healthy, phase: "syncing" }, now)).toBe("Syncing")
 expect(replicaStatus(board, { ...healthy, phase: "catching-up" }, now)).toBe("Catching up")
 expect(replicationPresence("offline", [board], { [replicaKey(board)]: { ...healthy, phase: "catching-up" } }, "board", now)).toBe("reconnecting")
})
