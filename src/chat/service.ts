import { bootstrapIdentity, renameIdentity, type LocalProfile } from "../domain/identity"
import { defaultProofStore } from "../domain/proofs"
import { chatStore, type StoredChatMessage, type StoredChatProfile } from "./store"
import { createChatRecord, verifyChatRecord, type ChatRecord, type ChatAuthority } from "./records"
import { normalizeDisplayName, validateDisplayName } from "./names"
import { peerStore } from "../sync/peerStore"
import type { DeviceCertificate, WorkspaceGrant } from "../domain/model"

export type ChatChange = { workspaceId: string; added: StoredChatMessage[]; remote: boolean; history: boolean; typing?: ChatRecord[] }
export type ChatTyping = { personId: string; deviceId: string }
const listeners = new Set<(event: ChatChange) => void>()
const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("match-chat")
const typingTtlMs = 6_000
const typingRecords = new Map<string, Map<string, { record: ChatRecord; receivedAt: number }>>()
let readOwner: (workspaceId: string) => Promise<string> = async () => { throw new Error("Workspace unavailable") }
let readScope: (workspaceId: string) => Promise<string> = async id => id

function publish(event: ChatChange) {
  for (const listener of listeners) listener(event)
  channel?.postMessage(event)
}
channel?.addEventListener("message", event => {
  const change = event.data as ChatChange
  if (typeof change?.workspaceId === "string" && Array.isArray(change.added)) {
    for (const record of change.typing ?? []) rememberTyping(change.workspaceId, record)
    for (const listener of listeners) listener(change)
  }
})

