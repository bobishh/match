import type { WorkspaceRevocation } from "./meshRecords"

export async function runKeeperRevocationActions(actions: string[], operations: {
  create: () => Promise<WorkspaceRevocation>
  merge: (record: WorkspaceRevocation, disconnect: boolean) => Promise<void>
  refresh: () => Promise<void>
  publish: () => void
  reload: () => Promise<void>
  notify: () => Promise<void>
}) {
  let record: WorkspaceRevocation | undefined
  for (const action of actions) {
    if (action === "createRevocation") record = await operations.create()
    if (action === "mergeRevocation") {
      if (!record) throw new Error("Keeper revocation record was not created")
      await operations.merge(record, false)
    }
    if (action === "refreshSuccessionPolicy") await operations.refresh()
    if (action === "publish") operations.publish()
    if (action === "reloadCredential") await operations.reload()
    if (action === "disconnectRevoked") {
      if (!record) throw new Error("Keeper revocation record was not created")
      await operations.merge(record, true)
    }
    if (action === "notify") await operations.notify()
  }
}
