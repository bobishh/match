import type { StoredChatMessage } from "./storePolicy"

export type AnchorSelection = { exact: string; prefix: string; suffix: string; start: number; end: number }
export type Anchor = { workspaceScope: string; boardId: string; itemId: string; fieldId?: string; selection?: AnchorSelection }
export type MessageContext = { references: Anchor[]; mentions: string[]; replyTo?: string; conversationRootId?: string }
export const MAX_REFERENCES = 8
export const MAX_MENTIONS = 32
export const MAX_QUOTE_LENGTH = 2000
export const MAX_QUOTE_CONTEXT = 80

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) }
function boundedId(value: unknown, max = 256): value is string { return typeof value === "string" && value.length > 0 && value.length <= max }
function invalid(): never { throw new Error("Invalid message context") }
function keys(value: Record<string, unknown>, allowed: string[]) { if (Object.keys(value).some(key => !allowed.includes(key))) invalid() }

function validateSelection(value: unknown, fieldId: unknown): void {
  if (!object(value) || !boundedId(fieldId)) invalid()
  keys(value, ["exact", "prefix", "suffix", "start", "end"])
  if (!boundedId(value.exact, MAX_QUOTE_LENGTH)) invalid()
  if (typeof value.prefix !== "string" || value.prefix.length > MAX_QUOTE_CONTEXT) invalid()
  if (typeof value.suffix !== "string" || value.suffix.length > MAX_QUOTE_CONTEXT) invalid()
  if (!Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end)) invalid()
  if ((value.start as number) < 0 || (value.end as number) - (value.start as number) !== value.exact.length) invalid()
}
function validateAnchor(value: unknown, scope: string): void {
  if (!object(value)) invalid()
  keys(value, ["workspaceScope", "boardId", "itemId", "fieldId", "selection"])
  if (value.workspaceScope !== scope || !boundedId(value.boardId) || !boundedId(value.itemId)) invalid()
  if (value.fieldId !== undefined && !boundedId(value.fieldId)) invalid()
  if (value.selection !== undefined) validateSelection(value.selection, value.fieldId)
}
function validateReply(value: Record<string, unknown>, messageId?: string): void {
  if ((value.replyTo === undefined) !== (value.conversationRootId === undefined)) invalid()
  if (value.replyTo === undefined) return
  if (!boundedId(value.replyTo, 160) || !boundedId(value.conversationRootId, 160)) invalid()
  if (value.replyTo === messageId || value.conversationRootId === messageId) invalid()
}
export function validateMessageContext(value: unknown, scope: string, messageId?: string): asserts value is MessageContext {
  if (!object(value)) invalid()
  keys(value, ["references", "mentions", "replyTo", "conversationRootId"])
  if (!Array.isArray(value.references) || value.references.length > MAX_REFERENCES) invalid()
  if (!Array.isArray(value.mentions) || value.mentions.length > MAX_MENTIONS) invalid()
  if (value.mentions.some(id => !boundedId(id)) || new Set(value.mentions).size !== value.mentions.length) invalid()
  for (const anchor of value.references) validateAnchor(anchor, scope)
  validateReply(value, messageId)
}

type ContextMessage = Pick<StoredChatMessage, "id" | "workspaceId" | "context">
export type ConversationRoot = { rootId: string; state: "resolved" | "unavailable" | "invalid" }
export function conversationRoot(message: ContextMessage, messages: readonly ContextMessage[]): ConversationRoot {
  if (!message.context?.replyTo) return { rootId: message.id, state: "resolved" }
  return rootFromIndex(message, new Map(messages.filter(candidate => candidate.workspaceId === message.workspaceId).map(candidate => [candidate.id, candidate])))
}
export function conversationRoots(messages: readonly ContextMessage[]) {
  const index = new Map(messages.map(message => [message.id, message]))
  return new Map(messages.map(message => [message.id, rootFromIndex(message, index)]))
}
function scopeMessage(index: Map<string, ContextMessage>, id: string, scope: string): ContextMessage | undefined {
  const message = index.get(id)
  return message?.workspaceId === scope ? message : undefined
}
function rootFromIndex(message: ContextMessage, byId: Map<string, ContextMessage>): ConversationRoot {
  let current = message
  const seen = new Set<string>()
  const expectedRoot = message.context?.conversationRootId ?? message.id
  while (current.context?.replyTo) {
    if (seen.has(current.id) || current.context.conversationRootId !== expectedRoot) return { rootId: message.id, state: "invalid" }
    seen.add(current.id)
    const parent = scopeMessage(byId, current.context.replyTo, message.workspaceId)
    if (!parent) {
      const root = scopeMessage(byId, expectedRoot, message.workspaceId)
      if (root?.context?.replyTo || seen.has(expectedRoot)) return { rootId: message.id, state: "invalid" }
      return { rootId: expectedRoot, state: "unavailable" }
    }
    current = parent
  }
  return current.id === expectedRoot ? { rootId: expectedRoot, state: "resolved" } : { rootId: message.id, state: "invalid" }
}

