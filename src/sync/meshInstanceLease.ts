import {
  acquireMeshInstanceLease as acquireSharedMeshInstanceLease,
  type MeshInstanceLease,
  type MeshInstanceLocks,
} from "@meta-uber/mesh-instance"

export type { MeshInstanceLease, MeshInstanceLocks }

type MeshInstanceLeaseOptions = {
  locks?: MeshInstanceLocks | null
  preferredInstanceId?: string | null
  slots?: number
}

export function acquireMeshInstanceLease(options: MeshInstanceLeaseOptions = {}): Promise<MeshInstanceLease> {
  return acquireSharedMeshInstanceLease({
    namespace: "match",
    compatibilityLockNames: ["match:mesh-leader"],
    ...options,
  })
}
