import type { WorkspaceDocumentV2 } from "../contracts/model"

/** Shape fixture only. Identity is a placeholder; no authorization is implied. */
const boardId = "10000000-0000-4000-8000-000000000001"
const todoId = "10000000-0000-4000-8000-000000000002"
const doingId = "10000000-0000-4000-8000-000000000003"
const doneId = "10000000-0000-4000-8000-000000000004"
const authorId = "10000000-0000-4000-8000-000000000005"
const taskId = "10000000-0000-4000-8000-000000000006"
const subtaskId = "10000000-0000-4000-8000-000000000007"
const timestamps = {
  createdAt: "2026-09-09T12:00:00.000Z",
  updatedAt: "2026-09-09T12:00:00.000Z",
}

export const readingWorkspace = {
  kind: "workspace",
  formatVersion: 2,
  id: "10000000-0000-4000-8000-000000000000",
  title: "Reading",
  ownerPersonId: "fixture-person-not-a-real-key-fingerprint",
  deleted: false,
  migration: null,
  entities: {
    [boardId]: {
      id: boardId, kind: "board", title: "Reading", deleted: false,
      placement: { parentId: null, rank: "0/1" }, ...timestamps,
      preset: { key: "blank", version: 1, bindings: {} },
    },
    [todoId]: {
      id: todoId, kind: "column", title: "To read", deleted: false,
      placement: { parentId: boardId, rank: "0/1" }, ...timestamps,
      displayHint: "normal",
    },
    [doingId]: {
      id: doingId, kind: "column", title: "Reading", deleted: false,
      placement: { parentId: boardId, rank: "1/1" }, ...timestamps,
      displayHint: "normal",
    },
    [doneId]: {
      id: doneId, kind: "column", title: "Finished", deleted: false,
      placement: { parentId: boardId, rank: "2/1" }, ...timestamps,
      displayHint: "normal",
    },
    [authorId]: {
      id: authorId, kind: "field", title: "Author", deleted: false,
      placement: { parentId: boardId, rank: "0/1" }, ...timestamps,
      valueType: "text", required: false,
    },
    [taskId]: {
      id: taskId, kind: "task", title: "Designing Data-Intensive Applications",
      placement: { parentId: doingId, rank: "0/1" }, ...timestamps,
      deleted: false, body: "Read and record useful ideas.",
      values: { [authorId]: "Martin Kleppmann" },
    },
    [subtaskId]: {
      id: subtaskId, kind: "task", title: "Notes on replication",
      placement: { parentId: taskId, rank: "0/1" }, ...timestamps,
      deleted: false, body: "", values: {},
    },
  },
} satisfies WorkspaceDocumentV2

// Deleting doingId changes only that column's deleted flag.
// Both tasks then disappear from normal views; their flags and placements stay.
// Restoring doingId reveals both unless either was independently soft-deleted.
// Renaming Author changes one field record; task values remain keyed by authorId.