export function normalizeMessageContext(context: MessageContext, messages: readonly StoredChatMessage[], scope: string): MessageContext {
  const normalized: MessageContext = { ...context, references: context.references.map(anchor => ({ ...anchor, ...(anchor.selection ? { selection: { ...anchor.selection } } : {}) })), mentions: [...context.mentions] }
  if (normalized.replyTo) {
    const target = messages.find(message => message.id === normalized.replyTo && message.workspaceId === scope)
    if (target) {
      const root = conversationRoot(target, messages)
      if (root.state === "invalid") throw new Error("Invalid reply conversation")
      normalized.conversationRootId = root.rootId
      if (!normalized.references.length) normalized.references = structuredClone(target.context?.references.length ? target.context.references : messages.find(message => message.id === root.rootId)?.context?.references ?? [])
    } else if (!normalized.conversationRootId) throw new Error("Reply target unavailable")
  }
  validateMessageContext(normalized, scope)
  return normalized
}

function anchorMatches(left: Anchor, right: Anchor) {
  return left.workspaceScope === right.workspaceScope && left.boardId === right.boardId && left.itemId === right.itemId &&
    (right.fieldId === undefined || left.fieldId === right.fieldId) &&
    (right.selection === undefined || JSON.stringify(left.selection) === JSON.stringify(right.selection))
}
export function conversationMessages(messages: readonly StoredChatMessage[], filter: { anchor?: Anchor; rootId?: string }): StoredChatMessage[] {
  const selectedAnchor = filter.anchor
  const index = new Map(messages.map(message => [message.id, message]))
  const roots = new Set(messages.filter(message => message.context?.references.some(anchor => selectedAnchor && anchorMatches(anchor, selectedAnchor)))
    .map(message => rootFromIndex(message, index)).filter(root => root.state !== "invalid").map(root => root.rootId))
  const matched = messages.filter(message => {
    const root = rootFromIndex(message, index)
    if (filter.rootId) return root.state !== "invalid" && root.rootId === filter.rootId
    return !!selectedAnchor && (message.context?.references.some(anchor => anchorMatches(anchor, selectedAnchor)) || (root.state !== "invalid" && roots.has(root.rootId)))
  })
  return groupConversations(matched, index)
}
function compareMessageOrder(left: StoredChatMessage, right: StoredChatMessage) {
  const leftKey = `${left.createdAt}|${left.id}`, rightKey = `${right.createdAt}|${right.id}`
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
}
function groupConversations(messages: StoredChatMessage[], index: Map<string, StoredChatMessage>): StoredChatMessage[] {
  const groups = new Map<string, StoredChatMessage[]>()
  for (const message of messages) {
    const root = rootFromIndex(message, index)
    const rootId = root.state === "invalid" ? message.id : root.rootId
    const group = groups.get(rootId) ?? []
    group.push(message); groups.set(rootId, group)
  }
  const ordered = [...groups].map(([rootId, group]) => {
    const root = group.find(message => message.id === rootId)
    const replies = group.filter(message => message !== root).sort(compareMessageOrder)
    return root ? [root, ...replies] : replies
  }).sort((left, right) => compareMessageOrder(left[0]!, right[0]!))
  return ordered.flat()
}

export type SelectionResolution = { state: "exact" | "relocated"; start: number; end: number } | { state: "changed" | "unavailable" }
export function resolveAnchorSelection(text: string | undefined, selection: AnchorSelection): SelectionResolution {
  if (text === undefined) return { state: "unavailable" }
  const matches = (start: number) => text.slice(start, start + selection.exact.length) === selection.exact &&
    text.slice(Math.max(0, start - selection.prefix.length), start) === selection.prefix &&
    text.slice(start + selection.exact.length, start + selection.exact.length + selection.suffix.length) === selection.suffix
  if (matches(selection.start)) return { state: "exact", start: selection.start, end: selection.end }
  const candidates: number[] = []
  for (let start = text.indexOf(selection.exact); start >= 0; start = text.indexOf(selection.exact, start + 1)) {
    if (matches(start)) candidates.push(start)
    if (candidates.length > 1) return { state: "changed" }
  }
  return candidates.length === 1 ? { state: "relocated", start: candidates[0]!, end: candidates[0]! + selection.exact.length } : { state: "changed" }
}
