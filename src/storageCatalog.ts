import * as Automerge from "@automerge/automerge/slim"
import type { WorkspaceDocumentV2, Heads } from "./domain/model"
import { getStorageRaw, setStorageRaw } from "./storageRaw"
import type { CommittedWorkspaceMeta } from "./storageJournal"

const workspaceMetaPrefix = "match.workspace-meta."
type WorkspaceMeta = { id: string; title: string; updatedAt: string; archivedAt?: string | null }

export function includesWorkspaceHeads(doc: Automerge.Doc<WorkspaceDocumentV2>, heads: Heads): boolean {
  const changes = new Map(Automerge.getAllChanges(doc).map(bytes => {
    const change = Automerge.decodeChange(bytes)
    return [change.hash, change.deps] as const
  }))
  const reachable = new Set<string>()
  const pending = [...Automerge.getHeads(doc)]
  while (pending.length) {
    const hash = pending.pop()!
    if (reachable.has(hash)) continue
    reachable.add(hash)
    pending.push(...(changes.get(hash) ?? []))
  }
  return heads.every(hash => reachable.has(hash))
}

export async function repairLegacyCatalog(records: Map<string, WorkspaceMeta>, snapshots: CommittedWorkspaceMeta[]): Promise<void> {
  const committedIds = new Set(snapshots.map(snapshot => snapshot.id))
  for (const record of records.values()) {
    if (committedIds.has(record.id)) continue
    const key = `${workspaceMetaPrefix}${record.id}`
    if (await getStorageRaw(key) === null) await setStorageRaw(key, JSON.stringify(record))
  }
}
