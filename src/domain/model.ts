export type EntityId = string
export type WorkspaceId = string
export type PersonId = string // base64url SHA-256(raw identity public key)
export type DeviceId = string // base64url SHA-256(raw device public key)
export type ActorId = string // Automerge writer ID, never reused by parallel writers
export type IsoTime = string
export type Rank = string // canonical reduced rational: signed numerator/positive denominator
export type Hash = string
export type Heads = Hash[]

export type Placement = Readonly<{ parentId: EntityId | null; rank: Rank }>

export type EntityBase = {
  id: EntityId
  title: string
  placement: Placement
  deleted: boolean
  createdAt: IsoTime
  updatedAt: IsoTime
}

export type Board = EntityBase & {
  kind: "board"
  entityName?: string
  preset: null | {
    key: "job-search" | "blank"
    version: 1
    bindings: Record<string, EntityId>
  }
}

export type Column = EntityBase & {
  kind: "column"
  displayHint: "normal" | "collapsed"
}

export type FieldValue = string | number | boolean | null

export type Task = EntityBase & {
  kind: "task"
  body: string
  values: Record<EntityId, FieldValue>
}

export type FieldOption = {
  id: EntityId
  title: string
  rank: Rank
  deleted: boolean
}

export type FieldDefinition = EntityBase & {
  kind: "field"
  required: boolean
} & (
  | { valueType: "text" | "url" | "date" | "boolean" }
  | { valueType: "number"; min: number | null; max: number | null }
  | { valueType: "select"; options: Record<EntityId, FieldOption> }
)

export type FileReference =
  | { type: "blob"; sha256: Hash; byteLength: number; mimeType: string; fileName: string }
  | { type: "local-file"; fileId: EntityId; fileName: string }

export type AttachedDocument = EntityBase & {
  kind: "document"
  documentKind: "cv" | "cover_letter" | "note" | "attachment"
  format: "markdown" | "html" | "pdf" | "path"
  content: string | null
  file: FileReference | null
}

export type DocumentTemplate = EntityBase & {
  kind: "document_template"
  markdown: string
}

// Read-only compatibility for documents written before document_template existed.
export type LegacyWritingTemplate = EntityBase & {
  kind: "template"
  markdown: string
  templateKind?: string
}

export type PdfArtifact = EntityBase & {
  kind: "artifact"
  artifactKind: "cv" | "cover_letter"
  templateId: EntityId
  pdf: FileReference
  sourceMarkdown: FileReference | null
}

export type WorkspaceEntity =
  | Board
  | Column
  | Task
  | FieldDefinition
  | AttachedDocument
  | DocumentTemplate
  | LegacyWritingTemplate
  | PdfArtifact

export type WorkspaceDocumentV2 = {
  kind: "workspace"
  formatVersion: 2
  id: WorkspaceId
  title: string
  deleted: boolean
  ownerPersonId: PersonId
  entities: Record<EntityId, WorkspaceEntity>
  migration: null | {
    migrationId: string
    sourceFormat: "match-0.0.1"
    sourceHeads: Heads
  }
  leads?: unknown[]
  documents?: unknown[]
  templates?: unknown[]
  artifacts?: unknown[]
}

export type PublicIdentity = {
  personId: PersonId
  publicKey: string // base64url raw Ed25519 public key
  displayName: string
}

export type RegisteredDevice = {
  deviceId: DeviceId
  publicKey: string
  displayName: string
  certificateHash: Hash
  addedAt: IsoTime
}

export type WorkspaceReference = {
  workspaceId: WorkspaceId
  documentId: string
  grantHash: Hash
  forgotten: boolean // own catalog scope only, not deletion of shared content
}

export type PersonalRootDocumentV1 = {
  kind: "personal-root"
  formatVersion: 1
  rootId: string
  identity: PublicIdentity
  devices: Record<DeviceId, RegisteredDevice>
  workspaces: Record<WorkspaceId, WorkspaceReference>
}

