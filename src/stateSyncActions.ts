import * as Automerge from "@automerge/automerge/slim";
import { assertWorkspaceCapability } from "./domain/permissions";
import type { WorkspaceDocumentV2 } from "./domain/model";
import { validateWorkspaceDoc } from "./domain/model";
import { registerWorkspaceInRoot } from "./domain/personalRoot";
import {
  workspaceRole,
  validateIncomingChangesWithProofStatus,
} from "./sync/changeAuthorization";
import {
  defaultStorage,
  saveWorkspaceRecord,
  type WorkspaceRecord,
  type WorkspaceStorage,
} from "./storage";
import {
  notifyLocalChanges,
  reconcile,
  refreshAvailableWorkspaces,
  updateReactiveState,
} from "./statePersistence";
import { stateRuntime } from "./stateContext";
import {
  addWorkspaceToPersonalRoot,
  requireProfile,
  saveActiveWorkspaceId,
  switchWorkspace,
} from "./stateWorkspaceActions";

export function createSyncActions() {
  return {
    readWorkspaceBytes,
    mergeAuthorizedWorkspace,
    importWorkspaceDocument,
    mergeWorkspaceRecord,
    subscribeLocalChanges,
  };
}

async function readWorkspaceBytes(
  id: string,
  storage = defaultStorage,
): Promise<Uint8Array> {
  const doc =
    stateRuntime.activeDoc?.id === id
      ? stateRuntime.activeDoc
      : (await storage.loadWorkspaceDoc(id))?.doc;
  if (!doc)
    throw new Error("The selected workspace is unavailable on this device.");
  return Automerge.save(doc);
}

async function mergeAuthorizedWorkspace(
  id: string,
  bytes: Uint8Array,
  authorization: unknown,
): Promise<void> {
  const remote = Automerge.load<WorkspaceDocumentV2>(bytes);
  if (remote.id !== id || !validateWorkspaceDoc(remote).ok)
    throw new Error("Invalid workspace received.");
  const local = await mergeAuthorizationBase(id, remote);
  const proofChanged = await validateIncomingChangesWithProofStatus(local, remote, authorization);
  // A signature can make an existing Automerge history trusted without adding
  // a document head. Notify the live mesh in that proof-only case too.
  const documentChanged = await mergeValidatedWorkspaceBytes(id, remote);
  if (proofChanged && !documentChanged) notifyLocalChanges();
}

async function mergeAuthorizationBase(
  id: string,
  remote: Automerge.Doc<WorkspaceDocumentV2>,
) {
  const local = (await defaultStorage.loadWorkspaceDoc(id))?.doc;
  return local && sharesBoard(local, remote) ? local : undefined;
}

async function mergeValidatedWorkspaceBytes(
  id: string,
  remote: Automerge.Doc<WorkspaceDocumentV2>,
  storage = defaultStorage,
): Promise<boolean> {
  const local =
    stateRuntime.activeDoc?.id === id
      ? stateRuntime.activeDoc
      : (await storage.loadWorkspaceDoc(id))?.doc;
  if (!local) {
    await saveMergedWorkspace(id, remote, storage);
    return true;
  }
  if (!sharesBoard(local, remote)) {
    await moveLocalWorkspaceAside(id, local, remote, storage);
    return true;
  }
  if (remote.ownerPersonId !== local.ownerPersonId)
    throw new Error("Workspace ownership cannot change through sync.");
  const merged = Automerge.merge(Automerge.clone(local), remote);
  if (sameHeads(merged, local)) return false;
  await saveMergedWorkspace(id, merged, storage);
  return true;
}

function sharesBoard(
  local: Automerge.Doc<WorkspaceDocumentV2>,
  remote: Automerge.Doc<WorkspaceDocumentV2>,
): boolean {
  return Object.values(local.entities).some(
    (entity) =>
      entity.kind === "board" && remote.entities[entity.id]?.kind === "board",
  );
}

function sameHeads(
  left: Automerge.Doc<WorkspaceDocumentV2>,
  right: Automerge.Doc<WorkspaceDocumentV2>,
): boolean {
  return (
    Automerge.getHeads(left).sort().join() ===
    Automerge.getHeads(right).sort().join()
  );
}

