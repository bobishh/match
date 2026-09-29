import { isItem, type AttachedDocument, type Board, type FieldValue, type WorkspaceEntity } from "./domain/model";
import { isInlineNarrativeNote } from "./domain/narrative";
import { commitAndPersist } from "./statePersistence";
import { stateRuntime } from "./stateContext";
import type { createStateDerived } from "./stateDerived";
import type { Lead, LeadInput, LeadStatus } from "./types";

type LeadInputWithId = LeadInput & { id?: string };

export function createLeadActions(
  activeBoard: ReturnType<typeof createStateDerived>["activeBoard"],
) {
  return {
    createLeadAsync,
    updateLeadAsync,
    moveLeadAsync,
    deleteLeadAsync,
  };

  async function createLeadAsync(input: LeadInputWithId): Promise<Lead> {
    const id = input.id ?? crypto.randomUUID();
    const values = leadValues(
      input,
      activeBoard.value?.priorityPolicy !== undefined,
    );
    const canonicalBody = distinctText([input.description ?? "", input.notes ?? ""]);
    await commitAndPersist({
      kind: "createItem",
      id,
      parentId: resolveColumnId(input.status),
      title: `${input.company} — ${input.role}`,
      body: canonicalBody,
      values,
    });
    return (
      stateRuntime.workspace.leads.find((lead) => lead.id === id) ??
      fallbackLead(id, input)
    );
  }

  async function updateLeadAsync(
    leadId: string,
    patch: Partial<LeadInput>,
  ): Promise<void> {
    if (!stateRuntime.activeDoc) return;
    const values = leadPatchValues(
      patch,
      activeBoard.value?.priorityPolicy !== undefined,
    );
    const existing = stateRuntime.workspace.leads.find(
      (lead) => lead.id === leadId,
    );
    const item = stateRuntime.activeDoc.entities[leadId];
    const notesFieldId = presetTextNotesFieldId();
    const noteSources = inlineNotesForLead(stateRuntime.activeDoc.entities, leadId);
    const canonicalBody = leadNarrativeBody(item, patch, notesFieldId, noteSources);
    if (notesFieldId) values[notesFieldId] = "";
    await commitAndPersist({
      kind: "patchItem",
      entityId: leadId,
      title: updatedLeadTitle(patch, existing),
      body: canonicalBody,
      values,
      ...(item && "body" in item ? { foldNarrativeSources: {
        expectedBody: item.body,
        ...(notesFieldId ? { notesFieldId, expectedNotes: item.values[notesFieldId] } : {}),
        notes: noteSources.map(({ id, title, content, format }) => ({ id, title, content, format })),
      } } : {}),
    });
  }

  async function moveLeadAsync(
    leadId: string,
    status: LeadStatus,
  ): Promise<void> {
    await commitAndPersist({
      kind: "moveEntity",
      entityId: leadId,
      parentId: resolveColumnId(status),
      beforeId: null,
    });
  }

  async function deleteLeadAsync(leadId: string): Promise<void> {
    await commitAndPersist({
      kind: "setEntityDeleted",
      entityId: leadId,
      deleted: true,
    });
  }
}

function inlineNotesForLead(entities: Record<string, WorkspaceEntity>, leadId: string): AttachedDocument[] {
  return Object.values(entities).filter((entity): entity is AttachedDocument =>
    entity.kind === "document" && entity.placement.parentId === leadId && !entity.deleted && isInlineNarrativeNote(entity))
}

function leadNarrativeBody(item: WorkspaceEntity | undefined, patch: Partial<LeadInput>, notesFieldId: string | undefined, notes: AttachedDocument[]): string {
  if (!isItem(item)) return distinctText([patch.description ?? "", patch.notes ?? ""])
  const legacyNotes = notesFieldId && typeof item.values[notesFieldId] === "string" ? item.values[notesFieldId] as string : ""
  return distinctText([patch.description ?? item.body, patch.notes ?? legacyNotes, ...notes.map(note => `## ${note.title}\n\n${note.content ?? ""}`)])
}