export type TransactionMetadataV1 = {
  version: 1
  transactionId: string
  action: string
  entityIds: EntityId[]
  personId: PersonId
  deviceId: DeviceId
}

export type SignedEnvelope<T> = {
  payload: T
  signerKeyId: PersonId | DeviceId
  signature: string // base64url signature of the canonical, domain-separated payload
}

export type DeviceCertificate = SignedEnvelope<{
  kind: "device-certificate"
  version: 1
  personId: PersonId
  deviceId: DeviceId
  devicePublicKey: string
  issuerCertificateHash: Hash | null // null means signed by identity authority
  canEnrollDevices: true
}>

export type ActorBinding = SignedEnvelope<{
  kind: "actor-binding"
  version: 1
  personId: PersonId
  deviceId: DeviceId
  documentId: string
  actorId: ActorId
}>

export type ChangeProof = SignedEnvelope<{
  kind: "change-proof"
  version: 1
  documentId: string
  changeHash: Hash
  actorBindingHash: Hash
}>

export type WorkspaceGrant = SignedEnvelope<{
  kind: "workspace-grant"
  version: 1
  grantId: string
  workspaceId: WorkspaceId
  personId: PersonId
  role: "owner" | "editor"
}>

export type WorkspaceGenesis = SignedEnvelope<{
  kind: "workspace-genesis"
  version: 1
  workspaceId: WorkspaceId
  ownerPersonId: PersonId
  initialHeads: Heads
  legacyCheckpoint: boolean
}>

export type InvitationBase = {
  protocolVersion: 1
  invitationId: string
  issuerPersonId: PersonId
  issuerDeviceId: DeviceId
  endpoint: string
  expiresAt: IsoTime
  secret: string // 32 random bytes, base64url; never stored in replicated content
}

export type Invitation = SignedEnvelope<InvitationBase & (
  | { kind: "device-enrollment"; rootId: string }
  | { kind: "workspace-join"; workspaceId: WorkspaceId; role: "editor" }
)>

export type LocalFileLocation = {
  fileId: EntityId
  deviceId: DeviceId
  path: string
}

export type ProjectionIssue =
  | { type: "missing-parent"; entityId: EntityId; parentId: EntityId }
  | { type: "invalid-parent-kind"; entityId: EntityId; parentId: EntityId | null }
  | { type: "cycle"; entityId: EntityId; cycleIds: EntityId[] }
  | { type: "invalid-field-value"; entityId: EntityId; fieldId: EntityId }

export type TransactionReceipt = {
  transactionId: string
  beforeHeads: Heads
  afterHeads: Heads
  changeHash: Hash
  changedEntityIds: EntityId[]
  saved: true
}

export type CommandErrorCode =
  | "invalid_input"
  | "not_found"
  | "invalid_parent"
  | "cycle"
  | "cross_board_move"
  | "field_type_change"
  | "hidden_ancestor"
  | "permission_denied"
  | "storage_failed"
  | "unsupported_format"
  | "conflict"
  | "identity_conflict"
  | "migration_conflict"
  | "invalid_proof"
  | "invite_expired"
  | "invite_consumed"
  | "invite_cancelled"

export type CommandResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: CommandErrorCode; message: string; field?: string } }

function err<T>(code: CommandErrorCode, message: string, field?: string): CommandResult<T> {
  return { ok: false, error: { code, message, field } }
}

function ok<T>(value: T): CommandResult<T> {
  return { ok: true, value }
}

function assertNoUnknownKeys(obj: Record<string, unknown>, allowedKeys: string[]): string | null {
  const allowed = new Set(allowedKeys)
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      return key
    }
  }
  return null
}

function gcdBigInt(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a
  let y = b < 0n ? -b : b
  while (y !== 0n) {
    const t = y
    y = x % y
    x = t
  }
  return x
}

