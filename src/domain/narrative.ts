import type { AttachedDocument, Item } from "./model"
import type { NarrativeFoldSources } from "./commandTypes"

export type NarrativeNoteSource = { id: string; title: string; content: string | null; format: string; documentKind?: string; kind?: string; file?: unknown }

export function isInlineNarrativeNote(note: NarrativeNoteSource): boolean {
  return (note.documentKind ?? note.kind) === "note" && note.file == null && (note.format === "markdown" || note.format === "html")
}

export function itemNarrative(item: Item, notesFieldId?: string, notes: NarrativeNoteSource[] = []): string {
  const parts = [item.body, typeof item.values[notesFieldId ?? ""] === "string" ? item.values[notesFieldId ?? ""] as string : ""]
  for (const note of notes) {
    if (!isInlineNarrativeNote(note)) continue
    parts.push(`## ${note.title}\n\n${note.content ?? ""}`)
  }
  const unique = [...new Set(parts.filter(part => part.length > 0))]
  return unique.join("\n\n")
}

export function snapshotNarrativeSources(item: Item, notesFieldId: string | undefined, documents: AttachedDocument[]): NarrativeFoldSources {
  const notes = documents.filter(note => note.placement.parentId === item.id && !note.archivedAt && isInlineNarrativeNote(note))
  return {
    expectedBody: item.body,
    ...(notesFieldId ? { notesFieldId, expectedNotes: item.values[notesFieldId] } : {}),
    notes: notes.map(({ id, title, content, format }) => ({ id, title, content, format })),
  }
}
