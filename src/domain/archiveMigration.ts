import type * as Automerge from "@automerge/automerge/slim"
import type { WorkspaceDocumentV2 } from "./model"
import type { CommandHandler } from "./commandHandlerTypes"

type LegacyRecord = Record<string, unknown>

function needsTimestamp(record: LegacyRecord): boolean {
  return Object.hasOwn(record, "deleted") || !Object.hasOwn(record, "archivedAt")
}

export function needsArchiveMigration(doc: Automerge.Doc<WorkspaceDocumentV2>): boolean {
  if (needsTimestamp(doc as unknown as LegacyRecord)) return true
  return Object.values(doc.entities).some(entity => {
    if (needsTimestamp(entity as LegacyRecord)) return true
    if (entity.kind !== "field" || entity.valueType !== "select") return false
    return Object.values(entity.options).some(option => needsTimestamp(option as LegacyRecord))
  })
}

function migrateRecord(record: LegacyRecord, fallbackTimestamp: string): void {
  if (!Object.hasOwn(record, "archivedAt"))
    record.archivedAt = record.deleted === true ? fallbackTimestamp : null
  if (Object.hasOwn(record, "deleted")) delete record.deleted
}

export const migrateArchivedAt: CommandHandler<"migrateArchivedAt"> = (doc, _command, context) => ({
  ok: true,
  value: {
    changedEntityIds: Object.keys(doc.entities),
    apply: draft => {
      migrateRecord(draft as unknown as LegacyRecord, context.nowIso)
      for (const entity of Object.values(draft.entities)) {
        migrateRecord(entity as LegacyRecord, entity.updatedAt || context.nowIso)
        if (entity.kind === "field" && entity.valueType === "select")
          for (const option of Object.values(entity.options))
            migrateRecord(option as LegacyRecord, entity.updatedAt || context.nowIso)
      }
    },
  },
})
