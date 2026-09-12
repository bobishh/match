import { describe, expect, it } from "vitest"
import { evaluatePriority, orderTasksByPriority, projectTaskPriority } from "./priority"
import type { Board, PriorityPolicy, Task } from "./model"

const policy: PriorityPolicy = {
  version: 1,
  evaluator: "weighted-rules-v1",
  sort: "fit_desc",
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

describe("priority order", () => {
  const remote = { id: "remote", values: { mode: "remote" } } as unknown as Task
  const onsite = { id: "onsite", values: { mode: "onsite" } } as unknown as Task

  it("orders highest fit first by default and keeps equal scores stable", () => {
    const legacyPolicy = { ...policy, sort: undefined }
    expect(orderTasksByPriority({ priorityPolicy: legacyPolicy } as Board, [onsite, remote]).map(task => task.id))
      .toEqual(["remote", "onsite"])
    expect(orderTasksByPriority({ priorityPolicy: policy } as Board, [remote, { ...remote, id: "remote-2" }]).map(task => task.id))
      .toEqual(["remote", "remote-2"])
  })

  it("supports lowest-fit and manual order", () => {
    expect(orderTasksByPriority({ priorityPolicy: { ...policy, sort: "fit_asc" } } as Board, [remote, onsite]).map(task => task.id))
      .toEqual(["onsite", "remote"])
    expect(orderTasksByPriority({ priorityPolicy: { ...policy, sort: "manual" } } as Board, [onsite, remote]))
      .toEqual([onsite, remote])
  })
})
