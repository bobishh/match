import * as Automerge from "@automerge/automerge/slim";
import { initializeAutomerge } from "./crdt";
import {
  assertWorkspaceCapability,
  assertWorkspaceTransition,
  type WorkspaceRole,
} from "./domain/permissions";
import {
  bootstrapIdentity,
  sha256Base64Url,
  type LocalProfile,
} from "./domain/identity";
import {
  createPersonalRoot,
  reconcilePersonalRootWorkspaces,
} from "./domain/personalRoot";
import { createWorkspaceDoc } from "./domain/seeds";
import { type Board, type WorkspaceDocumentV2 } from "./domain/model";
import { executeCommand, type Command } from "./domain/commands";
import {
  authorizeLocalChanges,
  recordGenesisAuthority,
  workspaceRole,
  workspaceWritesBlocked,
} from "./sync/changeAuthorization";
import {
  defaultStorage,
  saveWorkspace,
  type WorkspaceStorage,
} from "./storage";
import { projectWorkspace } from "./stateProjection";
import { stateRuntime } from "./stateContext";
import { readLocal, writeLocal } from "./localDb";

type FixtureItem = { id: string; title: string; parentId: string };
type MatchWindow = Window & {
  __MATCH_INJECT_FIXTURE__?: { items?: FixtureItem[] };
};

type ReadinessWaiter = {
  resolve: () => void;
  reject: (reason: unknown) => void;
};

const readinessWaiters = new Set<ReadinessWaiter>();

export function resetStateForTest(): void {
  stateRuntime.activeDoc = null;
  stateRuntime.currentProfile = null;
  stateRuntime.ready.value = false;
  stateRuntime.saveState.value = "idle";
  stateRuntime.pendingWrites = 0;
  stateRuntime.batchSaveFailed = false;
  stateRuntime.workspaceCommandQueues.clear();
  clearWorkspaceProjection();
  stateRuntime.availableWorkspaces.value = [];
  Object.assign(stateRuntime.activeWorkspaceMeta, {
    id: "",
    title: "Untitled",
    presetKey: "blank",
  });
  stateRuntime.docVersion.value += 1;
  stateRuntime.localChangeListeners.clear();
}

export function updateReactiveState(
  doc: Automerge.Doc<WorkspaceDocumentV2>,
): void {
  stateRuntime.activeDoc = doc;
  const board = Object.values(doc.entities).find(
    (entity): entity is Board => entity.kind === "board",
  );
  Object.assign(stateRuntime.activeWorkspaceMeta, {
    id: doc.id,
    title: doc.title,
    presetKey: board?.preset?.key ?? "blank",
  });
  stateRuntime.docVersion.value += 1;
  const projected = projectWorkspace(doc);
  replaceWorkspaceProjection(projected);
}

export async function hydrate(storage = defaultStorage): Promise<void> {
  try {
    await initializeAutomerge();
    stateRuntime.currentProfile = await bootstrapIdentity();
    const doc = await loadInitialWorkspace(storage, stateRuntime.currentProfile);
    updateReactiveState(doc);
    await initializePersonalRoot(storage, stateRuntime.currentProfile);
    applyInjectedFixture();
    await refreshAvailableWorkspaces(storage);
    stateRuntime.ready.value = true;
    for (const waiter of readinessWaiters) waiter.resolve();
    readinessWaiters.clear();
  } catch (error) {
    for (const waiter of readinessWaiters) waiter.reject(error);
    readinessWaiters.clear();
    throw error;
  }
}

export function whenReady(): Promise<void> {
  if (stateRuntime.ready.value && stateRuntime.activeDoc) return Promise.resolve();
  return new Promise((resolve, reject) => {
    readinessWaiters.add({ resolve, reject });
  });
}

export async function commitAndPersist(
  command: Command,
  storage = defaultStorage,
): Promise<void> {
  const workspaceId = stateRuntime.activeDoc?.id;
  const profile = stateRuntime.currentProfile;
  if (!workspaceId || !profile) throw new Error("Workspace not hydrated");
  startPendingWrite();
  try {
    await queueWorkspaceCommand(workspaceId, () =>
      persistCommand(workspaceId, command, profile, storage),
    );
  } catch (error) {
    stateRuntime.batchSaveFailed = true;
    throw error;
  } finally {
    finishPendingWrite();
  }
}

