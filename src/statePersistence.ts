import { hasEntityKind } from "./domain/model"
import { meshTrace } from "./sync/meshTrace"
import * as Automerge from "@automerge/automerge/slim";
import { initializeAutomerge } from "./crdt";
import {
  assertWorkspaceCapability,
  assertWorkspaceCommand,
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
  prepareLocalChangeAuthorizations,
  recordGenesisAuthority,
  workspaceRole,
  workspaceWritesBlocked,
} from "./sync/changeAuthorization";
import { peerStore } from "./sync/peerStore";
import {
  defaultStorage,
  type WorkspaceStorage,
} from "./storage";
import { projectWorkspace } from "./stateProjection";
import { withWorkspaceMutation } from "./workspaceMutation";
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
  stateRuntime.reconcilePromise = undefined;
  stateRuntime.reconcileRequested = false;
  stateRuntime.reconcileWorkspaceChanged = false;
  stateRuntime.reconcileWorkspaceIds.clear();
  stateRuntime.reconcileWorkspaceUnknown = false;
  clearWorkspaceProjection();
  stateRuntime.availableWorkspaces.value = [];
  stateRuntime.archivedWorkspaces.value = [];
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
    (entity): entity is Board => hasEntityKind(entity, "board"),
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

export async function prepareLocalState(storage = defaultStorage): Promise<void> {
  try {
    console.info("[match.startup] prepare", "automerge")
    await initializeAutomerge();
    console.info("[match.startup] prepare", "identity")
    stateRuntime.currentProfile = await bootstrapIdentity();
    console.info("[match.startup] prepare", "catalog")
    await refreshAvailableWorkspaces(storage);
  } catch (error) {
    rejectReadinessWaiters(error);
    throw error;
  }
}

export async function hydrate(storage = defaultStorage): Promise<void> {
  await prepareLocalState(storage);
  await hydratePreparedState(storage);
}

export async function hydratePreparedState(storage = defaultStorage): Promise<void> {
  try {
    const profile = stateRuntime.currentProfile;
    if (!profile) throw new Error("Local identity is unavailable");
    await migrateOwnedWorkspaces(storage, profile);
    console.info("[match.startup] hydrate", "workspace")
    const doc = await loadInitialWorkspace(storage, profile);
    updateReactiveState(doc);
    console.info("[match.startup] hydrate", "personal-root")
    await initializePersonalRoot(storage, profile);
    applyInjectedFixture();
    console.info("[match.startup] hydrate", "catalog")
    await refreshAvailableWorkspaces(storage);
    stateRuntime.ready.value = true;
    for (const waiter of readinessWaiters) waiter.resolve();
    readinessWaiters.clear();
  } catch (error) {
    rejectReadinessWaiters(error);
    throw error;
  }
}

function rejectReadinessWaiters(error: unknown): void {
  for (const waiter of readinessWaiters) waiter.reject(error);
  readinessWaiters.clear();
}

