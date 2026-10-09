export function safeDiagnostic(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined
  if (!cause || typeof cause !== "object") return ""
  const diagnostic = cause as { code?: unknown; field?: unknown }
  if (typeof diagnostic.code !== "string") return ""
  const field = typeof diagnostic.field === "string" ? ` at ${diagnostic.field}` : ""
  return ` [${diagnostic.code}${field}]`
}
