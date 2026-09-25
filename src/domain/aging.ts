import type { CardAgingPolicy, Item } from "./model"
import { isArchiveColumn } from "./archive"

export const defaultCardAgingPolicy: CardAgingPolicy = {
  version: 1,
  thresholds: { watch: 7, aged: 14, overdue: 30 },
}

export type CardAge = { days: number; level: "fresh" | "watch" | "aged" | "overdue"; label: string }

export function isCardAgingExemptColumn(column: { title: string; archive?: true; displayHint?: "normal" | "collapsed" }): boolean {
  return isArchiveColumn(column) || /^(done|complete|completed)$/i.test(column.title.trim())
}

export function cardAge(item: Item, policy: CardAgingPolicy | undefined, now = new Date()): CardAge | null {
  const activity = new Date(item.lastActivityAt ?? item.updatedAt)
  if (Number.isNaN(activity.getTime()) || Number.isNaN(now.getTime())) return null
  const days = Math.max(0, Math.floor((now.getTime() - activity.getTime()) / 86_400_000))
  const thresholds = policy?.thresholds ?? defaultCardAgingPolicy.thresholds
  const level = days >= thresholds.overdue ? "overdue" : days >= thresholds.aged ? "aged" : days >= thresholds.watch ? "watch" : "fresh"
  const duration = `${days} ${days === 1 ? "day" : "days"}`
  return { days, level, label: item.lastActivityAt ? `No activity for ${duration}` : `Last updated ${duration} ago` }
}
