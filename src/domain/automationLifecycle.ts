import { z } from "zod"
import { parseAutomationDefinition } from "./automationContract"

const controlSchema = z.strictObject({
  state: z.enum(["active", "paused", "deleted"]),
  supersedes: z.array(z.string().uuid()).max(128),
})
export type AutomationDesiredState = z.infer<typeof controlSchema>["state"]

export function automationEntityId(instanceId: string): string { return `automation:${instanceId}` }

export function isAutomationDefinitionData(data: string): boolean {
  try { parseAutomationDefinition(JSON.parse(data)); return true } catch { return false }
}

export function isAutomationControlData(data: string): boolean {
  try { controlSchema.parse(JSON.parse(data)); return true } catch { return false }
}

export function isAutomationOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return url.origin === value && !url.username && !url.password &&
      (url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  } catch { return false }
}

/** Concurrent pause wins; a resume must supersede every observed head. Deletion is permanent. */
export function automationLifecycle(entity: unknown): { state: AutomationDesiredState; heads: string[] } {
  const record = z.object({ kind: z.literal("automation"), controls: z.record(z.string(), z.string()) }).parse(entity)
  const entries = Object.entries(record.controls)
  if (!entries.length || entries.length > 4096) throw new Error("Automation control history is missing or too large")
  const controls = new Map(entries.map(([id, data]) => {
    if (!z.string().uuid().safeParse(id).success || data.length > 8192) throw new Error("Automation control ID or size is invalid")
    return [id, controlSchema.parse(JSON.parse(data))] as const
  }))
  const superseded = new Set<string>()
  const pending = new Set(controls.keys())
  const visited = new Set<string>()
  while (pending.size) {
    let progressed = false
    for (const id of pending) {
      const control = controls.get(id)!
      if (new Set(control.supersedes).size !== control.supersedes.length || control.supersedes.some(previous => !controls.has(previous))) {
        throw new Error("Automation control dependencies are invalid")
      }
      if (!control.supersedes.every(previous => visited.has(previous))) continue
      for (const previous of control.supersedes) superseded.add(previous)
      visited.add(id); pending.delete(id); progressed = true
    }
    if (!progressed) throw new Error("Automation control history contains a cycle")
  }
  const heads = [...controls.keys()].filter(id => !superseded.has(id)).sort()
  if (heads.length > 128) throw new Error("Automation control has too many concurrent heads")
  const state = [...controls.values()].some(control => control.state === "deleted") ? "deleted"
    : heads.some(id => controls.get(id)!.state === "paused") ? "paused" : "active"
  return { state, heads }
}
