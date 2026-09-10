import type {
  Board,
  Column,
  FieldDefinition,
  WorkspaceDocumentV2,
  WorkspaceEntity,
} from "./model"

export function createWorkspaceDoc(
  id: string,
  title: string,
  ownerPersonId: string,
  presetKey: "job-search" | "blank",
  nowIso = new Date().toISOString()
): WorkspaceDocumentV2 {
  const boardId = crypto.randomUUID()
  const entities: Record<string, WorkspaceEntity> = {}
  const bindings: Record<string, string> = {}

  if (presetKey === "blank") {
    const columns = [
      { key: "column.todo", title: "To do", rank: "0/1" },
      { key: "column.doing", title: "Doing", rank: "1/1" },
      { key: "column.done", title: "Done", rank: "2/1" },
    ]

    for (const col of columns) {
      const colId = crypto.randomUUID()
      bindings[col.key] = colId
      const colEntity: Column = {
        id: colId,
        kind: "column",
        title: col.title,
        placement: { parentId: boardId, rank: col.rank },
        displayHint: "normal",
        deleted: false,
        createdAt: nowIso,
        updatedAt: nowIso,
      }
      entities[colId] = colEntity
    }
  } else if (presetKey === "job-search") {
    const columns = [
      { key: "status.lead", title: "Lead", rank: "0/1", displayHint: "normal" as const },
      { key: "status.applied", title: "Applied", rank: "1/1", displayHint: "normal" as const },
      { key: "status.interview", title: "Interview", rank: "2/1", displayHint: "normal" as const },
      { key: "status.rejected", title: "Rejected", rank: "3/1", displayHint: "normal" as const },
      { key: "status.offer", title: "Offer", rank: "4/1", displayHint: "normal" as const },
      { key: "status.archived", title: "Archive", rank: "5/1", displayHint: "collapsed" as const },
    ]

    for (const col of columns) {
      const colId = crypto.randomUUID()
      bindings[col.key] = colId
      const colEntity: Column = {
        id: colId,
        kind: "column",
        title: col.title,
        placement: { parentId: boardId, rank: col.rank },
        displayHint: col.displayHint,
        deleted: false,
        createdAt: nowIso,
        updatedAt: nowIso,
      }
      entities[colId] = colEntity
    }

    // Seed fields
    const companyId = crypto.randomUUID()
    bindings["field.company"] = companyId
    entities[companyId] = {
      id: companyId,
      kind: "field",
      title: "Company",
      placement: { parentId: boardId, rank: "0/1" },
      deleted: false,
      createdAt: nowIso,
      updatedAt: nowIso,
      required: true,
      valueType: "text",
    }

    const roleId = crypto.randomUUID()
    bindings["field.role"] = roleId
    entities[roleId] = {
      id: roleId,
      kind: "field",
      title: "Role",
      placement: { parentId: boardId, rank: "1/1" },
      deleted: false,
      createdAt: nowIso,
      updatedAt: nowIso,
      required: true,
      valueType: "text",
    }

    const urlId = crypto.randomUUID()
    bindings["field.url"] = urlId
    entities[urlId] = {
      id: urlId,
      kind: "field",
      title: "URL",
      placement: { parentId: boardId, rank: "2/1" },
      deleted: false,
      createdAt: nowIso,
      updatedAt: nowIso,
      required: false,
      valueType: "url",
    }

    const locId = crypto.randomUUID()
    bindings["field.location"] = locId
    entities[locId] = {
      id: locId,
      kind: "field",
      title: "Location",
      placement: { parentId: boardId, rank: "3/1" },
      deleted: false,
      createdAt: nowIso,
      updatedAt: nowIso,
      required: false,
      valueType: "text",
    }

    // Work mode select
    const wmId = crypto.randomUUID()
    bindings["field.workMode"] = wmId
    const wmOptions: Record<string, { id: string; title: string; rank: string; deleted: boolean }> = {}
    const wmList = [
      { key: "option.workMode.remote", title: "Remote", rank: "0/1" },
      { key: "option.workMode.hybrid", title: "Hybrid", rank: "1/1" },
      { key: "option.workMode.onsite", title: "Onsite", rank: "2/1" },
      { key: "option.workMode.unknown", title: "Unknown", rank: "3/1" },
    ]
    for (const opt of wmList) {
      const optId = crypto.randomUUID()
      bindings[opt.key] = optId
      wmOptions[optId] = { id: optId, title: opt.title, rank: opt.rank, deleted: false }
    }
    entities[wmId] = {
      id: wmId,
      kind: "field",
      title: "Work mode",
      placement: { parentId: boardId, rank: "4/1" },
      deleted: false,
      createdAt: nowIso,
      updatedAt: nowIso,
      required: false,
      valueType: "select",
      options: wmOptions,
    }

    // Priority select
    const prioId = crypto.randomUUID()
    bindings["field.priority"] = prioId
    const prioOptions: Record<string, { id: string; title: string; rank: string; deleted: boolean }> = {}
    const prioList = [
      { key: "option.priority.p0", title: "P0", rank: "0/1" },
      { key: "option.priority.p1", title: "P1", rank: "1/1" },
      { key: "option.priority.p2", title: "P2", rank: "2/1" },
      { key: "option.priority.p3", title: "P3", rank: "3/1" },
    ]
    for (const opt of prioList) {
      const optId = crypto.randomUUID()
      bindings[opt.key] = optId
      prioOptions[optId] = { id: optId, title: opt.title, rank: opt.rank, deleted: false }
    }
    entities[prioId] = {
      id: prioId,
      kind: "field",
      title: "Priority",
      placement: { parentId: boardId, rank: "5/1" },
      deleted: false,
      createdAt: nowIso,
      updatedAt: nowIso,
      required: false,
      valueType: "select",
      options: prioOptions,
    }

    // Fit score
    const fitId = crypto.randomUUID()
    bindings["field.fitScore"] = fitId
    entities[fitId] = {
      id: fitId,
      kind: "field",
      title: "Fit score",
      placement: { parentId: boardId, rank: "6/1" },
      deleted: false,
      createdAt: nowIso,
      updatedAt: nowIso,
      required: false,
      valueType: "number",
      min: 0,
      max: 10,
    }

    // Notes
    const notesId = crypto.randomUUID()
    bindings["field.notes"] = notesId
    entities[notesId] = {
      id: notesId,
      kind: "field",
      title: "Notes",
      placement: { parentId: boardId, rank: "7/1" },
      deleted: false,
      createdAt: nowIso,
      updatedAt: nowIso,
      required: false,
      valueType: "text",
    }

    // Source text
    const srcId = crypto.randomUUID()
    bindings["field.sourceText"] = srcId
    entities[srcId] = {
      id: srcId,
      kind: "field",
      title: "Source text",
      placement: { parentId: boardId, rank: "8/1" },
      deleted: false,
      createdAt: nowIso,
      updatedAt: nowIso,
      required: false,
      valueType: "text",
    }

    // Rejection reason
    const rejId = crypto.randomUUID()
    bindings["field.rejectionReason"] = rejId
    entities[rejId] = {
      id: rejId,
      kind: "field",
      title: "Rejection reason",
      placement: { parentId: boardId, rank: "9/1" },
      deleted: false,
      createdAt: nowIso,
      updatedAt: nowIso,
      required: false,
      valueType: "text",
    }
  }

  const boardEntity: Board = {
    id: boardId,
    kind: "board",
    title,
    entityName: presetKey === "job-search" ? "lead" : "item",
    placement: { parentId: null, rank: "0/1" },
    deleted: false,
    createdAt: nowIso,
    updatedAt: nowIso,
    preset: {
      key: presetKey,
      version: 1,
      bindings,
    },
  }
  entities[boardId] = boardEntity

  return {
    kind: "workspace",
    formatVersion: 2,
    id,
    title,
    deleted: false,
    ownerPersonId,
    entities,
    migration: null,
  }
}
