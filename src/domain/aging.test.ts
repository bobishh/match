import { describe, expect, it } from "vitest"
import { cardAge, defaultCardAgingPolicy, isCardAgingExemptColumn } from "./aging"
import { cardAgingPolicySchema } from "./entitySchemas"
import type { Item } from "./model"

const item = (lastActivityAt?: string): Item => ({
  id: "card", title: "Card", body: "", values: {}, placement: { parentId: "column", rank: "0/1" },
  deleted: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-03-01T00:00:00.000Z", ...(lastActivityAt ? { lastActivityAt } : {}),
})

describe("card aging", () => {
  it("rejects unordered thresholds at the document boundary", () => {
    expect(cardAgingPolicySchema.safeParse({ version: 1, thresholds: { watch: 14, aged: 7, overdue: 30 } }).success).toBe(false)
  })

  it("uses meaningful activity rather than the generic updated timestamp", () => {
    expect(cardAge(item("2026-02-12T00:00:00.000Z"), defaultCardAgingPolicy, new Date("2026-03-02T00:00:00.000Z"))).toMatchObject({ days: 18, level: "aged", label: "No activity for 18 days" })
  })

  it("uses the configurable escalating thresholds", () => {
    const now = new Date("2026-01-31T00:00:00.000Z")
    expect(cardAge(item("2026-01-24T00:00:00.000Z"), { version: 1, thresholds: { watch: 3, aged: 5, overdue: 7 } }, now)?.level).toBe("overdue")

  })

  it("estimates older cards from their last saved update rather than creation", () => {
    expect(cardAge(item(), undefined, new Date("2026-03-16T00:00:00Z"))).toMatchObject({
      days: 15, level: "aged", label: "Last updated 15 days ago",
    })
  })

  it("exempts archive and completed columns from visual aging", () => {
    expect(isCardAgingExemptColumn({ title: "Archive", archive: true })).toBe(true)
    expect(isCardAgingExemptColumn({ title: "Done", displayHint: "normal" })).toBe(true)
    expect(isCardAgingExemptColumn({ title: "Doing", displayHint: "normal" })).toBe(false)
  })
})
