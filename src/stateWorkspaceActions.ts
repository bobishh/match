import * as Automerge from "@automerge/automerge/slim";
import type { WorkspaceRole } from "./domain/permissions";
import { bootstrapIdentity } from "./domain/identity";
import { createWorkspaceDoc } from "./domain/seeds";
import type { WorkspaceDocumentV2 } from "./domain/model";
import { registerWorkspaceInRoot } from "./domain/personalRoot";
import { workspaceRole } from "./sync/changeAuthorization";
import { defaultStorage, type WorkspaceStorage } from "./storage";
import {
  commitAndPersist,
  migrateStoredLegacyTaskItems,
  persistAuthorizedCommand,
  refreshAvailableWorkspaces,
  updateReactiveState,
} from "./statePersistence";
import { stateRuntime } from "./stateContext";

export function createWorkspaceActions() {
  return {
    createWorkspaceAsync,
    switchWorkspace,
    getWorkspaceRole,
    renameWorkspaceAsync,
    deleteWorkspaceAsync,
  };
}

async function createWorkspaceAsync(
  title: string,
  presetKey: "job-search" | "blank",
  storage = defaultStorage,
) {
  const profile = await requireProfile();
  const id = crypto.randomUUID();
  const cleanTitle = title.trim();
  const doc = Automerge.from<WorkspaceDocumentV2>(
    createWorkspaceDoc(id, cleanTitle, profile.identity.personId, presetKey),
  );
  await storage.saveSnapshot(id, doc, Automerge.save(doc));
  await storage.registerWorkspace(id, cleanTitle);
  await addWorkspaceToPersonalRoot(id, "genesis", storage);
  saveActiveWorkspaceId(id);
  updateReactiveState(doc);
  await refreshAvailableWorkspaces(storage);
  stateRuntime.storageChannel?.postMessage({ type: "workspace-persisted" });
  return doc;
}

export async function switchWorkspace(
  workspaceId: string,
  storage = defaultStorage,
): Promise<void> {
  const loaded = await storage.loadWorkspaceDoc(workspaceId);
  if (!loaded) return;
  const profile = await requireProfile();
  const doc = await migrateStoredLegacyTaskItems(loaded.doc, profile, storage);
  saveActiveWorkspaceId(workspaceId);
  updateReactiveState(doc);
}

async function getWorkspaceRole(
  workspaceId: string,
  storage = defaultStorage,
): Promise<WorkspaceRole> {
  const profile = await requireProfile();
  const doc =
    stateRuntime.activeDoc?.id === workspaceId
      ? stateRuntime.activeDoc
      : (await storage.loadWorkspaceDoc(workspaceId))?.doc;
  if (!doc) throw new Error("Workspace not found");
  return workspaceRole(doc, profile);
}

async function renameWorkspaceAsync(
  workspaceId: string,
  title: string,
  storage = defaultStorage,
): Promise<void> {
  const cleanTitle = title.trim();
  if (!cleanTitle) throw new Error("Workspace name is required");
  const profile = await requireProfile();
  if (stateRuntime.activeDoc?.id === workspaceId)
    await commitAndPersist(
      { kind: "renameWorkspace", title: cleanTitle },
      storage,
    );
  else await renameInactiveWorkspace(workspaceId, cleanTitle, profile, storage);
  await refreshAvailableWorkspaces(storage);
}

async function renameInactiveWorkspace(
  workspaceId: string,
  title: string,
  profile: Awaited<ReturnType<typeof requireProfile>>,
  storage: WorkspaceStorage,
): Promise<void> {
  const loaded = await storage.loadWorkspaceDoc(workspaceId);
  if (!loaded) throw new Error("Workspace not found");
  await persistAuthorizedCommand(
    loaded.doc,
    { kind: "renameWorkspace", title },
    profile,
    storage,
  );
}

async function deleteWorkspaceAsync(
  workspaceId: string,
  storage = defaultStorage,
): Promise<Automerge.Doc<WorkspaceDocumentV2> | undefined> {
  const wasActive = stateRuntime.activeDoc?.id === workspaceId;
  await storage.deleteWorkspace(workspaceId);
  const root = await storage.loadPersonalRoot();
  if (root?.workspaces[workspaceId]) {
    delete root.workspaces[workspaceId];
    await storage.savePersonalRoot(root);
  }
  await refreshAvailableWorkspaces(storage);
  stateRuntime.availableWorkspaces.value =
    stateRuntime.availableWorkspaces.value.filter(
      (workspace) => workspace.id !== workspaceId,
    );
  stateRuntime.storageChannel?.postMessage({ type: "workspace-persisted" });
  if (wasActive) return selectWorkspaceReplacement(storage);
}

async function selectWorkspaceReplacement(
  storage: WorkspaceStorage,
): Promise<Automerge.Doc<WorkspaceDocumentV2> | undefined> {
  const replacement = stateRuntime.availableWorkspaces.value[0];
  if (replacement) {
    await switchWorkspace(replacement.id, storage);
    return undefined;
  }
  return createWorkspaceAsync("Untitled", "blank", storage);
}

export async function addWorkspaceToPersonalRoot(
  id: string,
  source: "genesis" | "import",
  storage: WorkspaceStorage,
): Promise<void> {
  const root = await storage.loadPersonalRoot();
  if (!root) return;
  registerWorkspaceInRoot(root, id, id, source);
  await storage.savePersonalRoot(root);
}

export async function requireProfile() {
  if (!stateRuntime.currentProfile)
    stateRuntime.currentProfile = await bootstrapIdentity("Match User");
  return stateRuntime.currentProfile;
}

export function saveActiveWorkspaceId(id: string): void {
  if (typeof localStorage !== "undefined")
    localStorage.setItem("match.active_workspace_id", id);
}
