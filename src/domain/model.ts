export type EntityId = string
export type WorkspaceId = string
export type PersonId = string // base64url SHA-256(raw identity public key)
export type DeviceId = string // base64url SHA-256(raw device public key)
export type ActorId = string // Automerge writer ID, never reused by parallel writers
export type IsoTime = string
export type Rank = string // canonical reduced rational: signed numerator/positive denominator
export type Hash = string
export type Heads = Hash[]

export type { Placement, EntityBase, Board, Column, FieldValue, PriorityRule, PriorityBand, PriorityPolicy, Task, FieldOption, FieldDefinition, FileReference, AttachedDocument, DocumentTemplate, LegacyWritingTemplate, PdfArtifact, WorkspaceEntity, WorkspaceDocumentV2 } from "./entitySchemas"
import type { WorkspaceEntity } from "./entitySchemas"
export { isValidRank } from "./rank"
export { validatePlacement, validatePlacementParent, validateEntity, validateWorkspaceDoc } from "./validation"

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
  role: "owner" | "editor" | "visitor"
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
