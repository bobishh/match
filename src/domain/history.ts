import * as Automerge from "@automerge/automerge/slim"

export interface HistoryEntry {
  hash: string
  time: number
  actor: string
  action: string
  entityIds: string[]
  personId?: string
  deviceId?: string
  authorLabel: string
  isLegacy: boolean
  message?: string | null
}

export function projectDocumentHistory(doc: Automerge.Doc<any>): HistoryEntry[] {
  const history = Automerge.getHistory(doc)
  const entries: HistoryEntry[] = []

  for (const item of history) {
    const change = item.change
    let action = "change"
    let entityIds: string[] = []
    let personId: string | undefined
    let deviceId: string | undefined
    let isLegacy = true
    let authorLabel = "Legacy / imported"

    if (change.message) {
      try {
        const meta = JSON.parse(change.message)
        if (meta && typeof meta === "object" && meta.version === 1) {
          action = meta.action || "change"
          entityIds = Array.isArray(meta.entityIds) ? meta.entityIds : []
          personId = meta.personId
          deviceId = meta.deviceId
          authorLabel = personId
            ? `${personId}${deviceId ? ` / ${deviceId}` : ""}`
            : (change.actor || "Unknown")
          isLegacy = false
        } else {
          isLegacy = true
          authorLabel = "Legacy / imported"
          action = change.message
        }
      } catch {
        isLegacy = true
        authorLabel = "Legacy / imported"
        action = change.message
      }
    }

    entries.push({
      hash: change.hash,
      time: change.time,
      actor: change.actor,
      action,
      entityIds,
      personId,
      deviceId,
      authorLabel,
      isLegacy,
      message: change.message,
    })
  }

  return entries
}

export function projectEntityHistory(doc: Automerge.Doc<any>, entityId: string): HistoryEntry[] {
  const allHistory = projectDocumentHistory(doc)
  return allHistory.filter((entry) => entry.entityIds.includes(entityId))
}
