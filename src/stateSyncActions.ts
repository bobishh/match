import * as Automerge from "@automerge/automerge/slim";
import { assertWorkspaceCapability } from "./domain/permissions";
import type { WorkspaceDocumentV2 } from "./domain/model";
import { validateWorkspaceDoc } from "./domain/model";
import {
  workspaceRole,
  validateIncomingChanges,
  validateIncomingChangesWithProofStatus,
} from "./sync/changeAuthorization";
import {
  defaultStorage,
  saveWorkspaceRecord,
  type WorkspaceRecord,
  type WorkspaceStorage,
} from "./storage";
import {
  migrateStoredLegacyTaskItems,
  notifyLocalChanges,
  reconcile,
  refreshAvailableWorkspaces,
  updateReactiveState,
} from "./statePersistence";
import { stateRuntime } from "./stateContext";
import {
  addWorkspaceToPersonalRoot,
  requireProfile,
  switchWorkspace,
} from "./stateWorkspaceActions";

export function createSyncActions() {
  return {
    readWorkspaceBytes,
    validateAuthorizedWorkspace,
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
  const profile = await requireProfile();
  const migrated = await migrateStoredLegacyTaskItems(doc, profile, storage);
  if (migrated !== doc && stateRuntime.activeDoc?.id === id) {
    updateReactiveState(migrated);
    notifyLocalChanges();
  }
  return Automerge.save(migrated);
}

async function mergeAuthorizedWorkspace(
  id: string,
  bytes: Uint8Array,
  authorization: unknown,
): Promise<void> {
  const { remote, local } = await validateAuthorizedWorkspace(id, bytes, authorization);
  const proofChanged = await validateIncomingChangesWithProofStatus(local, remote, authorization);
  // A signature can make an existing Automerge history trusted without adding
  // a document head. Notify the live mesh in that proof-only case too.
  const documentChanged = await mergeValidatedWorkspaceBytes(id, remote);
  if (proofChanged && !documentChanged) notifyLocalChanges();
}

/**
 * Checks a received document and all of its signatures without writing a
 * snapshot, proof record, or mesh credential. Invitation flows use this to
 * reject the whole set before any durable state becomes visible.
 */
async function validateAuthorizedWorkspace(
  id: string,
  bytes: Uint8Array,
  authorization: unknown,
): Promise<{ remote: Automerge.Doc<WorkspaceDocumentV2>; local: Automerge.Doc<WorkspaceDocumentV2> | undefined }> {
  const remote = Automerge.load<WorkspaceDocumentV2>(bytes);
  if (remote.id !== id) {
    throw invalidWorkspaceReceived({
      code: "workspace_id_mismatch",
      message: "The document id does not match the invited workspace.",
    });
  }
  const validation = validateWorkspaceDoc(remote);
  if (!validation.ok) throw invalidWorkspaceReceived(validation.error);
  const local = await mergeAuthorizationBase(id, remote);
  await validateIncomingChanges(local, remote, authorization);
  return { remote, local };
}

async function mergeAuthorizationBase(
  id: string,
  remote: Automerge.Doc<WorkspaceDocumentV2>,
) {
  const local = (await defaultStorage.loadWorkspaceDoc(id))?.doc;
  if (local && !sharesBoard(local, remote)) throw new Error(`Workspace conflict: ${id} identifies different boards. Nothing was replaced.`);
  return local;
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
    throw new Error(`Workspace conflict: ${id} identifies different boards. Nothing was replaced.`);
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
  const validation = validateWorkspaceDoc(doc);
  if (!validation.ok) throw invalidWorkspaceReceived(validation.error);
  const profile = await requireProfile();
  await assertImportAllowed(doc, profile, storage);
  await storage.saveSnapshot(doc.id, doc, Automerge.save(doc));
  await storage.registerWorkspace(doc.id, doc.title);
  await addWorkspaceToPersonalRoot(doc.id, "import", storage);
  await switchWorkspace(doc.id, storage);
  await refreshAvailableWorkspaces(storage);
  stateRuntime.storageChannel?.postMessage({ type: "workspace-persisted" });
}

function invalidWorkspaceReceived(diagnostic: {
  code: string;
  message: string;
  field?: string;
}): Error {
  const error = new Error("Invalid workspace received.", { cause: diagnostic });
  error.name = "WorkspaceDocumentRejected";
  return error;
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
