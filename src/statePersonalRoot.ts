import { sha256Base64Url, type LocalProfile } from "./domain/identity"
import {
  createPersonalRoot,
  pruneForeignGenesisWorkspaceRefs,
  reconcilePersonalRootWorkspaces,
  registerWorkspaceInRoot,
} from "./domain/personalRoot"
import type { WorkspaceStorage } from "./storage"

export async function initializePersonalRootCatalog(storage: WorkspaceStorage, profile: LocalProfile): Promise<void> {
  let root = await storage.loadPersonalRoot()
  const created = !root
  if (!root) {
    const certificate = new TextEncoder().encode(JSON.stringify(profile.certificate))
    root = createPersonalRoot(profile, await sha256Base64Url(certificate))
  }
  root.workspaces ??= {}
  const workspaces = [...await storage.listWorkspaces(), ...await storage.listArchivedWorkspaces()]
  const ownerById = new Map<string, string>()
  for (const workspace of workspaces) {
    const loaded = await storage.loadWorkspaceDoc(workspace.id)
    if (loaded) ownerById.set(workspace.id, loaded.doc.ownerPersonId)
  }
  const newlyAdded = created
    ? reconcilePersonalRootWorkspaces(root, workspaces.filter(workspace => ownerById.get(workspace.id) === profile.identity.personId))
    : []
  const removedStaleGenesisRefs = !created && root.identity.personId === profile.identity.personId
    ? pruneForeignGenesisWorkspaceRefs(root, ownerById).length > 0
    : false
  const nameChanged = root.identity.personId === profile.identity.personId && root.identity.displayName !== profile.identity.displayName
  if (nameChanged) root.identity.displayName = profile.identity.displayName
  if (created || newlyAdded.length > 0 || removedStaleGenesisRefs || nameChanged) await storage.savePersonalRoot(root)
}

export async function registerWorkspaceInCurrentRoot(
  storage: WorkspaceStorage,
  profile: LocalProfile,
  workspaceId: string,
  grantHash: string,
): Promise<void> {
  const root = await storage.loadPersonalRoot()
  if (root?.identity.personId !== profile.identity.personId) return
  root.workspaces ??= {}
  registerWorkspaceInRoot(root, workspaceId, workspaceId, grantHash)
  await storage.savePersonalRoot(root)
}
