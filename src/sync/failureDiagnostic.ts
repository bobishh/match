const failureTypes = new Set([
  "MeshNetworkError", "MeshTerminalError", "WorkspaceChangeRejected",
  "AbortError", "QuotaExceededError", "DataError", "OperationError", "NotFoundError",
])

/** Fixed type names identify failures without exporting error messages or arbitrary names. */
export function diagnosticErrorCode(error: unknown, depth = 0): string {
  if (!(error instanceof Error) && !(error instanceof DOMException) || depth >= 8) return "UnknownError"
  if (error instanceof AggregateError) {
    const codes = new Set(error.errors.map(cause => diagnosticErrorCode(cause, depth + 1)))
    return codes.size === 1 ? [...codes][0]! : "AggregateError"
  }
  for (const name of [error.constructor.name, error.name]) if (failureTypes.has(name)) return name
  return "cause" in error ? diagnosticErrorCode(error.cause, depth + 1) : "UnknownError"
}