export function isValidRank(rank: string): boolean {
  if (typeof rank !== "string") return false
  const match = rank.match(/^(-?\d+)\/(\d+)$/)
  if (!match) return false
  const numStr = match[1]
  const denStr = match[2]
  try {
    const num = BigInt(numStr)
    const den = BigInt(denStr)
    if (den <= 0n) return false
    // must be reduced: gcd(|num|, den) === 1
    if (num === 0n) {
      return den === 1n
    }
    return gcdBigInt(num, den) === 1n
  } catch {
    return false
  }
}

export function validatePlacement(placement: unknown): CommandResult<Placement> {
  if (!placement || typeof placement !== "object" || Array.isArray(placement)) {
    return err("invalid_input", "placement must be an object")
  }
  const p = placement as Record<string, unknown>
  const unknownKey = assertNoUnknownKeys(p, ["parentId", "rank"])
  if (unknownKey) {
    return err("invalid_input", `Unknown key in placement: ${unknownKey}`)
  }
  if (p.parentId !== null && typeof p.parentId !== "string") {
    return err("invalid_input", "parentId must be a string or null")
  }
  if (typeof p.rank !== "string" || !isValidRank(p.rank)) {
    return err("invalid_input", `Invalid canonical rank: ${p.rank}`)
  }
  return ok({ parentId: p.parentId as string | null, rank: p.rank })
}

export function validatePlacementParent(childKind: string, parentKind: string | null): CommandResult<void> {
  switch (childKind) {
    case "board":
      if (parentKind === null) return ok(undefined)
      return err("invalid_parent", "Board must have null parent")
    case "column":
      if (parentKind === "board") return ok(undefined)
      return err("invalid_parent", "Column parent must be a board")
    case "task":
      if (parentKind === "column" || parentKind === "task") return ok(undefined)
      return err("invalid_parent", "Task parent must be a column or task")
    case "field":
      if (parentKind === "board") return ok(undefined)
      return err("invalid_parent", "Field parent must be a board")
    case "document":
      if (parentKind === "task") return ok(undefined)
      return err("invalid_parent", "Document parent must be a task")
    case "document_template":
      if (parentKind === null) return ok(undefined)
      return err("invalid_parent", "Document template parent must be null")
    case "template":
      if (parentKind === null) return ok(undefined)
      return err("invalid_parent", "Legacy template parent must be null")
    case "artifact":
      if (parentKind === "task") return ok(undefined)
      return err("invalid_parent", "Artifact parent must be a task")
    default:
      return err("invalid_input", `Unknown entity kind: ${childKind}`)
  }
}