export async function persistAuthorizedCommand(
  doc: Automerge.Doc<WorkspaceDocumentV2>,
  command: Command,
  profile: LocalProfile,
  storage: WorkspaceStorage,
): Promise<Automerge.Doc<WorkspaceDocumentV2>> {
  if (await workspaceWritesBlocked(doc.id))
    throw new Error("Workspace writes paused: conflicting ownership records");
  const role = await workspaceRole(doc, profile);
  ensureContentWrite(role);
  const result = await executeCommand(doc, command, profile);
  if (!result.ok)
    throw new Error(
      `Command failed: [${result.error.code}] ${result.error.message}`,
    );
  const changeBytes = Automerge.getLastLocalChange(result.value.newDoc);
  if (!changeBytes) throw new Error("No change produced");
  assertWorkspaceTransition(role, doc, result.value.newDoc);
  await authorizeLocalChanges(result.value.newDoc, profile, [
    result.value.receipt.changeHash,
  ]);
  await storage.commitTransaction(
    doc.id,
    result.value.receipt,
    changeBytes,
    result.value.proof,
  );
  await storage.saveSnapshot(
    doc.id,
    result.value.newDoc,
    Automerge.save(result.value.newDoc),
  );
  return result.value.newDoc;
}

export async function reconcile(storage = defaultStorage): Promise<void> {
  if (
    !stateRuntime.ready.value ||
    stateRuntime.reconcilePromise ||
    !stateRuntime.activeDoc
  )
    return stateRuntime.reconcilePromise;
  stateRuntime.reconcilePromise = reconcileWorkspace(storage).finally(() => {
    stateRuntime.reconcilePromise = undefined;
  });
  return stateRuntime.reconcilePromise;
}

export async function refreshAvailableWorkspaces(
  storage = defaultStorage,
): Promise<void> {
  stateRuntime.availableWorkspaces.value = await storage.listWorkspaces();
  const meta = stateRuntime.activeWorkspaceMeta;
  if (
    meta.id &&
    !stateRuntime.availableWorkspaces.value.some(
      (workspace) => workspace.id === meta.id,
    )
  ) {
    stateRuntime.availableWorkspaces.value.unshift({
      id: meta.id,
      title: meta.title,
      updatedAt: new Date().toISOString(),
    });
  }
}

export function notifyLocalChanges(): void {
  for (const listener of stateRuntime.localChangeListeners) listener();
}

async function loadInitialWorkspace(
  storage: WorkspaceStorage,
  profile: LocalProfile,
): Promise<Automerge.Doc<WorkspaceDocumentV2>> {
  const initialId = await activeWorkspaceId();
  const loaded = await loadPreferredWorkspace(storage, initialId);
  if (loaded) return loaded.doc;
  const doc = await initializeFirstWorkspace(
    storage,
    profile,
  );
  if (!doc) throw new Error("Workspace initialization failed");
  return doc;
}

async function activeWorkspaceId(): Promise<string> {
  return await readLocal("match.active_workspace_id") ?? "default";
}

async function loadPreferredWorkspace(
  storage: WorkspaceStorage,
  initialId: string,
) {
  return (
    (await storage.loadWorkspaceDoc(initialId)) ??
    (initialId === "default" ? null : storage.loadWorkspaceDoc("default"))
  );
}

