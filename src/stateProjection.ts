import type * as Automerge from "@automerge/automerge/slim";
import { isEntityVisible } from "./domain/ancestry";
import {
  isItem,
  type AttachedDocument,
  type Board,
  type Column,
  type DocumentTemplate,
  type Item,
  type LegacyWritingTemplate,
  type PdfArtifact,
  type WorkspaceDocumentV2,
  type WorkspaceEntity,
} from "./domain/model";
import { projectItemPriority } from "./domain/priority";
import type {
  Artifact,
  Document,
  Lead,
  LeadPriority,
  LeadStatus,
  Template,
  Workspace,
} from "./types";

type Bindings = {
  columnStatuses: Record<string, LeadStatus>;
  fieldNames: Record<string, string>;
  optionValues: Record<string, string>;
};

function invertBindings(bindings: Record<string, string>): Bindings {
  const result: Bindings = {
    columnStatuses: {},
    fieldNames: {},
    optionValues: {},
  };
  for (const [key, id] of Object.entries(bindings)) {
    if (key.startsWith("status."))
      result.columnStatuses[id] = key.slice("status.".length) as LeadStatus;
    if (key.startsWith("field."))
      result.fieldNames[id] = key.slice("field.".length);
    if (key.startsWith("option."))
      result.optionValues[id] = key.split(".").at(-1) ?? "";
  }
  return result;
}

function findColumn(
  entities: Record<string, WorkspaceEntity>,
  parentId: string | null,
): Column | undefined {
  let current = parentId ? entities[parentId] : undefined;
  const visited = new Set<string>();
  while (current && current.kind !== "column") {
    if (visited.has(current.id)) return undefined;
    visited.add(current.id);
    current = current.placement.parentId
      ? entities[current.placement.parentId]
      : undefined;
  }
  return current as Column | undefined;
}

function splitTitle(title: string): { company: string; role: string } {
  if (!title.includes(" — ")) return { company: title, role: "" };
  const [company, ...role] = title.split(" — ");
  return { company, role: role.join(" — ") };
}

function workMode(value: unknown): Lead["workMode"] {
  return ["remote", "hybrid", "onsite", "unknown"].includes(String(value))
    ? (String(value) as Lead["workMode"])
    : undefined;
}

function priority(value: unknown): LeadPriority | undefined {
  return ["p0", "p1", "p2", "p3"].includes(String(value))
    ? (String(value) as LeadPriority)
    : undefined;
}

function applyLeadValue(lead: Lead, fieldName: string, value: unknown): void {
  if (fieldName === "company") lead.company = String(value);
  else if (fieldName === "role") lead.role = String(value);
  else if (fieldName === "url") lead.url = String(value);
  else if (fieldName === "location") lead.location = String(value);
  else if (fieldName === "notes") lead.notes = String(value);
  else if (fieldName === "sourceText") lead.sourceText = String(value);
  else if (fieldName === "rejectionReason")
    lead.rejectionReason = String(value);
  else if (fieldName === "fitScore") lead.fitScore = Number(value);
  else if (fieldName === "workMode") lead.workMode = workMode(value);
  else if (fieldName === "priority") lead.priority = priority(value);
}

function projectLead(
  doc: Automerge.Doc<WorkspaceDocumentV2>,
  board: Board | undefined,
  source: Item,
  bindings: Bindings,
): Lead | undefined {
  const item = projectItemPriority(board, source);
  const column = findColumn(doc.entities, item.placement.parentId);
  if (!column) return undefined;
  const title = splitTitle(item.title);
  const lead: Lead = {
    id: item.id,
    company: title.company,
    role: title.role,
    status: bindings.columnStatuses[column.id] ?? "lead",
    description: item.body,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
  for (const [fieldId, rawValue] of Object.entries(item.values)) {
    const fieldName = bindings.fieldNames[fieldId];
    if (!fieldName || rawValue === null) continue;
    applyLeadValue(
      lead,
      fieldName,
      bindings.optionValues[String(rawValue)] ?? rawValue,
    );
  }
  return lead;
}

function localFileName(
  reference: AttachedDocument["file"] | PdfArtifact["pdf"],
): string | undefined {
  return reference?.type === "local-file" ? reference.fileName : undefined;
}

function projectDocuments(doc: Automerge.Doc<WorkspaceDocumentV2>): Document[] {
  return Object.values(doc.entities)
    .filter(
      (entity): entity is AttachedDocument =>
        entity.kind === "document" && !entity.deleted,
    )
    .map((document) => ({
      id: document.id,
      leadId: document.placement.parentId || "",
      kind: document.documentKind,
      title: document.title,
      format: document.format,
      content: document.content || undefined,
      file: document.file ?? undefined,
      localPath: localFileName(document.file),
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    }));
}

function projectTemplates(doc: Automerge.Doc<WorkspaceDocumentV2>): Template[] {
  return Object.values(doc.entities)
    .filter(
      (entity): entity is DocumentTemplate | LegacyWritingTemplate =>
        (entity.kind === "document_template" || entity.kind === "template") &&
        !entity.deleted,
    )
    .map((template) => ({
      id: template.id,
      name: template.title,
      markdown: template.markdown,
      createdAt: template.createdAt,
      updatedAt: template.updatedAt,
    }));
}

function projectArtifacts(doc: Automerge.Doc<WorkspaceDocumentV2>): Artifact[] {
  return Object.values(doc.entities)
    .filter(
      (entity): entity is PdfArtifact =>
        entity.kind === "artifact" && !entity.deleted,
    )
    .map((artifact) => ({
      id: artifact.id,
      leadId: artifact.placement.parentId || "",
      kind: artifact.artifactKind,
      title: artifact.title,
      templateId: artifact.templateId,
      pdfPath: localFileName(artifact.pdf) ?? artifact.pdf.fileName,
      sourceMarkdownPath: localFileName(artifact.sourceMarkdown),
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
    }));
}

export function projectWorkspace(
  doc: Automerge.Doc<WorkspaceDocumentV2>,
): Workspace {
  const board = Object.values(doc.entities).find(
    (entity): entity is Board => entity.kind === "board",
  );
  const bindings = invertBindings(board?.preset?.bindings ?? {});
  const leads = Object.values(doc.entities)
    .filter(
      (entity): entity is Item =>
        isItem(entity) && isEntityVisible(doc.entities, entity.id),
    )
    .map((item) => projectLead(doc, board, item, bindings))
    .filter((lead): lead is Lead => lead !== undefined);
  return {
    leads,
    documents: projectDocuments(doc),
    templates: projectTemplates(doc),
    artifacts: projectArtifacts(doc),
  };
}