async function migrateOwnedWorkspaces(storage: WorkspaceStorage, profile: LocalProfile): Promise<void> {
  const available = [...await storage.listWorkspaces(), ...await storage.listArchivedWorkspaces()];
  for (const { id } of new Map(available.map(workspace => [workspace.id, workspace])).values()) {
    const loaded = await storage.loadWorkspaceDoc(id);
    if (!loaded || (loaded.doc as unknown as { formatVersion: number }).formatVersion !== 2) continue;
    if (await workspaceRole(loaded.doc, profile) !== "owner") continue;
    await persistAuthorizedCommand(loaded.doc, { kind: "migrateWorkspaceFormat" }, profile, storage);
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
    await persistCommand(workspaceId, command, profile, storage);
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
  return withWorkspaceMutation(doc.id, async () => {
    const stored = (await storage.loadWorkspaceDoc(doc.id))?.doc;
    const base = stored ? Automerge.merge(Automerge.clone(stored), Automerge.clone(doc)) : doc;
    return commitAuthorizedCommand(base, command, profile, storage);
  });
}

async function commitAuthorizedCommand(
  doc: Automerge.Doc<WorkspaceDocumentV2>, command: Command,
  profile: LocalProfile, storage: WorkspaceStorage,
): Promise<Automerge.Doc<WorkspaceDocumentV2>> {
  if (typeof indexedDB !== "undefined" && await peerStore.getPendingOwnershipTransfer(doc.id))
    throw new Error("Ownership transfer is awaiting confirmation. Reconnect and retry the same recipient.");
  if (await workspaceWritesBlocked(doc.id))
    throw new Error("Workspace writes paused: conflicting ownership records");
  const role = await workspaceRole(doc, profile);
  ensureContentWrite(role);
  assertWorkspaceCommand(role, doc, command);
  const result = await executeCommand(doc, command, profile);
  if (!result.ok)
    throw new Error(
      `Command failed: [${result.error.code}] ${result.error.message}`,
    );
  const changeBytes = Automerge.getLastLocalChange(result.value.newDoc);
  if (!changeBytes) throw new Error("No change produced");
  if (command.kind === "moveEntity" || command.kind === "restoreAndMove") {
    (await import("./sync/workspaceAccess")).inheritLocalMoveAccess(doc, result.value.newDoc);
  }
  const authorizations = await prepareLocalChangeAuthorizations(result.value.newDoc, profile, [
    result.value.receipt.changeHash,
  ]);
  await storage.commitWorkspace(doc.id, result.value.newDoc, Automerge.save(result.value.newDoc), authorizations, {
    receipt: result.value.receipt, changeBytes, proof: result.value.proof,
  });
  meshTrace("document.persisted", { workspaceId: doc.id, recordId: result.value.receipt.changeHash, phase: "local" });
  return result.value.newDoc;
}

export async function reconcile(storage = defaultStorage, workspaceChanged = false, changedWorkspaceId?: string): Promise<void> {
  if (!stateRuntime.ready.value || !stateRuntime.activeDoc)
    return;
  if (workspaceChanged) {
    stateRuntime.reconcileWorkspaceChanged = true;
    if (changedWorkspaceId) stateRuntime.reconcileWorkspaceIds.add(changedWorkspaceId);
    else stateRuntime.reconcileWorkspaceUnknown = true;
  }
  if (stateRuntime.reconcilePromise) {
    stateRuntime.reconcileRequested = true;
    return stateRuntime.reconcilePromise;
  }
  stateRuntime.reconcilePromise = (async () => {
    do {
      stateRuntime.reconcileRequested = false;
      const workspaceChanged = stateRuntime.reconcileWorkspaceChanged;
      stateRuntime.reconcileWorkspaceChanged = false;
      const workspaceIds = new Set(stateRuntime.reconcileWorkspaceIds);
      stateRuntime.reconcileWorkspaceIds.clear();
      const workspaceUnknown = stateRuntime.reconcileWorkspaceUnknown;
      stateRuntime.reconcileWorkspaceUnknown = false;
      await reconcileWorkspace(storage, workspaceChanged, workspaceIds, workspaceUnknown);
    } while (stateRuntime.reconcileRequested);
  })().finally(() => {
    stateRuntime.reconcilePromise = undefined;
  });
  return stateRuntime.reconcilePromise;
}

export async function refreshAvailableWorkspaces(
  storage = defaultStorage,
): Promise<void> {
  const catalog = await storage.listWorkspaceCatalog();
  stateRuntime.availableWorkspaces.value = catalog.available;
  stateRuntime.archivedWorkspaces.value = catalog.archived;
  const meta = stateRuntime.activeWorkspaceMeta;
  if (
    meta.id && !stateRuntime.activeDoc?.archivedAt &&
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

export function notifyLocalChanges(workspaceId?: string): void {
  for (const listener of stateRuntime.localChangeListeners) listener(workspaceId);
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
  const preferred = await storage.loadWorkspaceDoc(initialId);
  if (preferred && !preferred.doc.archivedAt) return preferred;
  const fallback = initialId === "default" ? null : await storage.loadWorkspaceDoc("default");
  return fallback && !fallback.doc.archivedAt ? fallback : null;
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
      (entity): entity is Board => hasEntityKind(entity, "board"),
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
      (entity) => hasEntityKind(entity, "column") && entity.title === "To do",
    )
  )
    return;
  const id = crypto.randomUUID();
  draft.entities[id] = {
    id,
    kind: "column",
    title: "To do",
    placement: { parentId: board.id, rank: "0/1" },
    archivedAt: null,
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
      archivedAt: null,
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

async function persistCommand(
  workspaceId: string,
  command: Command,
  profile: LocalProfile,
  storage: WorkspaceStorage,
): Promise<void> {
  await withWorkspaceMutation(workspaceId, async () => {
    const base = await latestWorkspaceDocument(workspaceId, storage);
    const next = await commitAuthorizedCommand(base, command, profile, storage);
    if (stateRuntime.activeDoc?.id === workspaceId) {
      updateReactiveState(next);
    }
    stateRuntime.storageChannel?.postMessage({ type: "workspace-persisted", workspaceId });
    notifyLocalChanges(workspaceId);
  });
}

async function latestWorkspaceDocument(
  workspaceId: string,
  storage: WorkspaceStorage,
): Promise<Automerge.Doc<WorkspaceDocumentV2>> {
  const local =
    stateRuntime.activeDoc?.id === workspaceId ? stateRuntime.activeDoc : null;
  const stored = (await storage.loadWorkspaceDoc(workspaceId, local ?? undefined))?.doc ?? null;
  if (!local && !stored) throw new Error("Workspace not hydrated");
  if (local && stored && Automerge.getHeads(local).sort().join() === Automerge.getHeads(stored).sort().join())
    return stored;
  return local && stored
    ? Automerge.merge(Automerge.clone(local), Automerge.clone(stored))
    : (local ?? (stored as Automerge.Doc<WorkspaceDocumentV2>));
}

function ensureContentWrite(role: WorkspaceRole): void {
  if (role === "visitor") assertWorkspaceCapability(role, "content.write");
}

async function reconcileWorkspace(storage: WorkspaceStorage, workspaceChanged = false,
  changedWorkspaceIds = new Set<string>(), workspaceUnknown = false): Promise<void> {
  const active = stateRuntime.activeDoc;
  if (!active) return;
  await refreshAvailableWorkspaces(storage);
  const loaded = await storage.loadWorkspaceDoc(active.id, active);
  const activeChanged = loaded &&
    Automerge.getHeads(active).sort().join(",") !== loaded.heads.join(",");
  if (activeChanged) updateReactiveState(loaded.doc);
  if (workspaceUnknown) {
    notifyLocalChanges();
    return;
  }
  const changedIds = new Set(changedWorkspaceIds);
  if (activeChanged) changedIds.add(active.id);
  for (const id of changedIds) notifyLocalChanges(id);
  if (workspaceChanged && changedIds.size === 0) notifyLocalChanges();
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

stateRuntime.storageChannel?.addEventListener("message", (event: MessageEvent<{ type?: unknown; workspaceId?: unknown }>) => {
  if (event.data?.type !== "workspace-persisted") return;
  void reconcile(defaultStorage, true,
    typeof event.data.workspaceId === "string" ? event.data.workspaceId : undefined);
});
if (typeof window !== "undefined") {
  window.addEventListener("focus", () => {
    void reconcile();
  });
  globalThis.document?.addEventListener("visibilitychange", () => {
    if (!globalThis.document.hidden) void reconcile();
  });
}