async function initializeFirstWorkspace(
  storage: WorkspaceStorage,
  profile: LocalProfile,
) {
  const initialize = async () => {
    const existing = await storage.listWorkspaces();
    const first = existing[0];
    if (first) return (await storage.loadWorkspaceDoc(first.id))?.doc ?? null;
    const workspaceId = crypto.randomUUID();
    const doc = Automerge.from<WorkspaceDocumentV2>(
      createWorkspaceDoc(workspaceId, "Untitled", profile.identity.personId, "blank"),
    );
    await recordGenesisAuthority(doc, profile);
    await storage.saveSnapshot(workspaceId, doc, Automerge.save(doc));
    await storage.registerWorkspace(workspaceId, "Untitled");
    await writeLocal("match.active_workspace_id", workspaceId);
    return doc;
  };
  return typeof navigator !== "undefined" && navigator.locks
    ? navigator.locks.request("match-first-workspace", initialize)
    : initialize();
}

async function initializePersonalRoot(
  storage: WorkspaceStorage,
  profile: LocalProfile,
): Promise<void> {
  let root = await storage.loadPersonalRoot();
  if (!root) {
    const certificate = new TextEncoder().encode(
      JSON.stringify(profile.certificate),
    );
    root = createPersonalRoot(profile, await sha256Base64Url(certificate));
    await storage.savePersonalRoot(root);
  }
  const newlyAdded = reconcilePersonalRootWorkspaces(
    root,
    await storage.listWorkspaces(),
  );
  const nameChanged = root.identity.personId === profile.identity.personId && root.identity.displayName !== profile.identity.displayName;
  if (nameChanged) root.identity.displayName = profile.identity.displayName;
  if (newlyAdded.length > 0 || nameChanged) await storage.savePersonalRoot(root);
}

function applyInjectedFixture(): void {
  const fixture =
    typeof window === "undefined"
      ? undefined
      : (window as MatchWindow).__MATCH_INJECT_FIXTURE__;
  const items = fixture?.items;
  if (!items || !stateRuntime.activeDoc) return;
  const updated = Automerge.change(stateRuntime.activeDoc, (draft) => {
    const board = Object.values(draft.entities).find(
      (entity): entity is Board => entity.kind === "board",
    );
    if (!board) return;
    board.preset = { key: "blank", version: 1, bindings: {} };
    ensureFixtureColumn(draft, board);
    addFixtureItems(draft, items);
  });
  updateReactiveState(updated);
}

