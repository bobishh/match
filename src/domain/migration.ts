import * as Automerge from "@automerge/automerge/slim"
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import type {
  CommandResult,
  WorkspaceDocumentV2,
  WorkspaceEntity,
  Task,
  Column,
  Board,
  FieldDefinition,
  AttachedDocument,
  DocumentTemplate,
  PdfArtifact,
  Heads,
  ChangeProof,
} from "./model"
import type { Workspace, Lead } from "../types"
import { createWorkspaceDoc } from "./seeds"
import { canonicalizeJson } from "./identity"

export type MigrationPlan = {
  migrationId: string
  workspaceId: string
  ownerPersonId: string
  title: string
  sourceHeads: Heads
  entities: Record<string, WorkspaceEntity>
}

export function createMigrationPlan(
  legacyWorkspace: Workspace,
  ownerPersonId: string,
  sourceHeads: Heads = []
): CommandResult<MigrationPlan> {
  const seenIds = new Map<string, string>() // id -> collection

  for (const lead of legacyWorkspace.leads) {
    if (seenIds.has(lead.id)) {
      return {
        ok: false,
        error: {
          code: "migration_conflict",
          message: `Duplicate ID across collections: ${lead.id} in leads and ${seenIds.get(lead.id)}`,
        },
      }
    }
    seenIds.set(lead.id, "leads")
  }

  for (const doc of legacyWorkspace.documents) {
    if (seenIds.has(doc.id)) {
      return {
        ok: false,
        error: {
          code: "migration_conflict",
          message: `Duplicate ID across collections: ${doc.id} in documents and ${seenIds.get(doc.id)}`,
        },
      }
    }
    seenIds.set(doc.id, "documents")
  }

  for (const tpl of legacyWorkspace.templates) {
    if (seenIds.has(tpl.id)) {
      return {
        ok: false,
        error: {
          code: "migration_conflict",
          message: `Duplicate ID across collections: ${tpl.id} in templates and ${seenIds.get(tpl.id)}`,
        },
      }
    }
    seenIds.set(tpl.id, "templates")
  }

  for (const art of legacyWorkspace.artifacts) {
    if (seenIds.has(art.id)) {
      return {
        ok: false,
        error: {
          code: "migration_conflict",
          message: `Duplicate ID across collections: ${art.id} in artifacts and ${seenIds.get(art.id)}`,
        },
      }
    }
    seenIds.set(art.id, "artifacts")
  }

  const migrationId = crypto.randomUUID()
  const workspaceId = crypto.randomUUID()
  const seeded = createWorkspaceDoc(workspaceId, "Job search", ownerPersonId, "job-search")

  const entities: Record<string, WorkspaceEntity> = { ...seeded.entities }
  const board = Object.values(entities).find((e): e is Board => e.kind === "board")!
  const bindings = board.preset!.bindings

  const leadColId = bindings["status.lead"]
  const appliedColId = bindings["status.applied"]
  const interviewColId = bindings["status.interview"]
  const rejectedColId = bindings["status.rejected"]
  const offerColId = bindings["status.offer"]
  const archiveColId = bindings["status.archived"]

  const statusMap: Record<string, string> = {
    lead: leadColId,
    applied: appliedColId,
    interview: interviewColId,
    rejected: rejectedColId,
    offer: offerColId,
    archived: archiveColId,
    bin: archiveColId,
  }

  // Handle any unknown statuses with an "Unsorted" column
  let unsortedColId: string | null = null
  for (const lead of legacyWorkspace.leads) {
    if (!statusMap[lead.status]) {
      if (!unsortedColId) {
        unsortedColId = crypto.randomUUID()
        const unsortedCol: Column = {
          id: unsortedColId,
          kind: "column",
          title: "Unsorted",
          placement: { parentId: board.id, rank: "5/1" },
          displayHint: "normal",
          deleted: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        entities[unsortedColId] = unsortedCol
        statusMap[lead.status] = unsortedColId
      }
    }
  }

  // Migrate leads into tasks
  let taskRank = 0
  for (const lead of legacyWorkspace.leads) {
    const parentId = statusMap[lead.status] || leadColId
    const values: Record<string, any> = {}

    if (lead.company) values[bindings["field.company"]] = lead.company
    if (lead.role) values[bindings["field.role"]] = lead.role
    if (lead.url) values[bindings["field.url"]] = lead.url
    if (lead.location) values[bindings["field.location"]] = lead.location
    if (lead.notes) values[bindings["field.notes"]] = lead.notes
    if (lead.sourceText) values[bindings["field.sourceText"]] = lead.sourceText
    if (lead.rejectionReason) values[bindings["field.rejectionReason"]] = lead.rejectionReason
    if (lead.fitScore !== undefined) values[bindings["field.fitScore"]] = lead.fitScore

    if (lead.workMode && bindings[`option.workMode.${lead.workMode}`]) {
      values[bindings["field.workMode"]] = bindings[`option.workMode.${lead.workMode}`]
    }
    if (lead.priority && bindings[`option.priority.${lead.priority}`]) {
      values[bindings["field.priority"]] = bindings[`option.priority.${lead.priority}`]
    }

    const task: Task = {
      id: lead.id,
      kind: "task",
      title: `${lead.company} — ${lead.role}`,
      body: lead.description || "",
      placement: { parentId, rank: `${taskRank++}/1` },
      deleted: false,
      createdAt: lead.createdAt || new Date().toISOString(),
      updatedAt: lead.updatedAt || new Date().toISOString(),
      values,
    }
    entities[lead.id] = task
  }

  // Migrate documents
  let docRank = 0
  for (const doc of legacyWorkspace.documents) {
    const attachedDoc: AttachedDocument = {
      id: doc.id,
      kind: "document",
      title: doc.title,
      documentKind: doc.kind,
      format: doc.format,
      content: doc.content || null,
      placement: { parentId: doc.leadId, rank: `${docRank++}/1` },
      deleted: false,
      createdAt: doc.createdAt || new Date().toISOString(),
      updatedAt: doc.updatedAt || new Date().toISOString(),
      file: doc.localPath
        ? { type: "local-file", fileId: crypto.randomUUID(), fileName: doc.localPath }
        : null,
    }
    entities[doc.id] = attachedDoc
  }

  // Migrate templates
  let tplRank = 0
  for (const tpl of legacyWorkspace.templates) {
    const template: DocumentTemplate = {
      id: tpl.id,
      kind: "document_template",
      title: tpl.name,
      markdown: tpl.markdown,
      placement: { parentId: null, rank: `${tplRank++}/1` },
      deleted: false,
      createdAt: tpl.createdAt || new Date().toISOString(),
      updatedAt: tpl.updatedAt || new Date().toISOString(),
    }
    entities[tpl.id] = template
  }

  // Migrate artifacts
  let artRank = 0
  for (const art of legacyWorkspace.artifacts) {
    const artifact: PdfArtifact = {
      id: art.id,
      kind: "artifact",
      title: art.title,
      artifactKind: art.kind,
      templateId: art.templateId,
      placement: { parentId: art.leadId, rank: `${artRank++}/1` },
      deleted: false,
      createdAt: art.createdAt || new Date().toISOString(),
      updatedAt: art.updatedAt || new Date().toISOString(),
      pdf: {
        type: "local-file",
        fileId: crypto.randomUUID(),
        fileName: art.pdfPath,
      },
      sourceMarkdown: art.sourceMarkdownPath
        ? { type: "local-file", fileId: crypto.randomUUID(), fileName: art.sourceMarkdownPath }
        : null,
    }
    entities[art.id] = artifact
  }

  return {
    ok: true,
    value: {
      migrationId,
      workspaceId,
      ownerPersonId,
      title: "Job search",
      sourceHeads,
      entities,
    },
  }
}

export function applyMigrationPlan(
  plan: MigrationPlan,
  legacyDoc: Automerge.Doc<any>
): Automerge.Doc<WorkspaceDocumentV2> {
  const resultDoc = Automerge.change<any>(
    legacyDoc,
    { message: `Migrate match-0.0.1 to v2 (${plan.migrationId})` },
    (draft) => {
      draft.kind = "workspace"
      draft.formatVersion = 2
      draft.id = plan.workspaceId
      draft.title = plan.title
      draft.deleted = false
      draft.ownerPersonId = plan.ownerPersonId
      draft.migration = {
        migrationId: plan.migrationId,
        sourceFormat: "match-0.0.1",
        sourceHeads: plan.sourceHeads,
      }
      draft.entities = plan.entities
    }
  )

  return resultDoc as Automerge.Doc<WorkspaceDocumentV2>
}

export async function exportWorkspaceBundleV2(
  doc: WorkspaceDocumentV2,
  proofs: ChangeProof[] = []
): Promise<Uint8Array> {
  const heads = Automerge.getHeads(doc as Automerge.Doc<WorkspaceDocumentV2>).sort()
  const manifest = {
    format: "match",
    version: 2,
    workspaceId: doc.id,
    heads,
    includedBlobHashes: [],
    missingBlobHashes: [],
    proofFormatVersion: 1,
    exportedAt: new Date().toISOString(),
  }

  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
    "workspace.automerge": Automerge.save(doc as Automerge.Doc<WorkspaceDocumentV2>),
    "workspace.json": strToU8(canonicalizeJson(doc)),
    "proofs.json": strToU8(JSON.stringify(proofs, null, 2)),
  }

  return zipSync(files)
}