async function moveLocalWorkspaceAside(
  id: string,
  local: Automerge.Doc<WorkspaceDocumentV2>,
  remote: Automerge.Doc<WorkspaceDocumentV2>,
  storage: WorkspaceStorage,
): Promise<void> {
  const localId = crypto.randomUUID();
  const localTitle = await uniqueLocalTitle(local.title, storage);
  const moved = await storage.rekeyWorkspace(id, localId, localTitle);
  if (stateRuntime.activeDoc?.id === id) {
    saveActiveWorkspaceId(localId);
    updateReactiveState(moved);
  }
  await moveRootWorkspaceReference(id, localId, storage);
  await saveMergedWorkspace(id, remote, storage);
}

async function uniqueLocalTitle(
  title: string,
  storage: WorkspaceStorage,
): Promise<string> {
  const taken = new Set(
    (await storage.listWorkspaces()).map((workspace) => workspace.title),
  );
  const base = `${title} (local)`;
  let candidate = base;
  for (let suffix = 2; taken.has(candidate); suffix += 1)
    candidate = `${base} ${suffix}`;
  return candidate;
}

async function moveRootWorkspaceReference(
  id: string,
  localId: string,
  storage: WorkspaceStorage,
): Promise<void> {
  const root = await storage.loadPersonalRoot();
  if (!root) return;
  const previous = root.workspaces[id];
  delete root.workspaces[id];
  root.workspaces[localId] = previous
    ? { ...previous, workspaceId: localId, documentId: localId }
    : {
        workspaceId: localId,
        documentId: localId,
        grantHash: "genesis",
        forgotten: false,
      };
  registerWorkspaceInRoot(root, id, id, "shared");
  await storage.savePersonalRoot(root);
}

async function saveMergedWorkspace(
  id: string,
  doc: Automerge.Doc<WorkspaceDocumentV2>,
  storage: WorkspaceStorage,
): Promise<void> {
  await storage.saveSnapshot(id, doc, Automerge.save(doc));
  if (stateRuntime.activeDoc?.id === id) updateReactiveState(doc);
  await refreshAvailableWorkspaces(storage);
  stateRuntime.storageChannel?.postMessage({ type: "workspace-persisted" });
  notifyLocalChanges();
}

async function importWorkspaceDocument(
  doc: Automerge.Doc<WorkspaceDocumentV2>,
  storage = defaultStorage,
): Promise<void> {
  if (!validateWorkspaceDoc(doc).ok)
    throw new Error("Invalid workspace received.");
  const profile = await requireProfile();
  await assertImportAllowed(doc, profile, storage);
  await storage.saveSnapshot(doc.id, doc, Automerge.save(doc));
  await storage.registerWorkspace(doc.id, doc.title);
  await addWorkspaceToPersonalRoot(doc.id, "import", storage);
  await switchWorkspace(doc.id, storage);
  await refreshAvailableWorkspaces(storage);
  stateRuntime.storageChannel?.postMessage({ type: "workspace-persisted" });
}

async function assertImportAllowed(
  doc: Automerge.Doc<WorkspaceDocumentV2>,
  profile: Awaited<ReturnType<typeof requireProfile>>,
  storage: WorkspaceStorage,
): Promise<void> {
  const existing = (await storage.loadWorkspaceDoc(doc.id))?.doc;
  if (existing) {
    assertWorkspaceCapability(
      await workspaceRole(existing, profile),
      "workspace.import",
    );
    if (existing.ownerPersonId !== doc.ownerPersonId)
      throw new Error("Workspace ownership cannot change through import.");
  } else if (doc.ownerPersonId !== profile.identity.personId)
    throw new Error("Only the workspace owner can import a new workspace");
}

async function mergeWorkspaceRecord(
  record: WorkspaceRecord,
  storage = defaultStorage,
): Promise<void> {
  const doc = stateRuntime.activeDoc;
  const profile = stateRuntime.currentProfile;
  if (!doc || !profile) throw new Error("Workspace not hydrated");
  assertWorkspaceCapability(
    await workspaceRole(doc, profile),
    "workspace.import",
  );
  await saveWorkspaceRecord(record);
  await reconcile(storage);
}

function subscribeLocalChanges(listener: () => void): () => void {
  stateRuntime.localChangeListeners.add(listener);
  return () => stateRuntime.localChangeListeners.delete(listener);
}
