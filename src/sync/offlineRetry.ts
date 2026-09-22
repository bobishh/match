/** User-facing retry cadence shared by pairing and enrollment flows. */
export function offlineRetryDelay(attempt: number): number {
  if (attempt <= 1) return 1_000
  if (attempt === 2) return 2_000
  if (attempt === 3) return 5_000
  return 10_000
}
