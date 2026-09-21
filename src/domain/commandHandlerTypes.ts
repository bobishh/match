import type * as Automerge from "@automerge/automerge/slim"
import type { Command } from "./commandTypes"
import type { CommandResult, Heads, WorkspaceDocumentV2 } from "./model"

export type CommandByKind<K extends Command["kind"]> = Extract<Command, { kind: K }>
type ApplyCommand = (draft: WorkspaceDocumentV2) => void
export type PreparedCommand = CommandResult<{ apply: ApplyCommand; changedEntityIds: string[] }>
export type CommandContext = { nowIso: string; beforeHeads: Heads }
export type CommandHandler<K extends Command["kind"]> = (doc: Automerge.Doc<WorkspaceDocumentV2>, command: CommandByKind<K>, context: CommandContext) => PreparedCommand
