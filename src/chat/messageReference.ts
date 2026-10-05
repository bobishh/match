export type MessageReference = { version: 1; workspaceScope: string; messageId: string }
export type ParsedMessageReference =
  | { status: "none" }
  | { status: "invalid" }
  | { status: "valid"; reference: MessageReference }

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_:-]{1,160}$/.test(value)
}

function validReference(value: unknown): value is MessageReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const reference = value as Record<string, unknown>
  const keys = Object.keys(reference)
  return keys.length === 3 && keys.every(key => ["version", "workspaceScope", "messageId"].includes(key)) &&
    reference.version === 1 && validId(reference.workspaceScope) && validId(reference.messageId)
}

export function parseMessageReference(hash: string): ParsedMessageReference {
  if (!hash.startsWith("#message=")) return { status: "none" }
  if (hash.length > 2048) return { status: "invalid" }
  try {
    const reference: unknown = JSON.parse(decodeURIComponent(hash.slice("#message=".length)))
    return validReference(reference) ? { status: "valid", reference } : { status: "invalid" }
  } catch {
    return { status: "invalid" }
  }
}

export function messageReferenceUrl(baseUrl: string, target: Omit<MessageReference, "version">): string {
  const reference = { version: 1 as const, workspaceScope: target.workspaceScope, messageId: target.messageId }
  if (!validReference(reference)) throw new Error("Invalid message reference")
  const url = new URL(baseUrl)
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Invalid message URL")
  url.hash = `message=${encodeURIComponent(JSON.stringify(reference))}`
  return url.toString()
}