function leadValues(
  input: LeadInput,
  automaticPriority: boolean,
): Record<string, FieldValue> {
  const values: Record<string, FieldValue> = {};
  setStringLeadValues(values, input);
  setOptionalLeadValues(values, input, automaticPriority);
  return values;
}

function setStringLeadValues(
  values: Record<string, FieldValue>,
  input: LeadInput,
): void {
  setFieldValue(values, "company", input.company);
  setFieldValue(values, "role", input.role);
  setFieldValue(values, "url", input.url);
  setFieldValue(values, "location", input.location);
  setFieldValue(values, "rejectionReason", input.rejectionReason);
  setFieldValue(values, "sourceText", input.sourceText);
}

function setOptionalLeadValues(
  values: Record<string, FieldValue>,
  input: LeadInput,
  automaticPriority: boolean,
): void {
  if (!automaticPriority && input.fitScore !== undefined)
    setFieldValue(values, "fitScore", input.fitScore);
  setOptionValue(values, "workMode", input.workMode);
  if (!automaticPriority) setOptionValue(values, "priority", input.priority);
}

function leadPatchValues(
  patch: Partial<LeadInput>,
  automaticPriority: boolean,
): Record<string, FieldValue> {
  const values: Record<string, FieldValue> = {};
  setFieldValue(values, "company", patch.company);
  setFieldValue(values, "role", patch.role);
  setOptionValue(values, "workMode", patch.workMode);
  if (!automaticPriority) {
    setOptionValue(values, "priority", patch.priority);
    if (patch.fitScore !== undefined)
      setFieldValue(values, "fitScore", patch.fitScore);
  }
  setFieldValue(values, "rejectionReason", patch.rejectionReason);
  return values;
}

function setFieldValue(
  values: Record<string, FieldValue>,
  name: string,
  value: FieldValue | undefined,
): void {
  const id = resolveFieldId(name);
  if (id && value !== undefined && value !== "") values[id] = value;
}

function setOptionValue(
  values: Record<string, FieldValue>,
  field: string,
  value: string | undefined,
): void {
  if (!value) return;
  const fieldId = resolveFieldId(field);
  const optionId = resolveOptionId(field, value);
  if (fieldId && optionId) values[fieldId] = optionId;
}

function updatedLeadTitle(
  patch: Partial<LeadInput>,
  existing: Lead | undefined,
): string | undefined {
  const company = patch.company ?? existing?.company ?? "";
  const role = patch.role ?? existing?.role ?? "";
  return company && role ? `${company} — ${role}` : undefined;
}

function fallbackLead(id: string, input: LeadInput): Lead {
  const now = new Date().toISOString();
  return { id, ...input, createdAt: now, updatedAt: now };
}

function resolveColumnId(status: LeadStatus): string {
  const doc = stateRuntime.activeDoc;
  if (!doc) throw new Error("Not hydrated");
  const board = Object.values(doc.entities).find(
    (entity): entity is Board => entity.kind === "board",
  );
  const bound = board?.preset?.bindings[`status.${status}`];
  if (bound) return bound;
  const column = Object.values(doc.entities).find(
    (entity) =>
      entity.kind === "column" &&
      entity.title.toLowerCase() === status.toLowerCase(),
  );
  if (!column) throw new Error(`Column for status ${status} not found`);
  return column.id;
}

function resolveFieldId(name: string): string | undefined {
  return activeBoard()?.preset?.bindings[`field.${name}`];
}

function resolveOptionId(field: string, value: string): string | undefined {
  return activeBoard()?.preset?.bindings[`option.${field}.${value}`];
}

function activeBoard(): Board | undefined {
  return stateRuntime.activeDoc
    ? Object.values(stateRuntime.activeDoc.entities).find(
        (entity): entity is Board => entity.kind === "board",
      )
    : undefined;
}

function presetTextNotesFieldId(): string | undefined {
  const id = activeBoard()?.preset?.bindings["field.notes"];
  return id && stateRuntime.activeDoc?.entities[id]?.kind === "field" && stateRuntime.activeDoc.entities[id].valueType === "text" ? id : undefined;
}

function distinctText(parts: string[]): string {
  return [...new Set(parts.filter(part => part.length > 0))].join("\n\n");
}