export async function readWorkspaceBundleV2(
  bundleBytes: Uint8Array
): Promise<CommandResult<{ doc: WorkspaceDocumentV2; manifest: any; proofs: ChangeProof[] }>> {
  let archive: Record<string, Uint8Array>
  try {
    archive = unzipSync(bundleBytes)
  } catch (e) {
    return { ok: false, error: { code: "unsupported_format", message: "Failed to unzip bundle" } }
  }

  const manifestFile = archive["manifest.json"]
  const automergeFile = archive["workspace.automerge"]

  if (!manifestFile || !automergeFile) {
    return { ok: false, error: { code: "unsupported_format", message: "Invalid bundle structure" } }
  }

  let manifest: any
  try {
    manifest = JSON.parse(strFromU8(manifestFile))
  } catch {
    return { ok: false, error: { code: "unsupported_format", message: "Corrupt manifest.json" } }
  }

  if (manifest.format !== "match" || manifest.version !== 2) {
    return {
      ok: false,
      error: { code: "unsupported_format", message: `Unsupported bundle format ${manifest.format} v${manifest.version}` },
    }
  }

  let doc: Automerge.Doc<WorkspaceDocumentV2>
  try {
    doc = Automerge.load<WorkspaceDocumentV2>(automergeFile)
  } catch {
    return { ok: false, error: { code: "unsupported_format", message: "Corrupt workspace.automerge bytes" } }
  }

  if (manifest.workspaceId !== doc.id) {
    return {
      ok: false,
      error: { code: "unsupported_format", message: "Manifest workspaceId does not match document" },
    }
  }

  let proofs: ChangeProof[] = []
  if (archive["proofs.json"]) {
    try {
      proofs = JSON.parse(strFromU8(archive["proofs.json"]))
    } catch {
      proofs = []
    }
  }

  return {
    ok: true,
    value: { doc, manifest, proofs },
  }
}
