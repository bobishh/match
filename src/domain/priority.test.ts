import { describe, expect, it } from "vitest"
import { evaluatePriority, projectTaskPriority } from "./priority"
import type { Board, PriorityPolicy, Task } from "./model"

const policy: PriorityPolicy = {
  version: 1,
  evaluator: "weighted-rules-v1",
  priorityFieldId: "priority",
  fitFieldId: "fit",
  rules: [
    { id: "remote", fieldId: "mode", operator: "equals", value: "remote", weight: 8 },
    { id: "culture", fieldId: "culture", operator: "equals", value: "healthy", weight: 3 },
    { id: "warning", fieldId: "notes", operator: "contains", value: "hardcore", weight: -4 },
  ],
  bands: [
    { optionId: "p0", minScore: 8 },
    { optionId: "p1", minScore: 6 },
    { optionId: "p2", minScore: 3 },
    { optionId: "p3", minScore: 0 },
  ],
}

it("evaluates weighted rules deterministically and clamps fit to 0–10", () => {
  expect(evaluatePriority(policy, { mode: "remote", culture: "healthy", notes: "normal" })).toEqual({
    score: 10,
    optionId: "p0",
    matchedRuleIds: ["remote", "culture"],
  })
  expect(evaluatePriority(policy, { notes: "Hardcore pace" })).toEqual({
    score: 0,
    optionId: "p3",
    matchedRuleIds: ["warning"],
  })
})

describe("priority projection", () => {
  it("overlays derived outputs without persisting them in source task values", () => {
    const board = { priorityPolicy: policy } as Board
    const task = { values: { mode: "remote", priority: "manual", fit: 1 } } as unknown as Task
    const projected = projectTaskPriority(board, task)
    expect(projected.values).toMatchObject({ priority: "p0", fit: 8 })
    expect(task.values).toMatchObject({ priority: "manual", fit: 1 })
  })

  it("returns source task unchanged when automatic priority is disabled", () => {
    const task = { values: { priority: "manual" } } as unknown as Task
    expect(projectTaskPriority({ priorityPolicy: null } as Board, task)).toBe(task)
  })
})
