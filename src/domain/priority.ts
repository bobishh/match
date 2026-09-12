import type { Board, FieldDefinition, FieldValue, PriorityPolicy, PriorityRule, Task, WorkspaceDocumentV2 } from "./model"
import { compareRanks } from "./ancestry"

export type PriorityEvaluation = {
  score: number
  optionId: string | null
  matchedRuleIds: string[]
}

function matches(rule: PriorityRule, value: FieldValue | undefined): boolean {
  switch (rule.operator) {
    case "is_set": return value !== undefined && value !== null && value !== ""
    case "equals": return value === rule.value
    case "contains": return typeof value === "string" && typeof rule.value === "string"
      && value.toLowerCase().includes(rule.value.toLowerCase())
    case "at_least": return typeof value === "number" && typeof rule.value === "number" && value >= rule.value
    case "at_most": return typeof value === "number" && typeof rule.value === "number" && value <= rule.value
  }
}

export function evaluatePriority(policy: PriorityPolicy, values: Record<string, FieldValue>): PriorityEvaluation {
  const matched = policy.rules.filter(rule => matches(rule, values[rule.fieldId]))
  const score = Math.round(Math.max(0, Math.min(10, matched.reduce((sum, rule) => sum + rule.weight, 0))) * 10) / 10
  const band = [...policy.bands].sort((a, b) => b.minScore - a.minScore).find(item => score >= item.minScore)
  return { score, optionId: band?.optionId ?? null, matchedRuleIds: matched.map(rule => rule.id) }
}

export function projectTaskPriority(board: Board | null | undefined, task: Task): Task {
  const policy = board?.priorityPolicy
  if (!policy) return task
  const evaluation = evaluatePriority(policy, task.values)
  return {
    ...task,
    values: {
      ...task.values,
      [policy.priorityFieldId]: evaluation.optionId,
      ...(policy.fitFieldId ? { [policy.fitFieldId]: evaluation.score } : {}),
    },
  }
}

export function createDefaultPriorityPolicy(board: Board, fields: FieldDefinition[]): PriorityPolicy | null {
  const bindings = board.preset?.bindings ?? {}
  const priorityFieldId = bindings["field.priority"]
  const fitFieldId = bindings["field.fitScore"] ?? null
  const workModeFieldId = bindings["field.workMode"]
  if (!priorityFieldId || !workModeFieldId) return null

  const weights: Array<[string, number]> = [
    ["remote", 8],
    ["hybrid", 5],
    ["unknown", 2],
    ["onsite", 0],
  ]
  const rules = weights.flatMap(([name, weight]) => {
    const value = bindings[`option.workMode.${name}`]
    return value ? [{ id: crypto.randomUUID(), fieldId: workModeFieldId, operator: "equals" as const, value, weight }] : []
  })
  const priority = fields.find(field => field.id === priorityFieldId && field.valueType === "select")
  if (!priority || priority.valueType !== "select") return null
  const byTitle = new Map(Object.values(priority.options)
    .filter(option => !option.deleted)
    .sort((a, b) => compareRanks(a.rank, b.rank))
    .map(option => [option.title.toLowerCase(), option.id]))
  const bands = [["p0", 8], ["p1", 6], ["p2", 3], ["p3", 0]].flatMap(([name, minScore]) => {
    const optionId = byTitle.get(String(name)) ?? bindings[`option.priority.${name}`]
    return optionId ? [{ optionId, minScore: Number(minScore) }] : []
  })
  return { version: 1, evaluator: "weighted-rules-v1", priorityFieldId, fitFieldId, rules, bands }
}

