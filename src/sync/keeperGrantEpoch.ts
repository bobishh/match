import type { KeeperIntegrationStatus } from "./keeperIntegrationStatus"

/** Highest signed service grant epoch, active or removed, for each selected workspace. */
export function keeperServiceGrantFloors(integrations: KeeperIntegrationStatus[], workspaceIds: string[]) {
  const floors: Record<string, number> = {}
  for (const workspaceId of workspaceIds) {
    floors[workspaceId] = Math.max(0, ...integrations.flatMap(integration =>
      [...integration.scopes, ...integration.tombstones]
        .filter(scope => scope.workspaceId === workspaceId).map(scope => scope.grantEpoch)))
  }
  return floors
}

/** Preserve local history and advance beyond Rusty's authenticated tombstone fence. */
export function nextKeeperGrantEpoch(localNextEpoch: number, serviceFloor: number): number {
  if (!Number.isSafeInteger(localNextEpoch) || localNextEpoch < 1
    || !Number.isSafeInteger(serviceFloor) || serviceFloor < 0 || serviceFloor >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Keeper grant epoch floor is invalid.")
  }
  return Math.max(localNextEpoch, serviceFloor + 1)
}