export function configureChat(owner: typeof readOwner, scope: typeof readScope) { readOwner = owner; readScope = scope }
export function subscribeChat(listener: (event: ChatChange) => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export async function loadChat(workspaceId: string) { return chatStore.load(await readScope(workspaceId)) }
export async function readChatCursor(workspaceId: string) { return chatStore.readCursor(await readScope(workspaceId)) }
export async function markChatRead(workspaceId: string, cursor: string) { return chatStore.markRead(await readScope(workspaceId), cursor) }

function rememberTyping(workspaceId: string, record: ChatRecord) {
  const payload = record?.signed?.payload
  if (payload?.kind !== "chat-typing" || payload.workspaceId === "" || !payload.deviceId) return false
  const byDevice = typingRecords.get(workspaceId) ?? new Map<string, { record: ChatRecord; receivedAt: number }>()
  const previous = byDevice.get(payload.deviceId)?.record
  const previousOrder = previous ? `${previous.signed.payload.createdAt}:${previous.signed.signature}` : ""
  const nextOrder = `${payload.createdAt}:${record.signed.signature}`
  if (previousOrder >= nextOrder) return false
  byDevice.set(payload.deviceId, { record, receivedAt: Date.now() })
  typingRecords.set(workspaceId, byDevice)
  return true
}

export function loadChatTyping(workspaceId: string): ChatTyping[] {
  const now = Date.now()
  const byDevice = typingRecords.get(workspaceId)
  if (!byDevice) return []
  const result: ChatTyping[] = []
  for (const [deviceId, state] of byDevice) {
    if (now - state.receivedAt >= typingTtlMs) { byDevice.delete(deviceId); continue }
    const payload = state.record.signed.payload
    if (payload.text === "typing") result.push({ personId: payload.personId, deviceId: payload.deviceId })
  }
  return result
}

function message(record: ChatRecord): StoredChatMessage {
  const p = record.signed.payload
  return { id: p.id, workspaceId: p.workspaceId, personId: p.personId, createdAt: p.createdAt, body: p.text, record }
}
function member(record: ChatRecord): StoredChatProfile {
  const p = record.signed.payload
  return { workspaceId: p.workspaceId, personId: p.personId, name: p.text, revision: p.revision, record }
}

async function credentials(workspaceId: string, profile: LocalProfile): Promise<ChatAuthority> {
  const credential = typeof indexedDB === "undefined" ? null : await peerStore.getWorkspaceCredential(workspaceId)
  const authority = credential ?? (typeof indexedDB === "undefined" ? null : await peerStore.getWorkspaceAuthority(workspaceId).catch(() => null))
  const owner = authority?.ownerPersonId ?? await readOwner(workspaceId)
  const certificates = await defaultProofStore.listCertificates()
  if (owner === profile.identity.personId) return {
    publicKey: authority?.ownerPublicKey ?? profile.identity.publicKey,
    certificates: authority ? authority.ownerCertificates as DeviceCertificate[] : certificates.filter(c => c.payload.personId === owner),
  }
  const saved = await loadChat(workspaceId)
  const source = saved.profiles.map(p => p.record as ChatRecord).find(r => r?.authority?.publicKey)
  const grant = (authority?.localGrant as WorkspaceGrant | undefined) ??
    (await defaultProofStore.listGrants(workspaceId)).find(g => g.payload.personId === profile.identity.personId)
  if (!grant) throw new Error("Connect to the workspace owner once to enable chat")
  if (authority) return { publicKey: authority.ownerPublicKey,
    certificates: authority.ownerCertificates as DeviceCertificate[], grant }
  if (!source) throw new Error("Connect to the workspace owner once to enable chat")
  return { ...source.authority, grant }
}

async function signed(workspaceId: string, kind: "chat-message" | "chat-profile" | "chat-typing", text: string, revision = 0) {
  const profile = await bootstrapIdentity()
  const chain = (await defaultProofStore.listCertificates()).filter(c => c.payload.personId === profile.identity.personId)
  if (!chain.some(c => c.payload.deviceId === profile.device.deviceId)) chain.push(profile.certificate)
  const scope = await readScope(workspaceId)
  const record = await createChatRecord(profile, chain, await credentials(workspaceId, profile), scope, kind, text, revision)
  return verifyChatRecord(record, scope, await readOwner(workspaceId), workspaceId)
}

async function exclusive<T>(workspaceId: string, action: () => Promise<T>): Promise<T> {
  return navigator.locks.request(`match-chat-write:${workspaceId}`, action)
}

export async function ensureChatProfile(workspaceId: string) {
  return exclusive(workspaceId, async () => {
    const profile = await bootstrapIdentity()
    const own = (await loadChat(workspaceId)).profiles.find(p => p.personId === profile.identity.personId)
    if (own?.name === profile.identity.displayName) return own
    const value = member(await signed(workspaceId, "chat-profile", profile.identity.displayName, (own?.revision ?? 0) + 1))
    await chatStore.putProfile(value)
    publish({ workspaceId, added: [], remote: false, history: true })
    return value
  })
}

export async function renameChatProfile(workspaceId: string, name: string) {
  name = normalizeDisplayName(name)
  const error = validateDisplayName(name)
  if (error) throw new Error(error)
  await renameIdentity(name)
  await ensureChatProfile(workspaceId)
}

export async function sendChatMessage(workspaceId: string, body: string) {
  const text = body.trim()
  if (!text || [...text].length > 8000) throw new Error("Message must contain 1–8,000 characters")
  await ensureChatProfile(workspaceId)
  const value = message(await signed(workspaceId, "chat-message", text))
  if (await chatStore.append(value)) publish({ workspaceId, added: [value], remote: false, history: false })
}

export async function sendChatTyping(workspaceId: string, active: boolean) {
  await ensureChatProfile(workspaceId)
  const record = await signed(workspaceId, "chat-typing", active ? "typing" : "idle", Date.now())
  rememberTyping(workspaceId, record)
  publish({ workspaceId, added: [], remote: false, history: false, typing: [record] })
}

export async function exportChat(workspaceId: string, known?: Set<string>): Promise<{ version: 1; messages: unknown[]; profiles: unknown[]; typing: unknown[] }> {
  // Existing installations may not yet have received owner credentials. Do not interrupt board sync.
  try { await ensureChatProfile(workspaceId) } catch { /* A received profile will supply owner credentials. */ }
  const snapshot = await loadChat(workspaceId)
  if (known && known.size > 4096) known.clear()
  const unseen = (value: unknown) => {
    const record = value as ChatRecord
    const key = record.signed.signature
    if (known?.has(key)) return false
    known?.add(key)
    return true
  }
  const activeTyping = [...(typingRecords.get(workspaceId)?.values() ?? [])]
    .filter(state => Date.now() - state.receivedAt < typingTtlMs).map(state => state.record)
  return { version: 1, messages: snapshot.messages.map(m => m.record).filter(unseen),
    profiles: snapshot.profiles.map(p => p.record).filter(unseen), typing: activeTyping.filter(unseen) }
}

type ChatWire = { version: 1; messages: unknown[]; profiles: unknown[]; typing: unknown[] }

function parseChatWire(value: unknown): ChatWire {
  const wire = value as Partial<ChatWire>
  if (wire.version !== 1 || !Array.isArray(wire.messages) || !Array.isArray(wire.profiles)) {
    throw new Error("Invalid chat batch")
  }
  if (wire.typing !== undefined && !Array.isArray(wire.typing)) throw new Error("Invalid chat batch")
  const messages = wire.messages
  const profiles = wire.profiles
  const typing = wire.typing ?? []
  if (messages.length > 2000 || profiles.length > 512 || typing.length > 512) {
    throw new Error("Invalid chat batch")
  }
  if (new TextEncoder().encode(JSON.stringify(wire)).byteLength > 8 * 1024 * 1024) {
    throw new Error("Invalid chat batch")
  }
  return { version: 1, messages, profiles, typing }
}

function rejectRecord(workspaceId: string, section: string, error: unknown): void {
  console.warn("[match.chat]", JSON.stringify({
    event: "record.rejected", workspaceId, section,
    reason: error instanceof Error ? error.message : String(error),
  }))
}

async function verifiedRecords(
  items: unknown[],
  kind: ChatRecord["signed"]["payload"]["kind"],
  scope: string,
  owner: string,
  workspaceId: string,
): Promise<ChatRecord[]> {
  const records: ChatRecord[] = []
  for (const item of items) {
    try {
      const record = await verifyChatRecord(item, scope, owner, workspaceId)
      if (record.signed.payload.kind !== kind) throw new Error(`Invalid ${kind}`)
      records.push(record)
    } catch (error) {
      rejectRecord(workspaceId, kind, error)
    }
  }
  return records
}

export async function receiveChat(workspaceId: string, value: unknown, history: boolean) {
  const wire = parseChatWire(value)
  const owner = await readOwner(workspaceId)
  const scope = await readScope(workspaceId)
  const profileRecords = await verifiedRecords(wire.profiles, "chat-profile", scope, owner, workspaceId)
  const messageRecords = await verifiedRecords(wire.messages, "chat-message", scope, owner, workspaceId)
  const typingRecords = await verifiedRecords(wire.typing, "chat-typing", scope, owner, workspaceId)
  const profiles = profileRecords.map(member)
  const messages = messageRecords.map(message)
  const typing = typingRecords.filter(record => rememberTyping(workspaceId, record))
  const result = await chatStore.merge(scope, messages, profiles)
  if (result.changed || typing.length) publish({ workspaceId, added: result.added, remote: true, history, typing })
}
