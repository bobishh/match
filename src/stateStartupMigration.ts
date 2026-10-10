import type { Doc } from "@automerge/automerge/slim"
import type { LocalProfile } from "./domain/identity"
import type { WorkspaceDocumentV2 } from "./domain/model"
import { needsWorkspaceStateMigration } from "./domain/workspaceMigration"
import { workspaceRole } from "./sync/changeAuthorization"
import type { WorkspaceStorage } from "./storage"

export async function migrateOwnedWorkspaces(storage: WorkspaceStorage, profile: LocalProfile,
  persistMigration: (doc: Doc<WorkspaceDocumentV2>) => Promise<unknown>): Promise<void> {
  const available = [...await storage.listWorkspaces(), ...await storage.listArchivedWorkspaces()]
  for (const { id } of new Map(available.map(workspace => [workspace.id, workspace])).values()) {
    const loaded = await storage.loadWorkspaceDoc(id)
    if (!loaded || ((loaded.doc as unknown as { formatVersion: number }).formatVersion !== 2 && !needsWorkspaceStateMigration(loaded.doc))) continue
    if (await workspaceRole(loaded.doc, profile) !== "owner") continue
    await persistMigration(loaded.doc)
  }
}
