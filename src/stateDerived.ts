import { hasEntityKind } from "./domain/model"
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
  type WorkspaceDocumentV2,
} from "./domain/model";
import { projectItemPriority } from "./domain/priority";
import { archivedItemsForBoard, isArchiveColumn } from "./domain/archive";
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
          (entity): entity is Board => hasEntityKind(entity, "board"),
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
  const placementIssues = computed(() => projectPlacementIssues());

  return {
    columns,
    activeBoard,
    isBlankBoard,
    genericColumns,
    boardFields,
    placementIssues,
  };
}

function projectGenericColumns(board: Board | null) {
  void stateRuntime.docVersion.value;
  const doc = stateRuntime.activeDoc;
  if (!doc || !board) return [];
  const archivedItems = archivedItemsForBoard(doc, board.id);
  return getChildren(doc.entities, board.id)
    .filter(
      (entity): entity is Column => hasEntityKind(entity, "column") && !entity.archivedAt,
    )
    .map((column) => ({
      ...column,
      items: (isArchiveColumn(column)
        ? archivedItems
        : getVisibleChildren(doc.entities, column.id).filter((entity): entity is Item => isItem(entity)))
        .map((sourceItem) => ({
          ...projectItemPriority(board, sourceItem, textNotesFieldId(doc.entities, board)),
          subitems: getChildren(doc.entities, sourceItem.id).filter(
            (entity): entity is Item => isItem(entity) && !entity.archivedAt,
          ),
        })),
    }));
}

function textNotesFieldId(entities: WorkspaceDocumentV2["entities"], board: Board): string | undefined {
  const id = board.preset?.bindings["field.notes"]
  return id && entities[id]?.kind === "field" && entities[id].valueType === "text" ? id : undefined
}

function projectBoardFields(board: Board | null): FieldDefinition[] {
  void stateRuntime.docVersion.value;
  const doc = stateRuntime.activeDoc;
  if (!doc || !board) return [];
  return Object.values(doc.entities).filter(
    (entity): entity is FieldDefinition =>
      hasEntityKind(entity, "field") &&
      entity.placement.parentId === board.id &&
      !entity.archivedAt,
  );
}

function projectPlacementIssues() {
  void stateRuntime.docVersion.value;
  return stateRuntime.activeDoc
    ? derivePlacementIssues(stateRuntime.activeDoc.entities)
    : [];
}
