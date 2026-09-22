import * as Automerge from "@automerge/automerge/slim"
import { validateWorkspaceDoc, type WorkspaceDocumentV2 } from "./model"

type LegacyTask = { kind?: unknown }

/**
 * Converts the short-lived `kind: "task"` discriminator into the canonical
 * structural item representation.  The old changes stay in Automerge history;
 * this produces one new, auditable deletion-only change.
 */
export function migrateLegacyTaskItems(
  doc: Automerge.Doc<WorkspaceDocumentV2>,
): Automerge.Doc<WorkspaceDocumentV2> | null {
  const legacyIds = Object.entries(doc.entities)
    .filter(([, entity]) => (entity as LegacyTask).kind === "task")
    .map(([id]) => id)
  if (legacyIds.length === 0) return null

  const migrated = Automerge.change(
    Automerge.clone(doc),
    { message: "Migrate legacy task cards to items" },
    (draft) => {
      for (const id of legacyIds)
        delete (draft.entities[id] as LegacyTask).kind
    },
  )
  const validation = validateWorkspaceDoc(migrated)
  if (!validation.ok)
    throw new Error(
      `Legacy task migration did not produce a valid workspace: ${validation.error.message}`,
    )
  return migrated
}