export function validatePriorityPolicy(
  policy: PriorityPolicy | null | undefined,
  doc: WorkspaceDocumentV2 | undefined,
  boardId: string,
): Array<{ path: string; message: string }> {
  if (!policy) return []
  const errors: Array<{ path: string; message: string }> = []
  if (!policy.rules.length) errors.push({ path: "/priorityPolicy/rules", message: "Add at least one priority rule" })
  if (!policy.bands.length) errors.push({ path: "/priorityPolicy/bands", message: "Add at least one priority band" })
  const ids = new Set<string>()
  policy.rules.forEach((rule, index) => {
    if (ids.has(rule.id)) errors.push({ path: `/priorityPolicy/rules/${index}/id`, message: "Rule id is duplicated" })
    ids.add(rule.id)
    if (!Number.isFinite(rule.weight) || rule.weight < -10 || rule.weight > 10) {
      errors.push({ path: `/priorityPolicy/rules/${index}/weight`, message: "Rule weight must be between -10 and 10" })
    }
    if (!doc) return
    if (rule.fieldId === policy.priorityFieldId || rule.fieldId === policy.fitFieldId) {
      errors.push({ path: `/priorityPolicy/rules/${index}/fieldId`, message: "A rule cannot read its own output field" })
      return
    }
    const field = doc.entities[rule.fieldId]
    if (!field || field.kind !== "field" || field.deleted || field.placement.parentId !== boardId) {
      errors.push({ path: `/priorityPolicy/rules/${index}/fieldId`, message: "Rule field must be active on this board" })
      return
    }
    if ((rule.operator === "at_least" || rule.operator === "at_most") && field.valueType !== "number") {
      errors.push({ path: `/priorityPolicy/rules/${index}/operator`, message: "Numeric comparison requires a number field" })
    }
    if (rule.operator === "contains" && !["text", "url"].includes(field.valueType)) {
      errors.push({ path: `/priorityPolicy/rules/${index}/operator`, message: "Contains requires a text or URL field" })
    }
    if (field.valueType === "select" && rule.operator === "equals") {
      const option = field.options[String(rule.value)]
      if (!option || option.deleted) errors.push({ path: `/priorityPolicy/rules/${index}/value`, message: "Rule value must be an active option" })
    }
    if (rule.operator === "equals") {
      const validType = field.valueType === "number" ? typeof rule.value === "number"
        : field.valueType === "boolean" ? typeof rule.value === "boolean"
          : typeof rule.value === "string"
      if (!validType) errors.push({ path: `/priorityPolicy/rules/${index}/value`, message: "Rule value must match the field type" })
    }
  })
  if (doc) {
    const priority = doc.entities[policy.priorityFieldId]
    if (!priority || priority.kind !== "field" || priority.deleted || priority.valueType !== "select" || priority.placement.parentId !== boardId) {
      errors.push({ path: "/priorityPolicy/priorityFieldId", message: "Priority output must be an active select field" })
    } else {
      policy.bands.forEach((band, index) => {
        const option = priority.options[band.optionId]
        if (!option || option.deleted) errors.push({ path: `/priorityPolicy/bands/${index}/optionId`, message: "Priority band must target an active option" })
      })
    }
    if (policy.fitFieldId) {
      const fit = doc.entities[policy.fitFieldId]
      if (!fit || fit.kind !== "field" || fit.deleted || fit.valueType !== "number" || fit.placement.parentId !== boardId) {
        errors.push({ path: "/priorityPolicy/fitFieldId", message: "Fit output must be an active number field" })
      }
    }
  }
  policy.bands.forEach((band, index) => {
    if (!Number.isFinite(band.minScore) || band.minScore < 0 || band.minScore > 10) {
      errors.push({ path: `/priorityPolicy/bands/${index}/minScore`, message: "Priority threshold must be between 0 and 10" })
    }
  })
  const bandOptions = new Set<string>()
  policy.bands.forEach((band, index) => {
    if (bandOptions.has(band.optionId)) errors.push({ path: `/priorityPolicy/bands/${index}/optionId`, message: "Priority band option is duplicated" })
    bandOptions.add(band.optionId)
  })
  if (policy.bands.length && !policy.bands.some(band => band.minScore === 0)) {
    errors.push({ path: "/priorityPolicy/bands", message: "Priority bands need a fallback at score 0" })
  }
  return errors
}