export function validateEntity(entity: unknown): CommandResult<WorkspaceEntity> {
  if (!entity || typeof entity !== "object" || Array.isArray(entity)) {
    return err("invalid_input", "Entity must be an object")
  }
  const e = entity as Record<string, unknown>
  if (typeof e.id !== "string" || !e.id) return err("invalid_input", "Entity id must be non-empty string", "id")
  if (typeof e.title !== "string") return err("invalid_input", "Entity title must be a string", "title")
  if (typeof e.deleted !== "boolean") return err("invalid_input", "Entity deleted must be boolean", "deleted")
  if (typeof e.createdAt !== "string") return err("invalid_input", "Entity createdAt must be string", "createdAt")
  if (typeof e.updatedAt !== "string") return err("invalid_input", "Entity updatedAt must be string", "updatedAt")

  const placementResult = validatePlacement(e.placement)
  if (!placementResult.ok) return placementResult

  const commonKeys = ["id", "kind", "title", "placement", "deleted", "createdAt", "updatedAt"]

  switch (e.kind) {
    case "board": {
      const unknownKey = assertNoUnknownKeys(e, [...commonKeys, "preset", "entityName"])
      if (unknownKey) return err("invalid_input", `Unknown key in board: ${unknownKey}`)
      if (e.entityName !== undefined && (typeof e.entityName !== "string" || !e.entityName.trim())) {
        return err("invalid_input", "board entityName must be a non-empty string")
      }
      if (e.preset !== null) {
        if (!e.preset || typeof e.preset !== "object" || Array.isArray(e.preset)) {
          return err("invalid_input", "board preset must be an object or null")
        }
        const presetObj = e.preset as Record<string, unknown>
        const presetUnknown = assertNoUnknownKeys(presetObj, ["key", "version", "bindings"])
        if (presetUnknown) return err("invalid_input", `Unknown key in preset: ${presetUnknown}`)
        if (presetObj.key !== "job-search" && presetObj.key !== "blank") {
          return err("invalid_input", "preset key must be 'job-search' or 'blank'")
        }
        if (presetObj.version !== 1) return err("invalid_input", "preset version must be 1")
        if (!presetObj.bindings || typeof presetObj.bindings !== "object" || Array.isArray(presetObj.bindings)) {
          return err("invalid_input", "preset bindings must be a map")
        }
      }
      return ok(e as unknown as Board)
    }
    case "column": {
      const unknownKey = assertNoUnknownKeys(e, [...commonKeys, "displayHint"])
      if (unknownKey) return err("invalid_input", `Unknown key in column: ${unknownKey}`)
      if (e.displayHint !== "normal" && e.displayHint !== "collapsed") {
        return err("invalid_input", "column displayHint must be 'normal' or 'collapsed'")
      }
      return ok(e as unknown as Column)
    }
    case "task": {
      const unknownKey = assertNoUnknownKeys(e, [...commonKeys, "body", "values"])
      if (unknownKey) return err("invalid_input", `Unknown key in task: ${unknownKey}`)
      if (typeof e.body !== "string") return err("invalid_input", "task body must be string")
      if (!e.values || typeof e.values !== "object" || Array.isArray(e.values)) {
        return err("invalid_input", "task values must be an object")
      }
      for (const [k, v] of Object.entries(e.values as Record<string, unknown>)) {
        if (v !== null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
          return err("invalid_input", `task value for field ${k} must be string, number, boolean, or null`)
        }
      }
      return ok(e as unknown as Task)
    }
    case "field": {
      const unknownKey = assertNoUnknownKeys(e, [...commonKeys, "required", "valueType", "min", "max", "options"])
      if (unknownKey) return err("invalid_input", `Unknown key in field: ${unknownKey}`)
      if (typeof e.required !== "boolean") return err("invalid_input", "field required must be boolean")
      const validTypes = ["text", "url", "date", "boolean", "number", "select"]
      if (!validTypes.includes(e.valueType as string)) {
        return err("invalid_input", `field valueType must be one of: ${validTypes.join(", ")}`)
      }
      if (e.valueType === "number") {
        if (e.min !== null && e.min !== undefined && typeof e.min !== "number") {
          return err("invalid_input", "number field min must be number or null")
        }
        if (e.max !== null && e.max !== undefined && typeof e.max !== "number") {
          return err("invalid_input", "number field max must be number or null")
        }
      }
      if (e.valueType === "select") {
        if (!e.options || typeof e.options !== "object" || Array.isArray(e.options)) {
          return err("invalid_input", "select field options must be an object")
        }
        for (const [optId, opt] of Object.entries(e.options as Record<string, unknown>)) {
          if (!opt || typeof opt !== "object" || Array.isArray(opt)) {
            return err("invalid_input", `select option ${optId} must be an object`)
          }
          const o = opt as Record<string, unknown>
          const optUnknown = assertNoUnknownKeys(o, ["id", "title", "rank", "deleted"])
          if (optUnknown) return err("invalid_input", `Unknown key in option: ${optUnknown}`)
          if (typeof o.id !== "string") return err("invalid_input", "option id must be string")
          if (typeof o.title !== "string") return err("invalid_input", "option title must be string")
          if (typeof o.deleted !== "boolean") return err("invalid_input", "option deleted must be boolean")
          if (typeof o.rank !== "string" || !isValidRank(o.rank)) {
            return err("invalid_input", `option rank invalid: ${o.rank}`)
          }
        }
      }
      return ok(e as unknown as FieldDefinition)
    }
    case "document": {
      const unknownKey = assertNoUnknownKeys(e, [...commonKeys, "documentKind", "format", "content", "file"])
      if (unknownKey) return err("invalid_input", `Unknown key in document: ${unknownKey}`)
      const validDocKinds = ["cv", "cover_letter", "note", "attachment"]
      if (!validDocKinds.includes(e.documentKind as string)) {
        return err("invalid_input", `documentKind must be one of: ${validDocKinds.join(", ")}`)
      }
      const validFormats = ["markdown", "html", "pdf", "path"]
      if (!validFormats.includes(e.format as string)) {
        return err("invalid_input", `document format must be one of: ${validFormats.join(", ")}`)
      }
      if (e.content !== null && typeof e.content !== "string") {
        return err("invalid_input", "document content must be string or null")
      }
      return ok(e as unknown as AttachedDocument)
    }
    case "document_template": {
      const unknownKey = assertNoUnknownKeys(e, [...commonKeys, "markdown"])
      if (unknownKey) return err("invalid_input", `Unknown key in document template: ${unknownKey}`)
      if (typeof e.markdown !== "string") return err("invalid_input", "template markdown must be string")
      return ok(e as unknown as DocumentTemplate)
    }
    case "template": {
      // Compatibility only. New writes use document_template and no type enum.
      const unknownKey = assertNoUnknownKeys(e, [...commonKeys, "markdown", "templateKind"])
      if (unknownKey) return err("invalid_input", `Unknown key in legacy template: ${unknownKey}`)
      if (typeof e.markdown !== "string") return err("invalid_input", "template markdown must be string")
      return ok(e as unknown as LegacyWritingTemplate)
    }
    case "artifact": {
      const unknownKey = assertNoUnknownKeys(e, [...commonKeys, "artifactKind", "templateId", "pdf", "sourceMarkdown"])
      if (unknownKey) return err("invalid_input", `Unknown key in artifact: ${unknownKey}`)
      const validArtKinds = ["cv", "cover_letter"]
      if (!validArtKinds.includes(e.artifactKind as string)) {
        return err("invalid_input", `artifactKind must be one of: ${validArtKinds.join(", ")}`)
      }
      if (typeof e.templateId !== "string") return err("invalid_input", "artifact templateId must be string")
      if (!e.pdf || typeof e.pdf !== "object") return err("invalid_input", "artifact pdf reference required")
      return ok(e as unknown as PdfArtifact)
    }
    default:
      return err("invalid_input", `Unknown entity kind: ${e.kind}`)
  }
}

