import { z } from "zod"
import { placementSchema, entitySchema, workspaceSchema } from "./entitySchemas"
import type { CommandResult, EntityKind } from "./model"

function validate<T>(schema: z.ZodType<T>, input: unknown): CommandResult<T> {
  const result = schema.safeParse(input)
  if (result.success) return { ok: true, value: result.data }
  const issue = result.error.issues[0]!
  return { ok: false, error: {
    code: issue.path[0] === "formatVersion" ? "unsupported_format" : "invalid_input",
    message: `${issue.path.join(".") || "Object"}: ${issue.message}`,
    field: issue.path.join(".") || undefined,
  } }
}
export const validatePlacement = (input: unknown) => validate(placementSchema, input)
export const validateEntity = (input: unknown) => validate(entitySchema, input)
export const validateWorkspaceDoc = (input: unknown) => validate(workspaceSchema, input)

const allowedParents: Record<EntityKind, readonly (string | null)[]> = {
  board: [null], column: ["board"], field: ["board"], item: ["column", "item"],
  document: ["item"], artifact: ["item"], document_template: [null], template: [null],
}
export function validatePlacementParent(childKind: string, parentKind: string | null): CommandResult<void> {
  if (!Object.hasOwn(allowedParents, childKind)) return { ok: false, error: { code: "invalid_input", message: `Unknown entity kind: ${childKind}` } }
  const parents = allowedParents[childKind as EntityKind]
  return parents.includes(parentKind) ? { ok: true, value: undefined }
    : { ok: false, error: { code: "invalid_parent", message: `${childKind} parent must be ${parents.map(value => value ?? "null").join(" or ")}` } }
}
