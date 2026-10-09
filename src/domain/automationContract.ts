import { z } from "zod"

const jobIntakePermissions = ["workspace.read", "board.lead.create", "board.application.advance"] as const
const identifier = z.string().min(1).max(256)
const jobIntakeParameters = z.object({
  sources: z.array(z.enum(["website", "email"])).min(1).max(2)
    .refine(sources => new Set(sources).size === sources.length, "Event sources must be unique"),
}).strict()

/** Register only types with an implemented, version-matched Worker handler. */
export const automationTypes = Object.freeze([Object.freeze({
  type: "job-intake" as const,
  version: 1 as const,
  title: "Job intake",
  description: "Create Leads from submissions; advance matched applications from forwarded email.",
  permissions: Object.freeze([...jobIntakePermissions]),
  parameters: jobIntakeParameters,
})])

const definitionSchema = z.object({
  kind: z.literal("automation-definition"),
  version: z.literal(1),
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  name: z.string().trim().min(1).max(100),
  type: z.literal("job-intake"),
  typeVersion: z.literal(1),
  parameters: jobIntakeParameters,
  permissions: z.tuple([z.literal("workspace.read"), z.literal("board.lead.create"), z.literal("board.application.advance")]),
  scope: z.object({ workspaceId: identifier, boardId: identifier, grantId: identifier }).strict(),
}).strict()

export type AutomationDefinition = z.infer<typeof definitionSchema>

export function parseAutomationDefinition(value: unknown): AutomationDefinition {
  return definitionSchema.parse(value)
}