function ensureFixtureColumn(draft: WorkspaceDocumentV2, board: Board): void {
  if (
    Object.values(draft.entities).some(
      (entity) => entity.kind === "column" && entity.title === "To do",
    )
  )
    return;
  const id = crypto.randomUUID();
  draft.entities[id] = {
    id,
    kind: "column",
    title: "To do",
    placement: { parentId: board.id, rank: "0/1" },
    displayHint: "normal",
    deleted: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function addFixtureItems(
  draft: WorkspaceDocumentV2,
  items: FixtureItem[],
): void {
  for (const item of items) {
    draft.entities[item.id] = {
      id: item.id,
      title: item.title,
      body: "",
      placement: { parentId: item.parentId, rank: "0/1" },
      deleted: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      values: {},
    };
  }
}

function startPendingWrite(): void {
  if (stateRuntime.pendingWrites === 0) stateRuntime.batchSaveFailed = false;
  stateRuntime.pendingWrites += 1;
  stateRuntime.saveState.value = "saving";
}

function finishPendingWrite(): void {
  stateRuntime.pendingWrites -= 1;
  stateRuntime.saveState.value = stateRuntime.pendingWrites
    ? "saving"
    : stateRuntime.batchSaveFailed
      ? "error"
      : "saved";
}

async function queueWorkspaceCommand(
  workspaceId: string,
  operation: () => Promise<void>,
): Promise<void> {
  const previous =
    stateRuntime.workspaceCommandQueues.get(workspaceId) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => withWorkspaceLock(workspaceId, operation));
  stateRuntime.workspaceCommandQueues.set(workspaceId, current);
  void current
    .finally(() => {
      if (stateRuntime.workspaceCommandQueues.get(workspaceId) === current)
        stateRuntime.workspaceCommandQueues.delete(workspaceId);
    })
    .catch(() => undefined);
  await current;
}

function withWorkspaceLock(
  workspaceId: string,
  operation: () => Promise<void>,
): Promise<void> {
  return typeof navigator !== "undefined" && navigator.locks
    ? navigator.locks.request(
        `match-workspace-command:${workspaceId}`,
        operation,
      )
    : operation();
}

async function persistCommand(
  workspaceId: string,
  command: Command,
  profile: LocalProfile,
  storage: WorkspaceStorage,
): Promise<void> {
  const base = await latestWorkspaceDocument(workspaceId, storage);
  let next = await persistAuthorizedCommand(base, command, profile, storage);
  next = await mergeLatestWorkspaceVersions(workspaceId, next, storage);
  await storage.saveSnapshot(workspaceId, next, Automerge.save(next));
  if (stateRuntime.activeDoc?.id === workspaceId) {
    updateReactiveState(next);
    await saveWorkspace(stateRuntime.workspace).catch(() => undefined);
  }
  stateRuntime.storageChannel?.postMessage({
    type: "workspace-persisted",
    workspaceId,
  });
  notifyLocalChanges();
}

async function latestWorkspaceDocument(
  workspaceId: string,
  storage: WorkspaceStorage,
): Promise<Automerge.Doc<WorkspaceDocumentV2>> {
  const local =
    stateRuntime.activeDoc?.id === workspaceId ? stateRuntime.activeDoc : null;
  const stored = (await storage.loadWorkspaceDoc(workspaceId))?.doc ?? null;
  if (!local && !stored) throw new Error("Workspace not hydrated");
  return local && stored
    ? Automerge.merge(Automerge.clone(local), Automerge.clone(stored))
    : (local ?? (stored as Automerge.Doc<WorkspaceDocumentV2>));
}

async function mergeLatestWorkspaceVersions(
  workspaceId: string,
  next: Automerge.Doc<WorkspaceDocumentV2>,
  storage: WorkspaceStorage,
) {
  const stored = (await storage.loadWorkspaceDoc(workspaceId))?.doc;
  const local =
    stateRuntime.activeDoc?.id === workspaceId
      ? stateRuntime.activeDoc
      : undefined;
  const withStored = stored
    ? Automerge.merge(Automerge.clone(next), Automerge.clone(stored))
    : next;
  return local
    ? Automerge.merge(Automerge.clone(withStored), Automerge.clone(local))
    : withStored;
}

function ensureContentWrite(role: WorkspaceRole): void {
  if (role === "visitor") assertWorkspaceCapability(role, "content.write");
}

async function reconcileWorkspace(storage: WorkspaceStorage): Promise<void> {
  const active = stateRuntime.activeDoc;
  if (!active) return;
  await refreshAvailableWorkspaces(storage);
  const loaded = await storage.loadWorkspaceDoc(active.id);
  if (
    !loaded ||
    Automerge.getHeads(active).sort().join(",") === loaded.heads.join(",")
  )
    return;
  updateReactiveState(loaded.doc);
  notifyLocalChanges();
}

function clearWorkspaceProjection(): void {
  const workspace = stateRuntime.workspace;
  workspace.leads.splice(0, workspace.leads.length);
  workspace.documents.splice(0, workspace.documents.length);
  workspace.templates.splice(0, workspace.templates.length);
  workspace.artifacts.splice(0, workspace.artifacts.length);
}

function replaceWorkspaceProjection(
  projected: typeof stateRuntime.workspace,
): void {
  const workspace = stateRuntime.workspace;
  workspace.leads.splice(0, workspace.leads.length, ...projected.leads);
  workspace.documents.splice(
    0,
    workspace.documents.length,
    ...projected.documents,
  );
  workspace.templates.splice(
    0,
    workspace.templates.length,
    ...projected.templates,
  );
  workspace.artifacts.splice(
    0,
    workspace.artifacts.length,
    ...projected.artifacts,
  );
}

stateRuntime.storageChannel?.addEventListener("message", () => {
  void reconcile();
});
if (typeof window !== "undefined") {
  window.addEventListener("focus", () => {
    void reconcile();
  });
  globalThis.document?.addEventListener("visibilitychange", () => {
    if (!globalThis.document.hidden) void reconcile();
  });
}
