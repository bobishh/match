import { computed } from "vue";
import {
  derivePlacementIssues,
  getChildren,
  getVisibleChildren,
} from "./domain/ancestry";
import {
  isItem,
  type Board,
  type Column,
  type FieldDefinition,
  type Item,
} from "./domain/model";
import { projectItemPriority } from "./domain/priority";
import { stateRuntime } from "./stateContext";
import { statusOrder } from "./types";

export function createStateDerived() {
  const columns = computed(() =>
    statusOrder.map((status) => ({
      status,
      leads: stateRuntime.workspace.leads.filter(
        (lead) => lead.status === status,
      ),
    })),
  );

  const activeBoard = computed(() => {
    void stateRuntime.docVersion.value;
    return stateRuntime.activeDoc
      ? (Object.values(stateRuntime.activeDoc.entities).find(
          (entity): entity is Board => entity.kind === "board",
        ) ?? null)
      : null;
  });
  const isBlankBoard = computed(
    () => activeBoard.value?.preset?.key === "blank",
  );
  const genericColumns = computed(() =>
    projectGenericColumns(activeBoard.value),
  );
  const boardFields = computed(() => projectBoardFields(activeBoard.value));
  const trashItems = computed(() => projectTrashItems());
  const placementIssues = computed(() => projectPlacementIssues());

  return {
    columns,
    activeBoard,
    isBlankBoard,
    genericColumns,
    boardFields,
    trashItems,
    placementIssues,
  };
}

function projectGenericColumns(board: Board | null) {
  void stateRuntime.docVersion.value;
  const doc = stateRuntime.activeDoc;
  if (!doc || !board) return [];
  return getChildren(doc.entities, board.id)
    .filter(
      (entity): entity is Column => entity.kind === "column" && !entity.deleted,
    )
    .map((column) => ({
      ...column,
      items: getVisibleChildren(doc.entities, column.id)
        .filter((entity): entity is Item => isItem(entity))
        .map((sourceItem) => ({
          ...projectItemPriority(board, sourceItem),
          subitems: getChildren(doc.entities, sourceItem.id).filter(
            (entity): entity is Item => isItem(entity) && !entity.deleted,
          ),
        })),
    }));
}

function projectBoardFields(board: Board | null): FieldDefinition[] {
  void stateRuntime.docVersion.value;
  const doc = stateRuntime.activeDoc;
  if (!doc || !board) return [];
  return Object.values(doc.entities).filter(
    (entity): entity is FieldDefinition =>
      entity.kind === "field" &&
      entity.placement.parentId === board.id &&
      !entity.deleted,
  );
}

function projectTrashItems() {
  void stateRuntime.docVersion.value;
  return stateRuntime.activeDoc
    ? Object.values(stateRuntime.activeDoc.entities).filter(
        (entity) => entity.deleted,
      )
    : [];
}

function projectPlacementIssues() {
  void stateRuntime.docVersion.value;
  return stateRuntime.activeDoc
    ? derivePlacementIssues(stateRuntime.activeDoc.entities)
    : [];
}
