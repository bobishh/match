import * as Automerge from "@automerge/automerge/slim";
import { bootstrapIdentity } from "./domain/identity";
import { commitAndPersist, reconcile, whenReady } from "./statePersistence";
import { stateRuntime } from "./stateContext";
import { createStateDerived } from "./stateDerived";
import { createWorkspaceActions } from "./stateWorkspaceActions";
import { createLeadActions } from "./stateLeadActions";
import { createContentActions } from "./stateContentActions";
import { createSyncActions } from "./stateSyncActions";

export function createMatchActions() {
  const derived = createStateDerived();
  return {
    workspace: stateRuntime.workspace,
    ready: stateRuntime.ready,
    saveState: stateRuntime.saveState,
    ...derived,
    availableWorkspaces: stateRuntime.availableWorkspaces,
    activeWorkspace: stateRuntime.activeWorkspaceMeta,
    docVersion: stateRuntime.docVersion,
    ...createWorkspaceActions(),
    ...createLeadActions(derived.activeBoard),
    ...createContentActions(),
    executeCommandAsync: commitAndPersist,
    getActiveDoc: () => stateRuntime.activeDoc,
    whenReady,
    getCurrentProfile: () => stateRuntime.currentProfile,
    refreshIdentity,
    reconcile,
    getAutomergeBytes: () =>
      stateRuntime.activeDoc
        ? Automerge.save(stateRuntime.activeDoc)
        : new Uint8Array(),
    ...createSyncActions(),
  };
}

async function refreshIdentity(): Promise<void> {
  stateRuntime.currentProfile = await bootstrapIdentity();
  stateRuntime.docVersion.value += 1;
}
