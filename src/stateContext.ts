import type * as Automerge from "@automerge/automerge/slim";
import { reactive, ref, type Ref } from "vue";
import type { LocalProfile } from "./domain/identity";
import type { WorkspaceDocumentV2 } from "./domain/model";
import type { Workspace } from "./types";

type WorkspaceSummary = { id: string; title: string; updatedAt: string };
type ActiveWorkspaceMeta = {
  id: string;
  title: string;
  presetKey: "job-search" | "blank";
};

export type StateRuntime = {
  workspace: Workspace;
  ready: { value: boolean };
  saveState: Ref<"idle" | "saving" | "saved" | "error">;
  docVersion: Ref<number>;
  availableWorkspaces: Ref<WorkspaceSummary[]>;
  activeWorkspaceMeta: ActiveWorkspaceMeta;
  activeDoc: Automerge.Doc<WorkspaceDocumentV2> | null;
  currentProfile: LocalProfile | null;
  pendingWrites: number;
  batchSaveFailed: boolean;
  workspaceCommandQueues: Map<string, Promise<void>>;
  localChangeListeners: Set<() => void>;
  storageChannel: BroadcastChannel | undefined;
  reconcilePromise: Promise<void> | undefined;
};

export const stateRuntime: StateRuntime = {
  workspace: reactive<Workspace>({
    leads: [],
    documents: [],
    templates: [],
    artifacts: [],
  }),
  ready: reactive({ value: false }),
  saveState: ref("idle"),
  docVersion: ref(0),
  availableWorkspaces: ref([]),
  activeWorkspaceMeta: reactive({
    id: "",
    title: "Untitled",
    presetKey: "blank",
  }),
  activeDoc: null,
  currentProfile: null,
  pendingWrites: 0,
  batchSaveFailed: false,
  workspaceCommandQueues: new Map(),
  localChangeListeners: new Set(),
  storageChannel:
    typeof BroadcastChannel === "undefined"
      ? undefined
      : new BroadcastChannel("match-workspace"),
  reconcilePromise: undefined,
};
