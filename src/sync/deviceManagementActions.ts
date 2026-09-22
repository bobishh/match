import type { Ref } from "vue"
import type { DurableMesh } from "./durableMesh"

export function deviceManagementActions(mesh: () => Promise<DurableMesh | undefined>, workspaces: Ref<{ id: string; title: string }[]>, revision: Ref<number>) {
  return {
    removableDeviceWorkspaces: async (personId: string, deviceId: string) => {
      const ids = await (await mesh())?.removableDeviceWorkspaces(personId, deviceId) ?? []
      return ids.map(id => ({ id, title: workspaces.value.find(workspace => workspace.id === id)?.title ?? id }))
    },
    removeDevice: async (personId: string, deviceId: string, workspaceIds: string[]) => {
      const runtime = await mesh()
      if (!runtime) throw new Error("Mesh unavailable")
      await runtime.removeDevice(personId, deviceId, workspaceIds)
      revision.value += 1
    },
  }
}

export async function ownedWorkspaceIds(workspaces: { id: string }[], owner: ((id: string) => Promise<string>) | undefined, personId: string) {
  if (!owner) return []
  const result: string[] = []
  for (const workspace of workspaces) if (await owner(workspace.id) === personId) result.push(workspace.id)
  return result
}
