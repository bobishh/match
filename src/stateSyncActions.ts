import { hasEntityKind } from "./domain/model"
import * as Automerge from "@automerge/automerge/slim";
import { assertWorkspaceCapability } from "./domain/permissions";
import type { WorkspaceDocumentV2 } from "./domain/model";
import { validateWorkspaceDoc } from "./domain/model";
import {
  workspaceRole,
  validateIncomingChangeAuthorizations,
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
import { withWorkspaceMutation } from "./workspaceMutation";
import type { WorkspaceChangeAuthorization } from "./sync/workspaceChangeProofStore";
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
  return Automerge.save(doc);
}

async function mergeAuthorizedWorkspace(
  id: string,
  bytes: Uint8Array,
  authorization: unknown,
): Promise<void> {
  await withWorkspaceMutation(id, async () => {
    // Validation must use the same current durable base as the eventual merge.
    const { remote, local, verified } = await validateAuthorizedWorkspace(id, bytes, authorization);
    const merged = local ? Automerge.merge(Automerge.clone(local), remote) : remote;
    if (local && remote.ownerPersonId !== local.ownerPersonId)
      throw new Error("Workspace ownership cannot change through sync.");
    const documentChanged = !local || !sameHeads(merged, local);
    const { proofChanged } = await defaultStorage.commitWorkspace(
      id, merged, Automerge.save(merged), verified as WorkspaceChangeAuthorization[],
    );
    if (documentChanged || proofChanged) await publishCommittedWorkspace(id, merged, defaultStorage);
  });
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
): Promise<{ remote: Automerge.Doc<WorkspaceDocumentV2>; local: Automerge.Doc<WorkspaceDocumentV2> | undefined; verified: unknown[] }> {
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
  const verified = await validateIncomingChangeAuthorizations(local, remote, authorization);
  return { remote, local, verified };
}

async function mergeAuthorizationBase(
  id: string,
  remote: Automerge.Doc<WorkspaceDocumentV2>,
) {
  const local = (await defaultStorage.loadWorkspaceDoc(id))?.doc;
  if (local && !sharesBoard(local, remote)) throw new Error(`Workspace conflict: ${id} identifies different boards. Nothing was replaced.`);
  return local;
}

function sharesBoard(
  local: Automerge.Doc<WorkspaceDocumentV2>,
  remote: Automerge.Doc<WorkspaceDocumentV2>,
): boolean {
  return Object.values(local.entities).some(
    (entity) =>
      hasEntityKind(entity, "board") && hasEntityKind(remote.entities[entity.id], "board"),
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

async function publishCommittedWorkspace(
  id: string,
  doc: Automerge.Doc<WorkspaceDocumentV2>,
  storage: WorkspaceStorage,
): Promise<void> {
  if (stateRuntime.activeDoc?.id === id) updateReactiveState(doc);
  await refreshAvailableWorkspaces(storage);
  stateRuntime.storageChannel?.postMessage({ type: "workspace-persisted", workspaceId: id });
  notifyLocalChanges(id);
}

async function importWorkspaceDocument(
  doc: Automerge.Doc<WorkspaceDocumentV2>,
  storage = defaultStorage,
): Promise<void> {
  const validation = validateWorkspaceDoc(doc);
  if (!validation.ok) throw invalidWorkspaceReceived(validation.error);
  const profile = await requireProfile();
  await withWorkspaceMutation(doc.id, async () => {
    await assertImportAllowed(doc, profile, storage);
    const local = (await storage.loadWorkspaceDoc(doc.id))?.doc;
    const merged = local ? Automerge.merge(Automerge.clone(local), doc) : doc;
    await storage.saveSnapshot(doc.id, merged, Automerge.save(merged));
  });
  await storage.registerWorkspace(doc.id, doc.title);
  await addWorkspaceToPersonalRoot(doc.id, "import", storage);
  await switchWorkspace(doc.id, storage);
  await refreshAvailableWorkspaces(storage);
  stateRuntime.storageChannel?.postMessage({ type: "workspace-persisted", workspaceId: doc.id });
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

function subscribeLocalChanges(listener: (workspaceId?: string) => void): () => void {
  stateRuntime.localChangeListeners.add(listener);
  return () => stateRuntime.localChangeListeners.delete(listener);
}