export function validateWorkspaceDoc(doc: unknown): CommandResult<WorkspaceDocumentV2> {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return err("invalid_input", "Workspace document must be an object")
  }
  const d = doc as Record<string, unknown>
  if (d.kind !== "workspace") {
    return err("invalid_input", `Expected kind 'workspace', got '${d.kind}'`)
  }
  if (d.formatVersion !== 2) {
    return err("unsupported_format", `Unsupported formatVersion: ${d.formatVersion}. Supported is 2.`)
  }
  if (typeof d.id !== "string" || !d.id) {
    return err("invalid_input", "Workspace id must be non-empty string")
  }
  if (typeof d.title !== "string") {
    return err("invalid_input", "Workspace title must be string")
  }
  if (typeof d.deleted !== "boolean") {
    return err("invalid_input", "Workspace deleted must be boolean")
  }
  if (typeof d.ownerPersonId !== "string") {
    return err("invalid_input", "Workspace ownerPersonId must be string")
  }
  if (!d.entities || typeof d.entities !== "object" || Array.isArray(d.entities)) {
    return err("invalid_input", "Workspace entities must be an object map")
  }
  for (const [id, entity] of Object.entries(d.entities as Record<string, unknown>)) {
    const res = validateEntity(entity)
    if (!res.ok) {
      return err(res.error.code, `Entity ${id} invalid: ${res.error.message}`, res.error.field)
    }
  }

  return ok(d as unknown as WorkspaceDocumentV2)
}
