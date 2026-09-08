import { describe, expect, it } from "vitest"
import { defaultLeadFilters, matchesLeadFilters } from "./filters"
import type { Lead } from "./types"

const lead: Lead = { id: "lead_1", company: "Cleo", role: "Ruby", status: "lead", priority: "p0", workMode: "remote", fitScore: 9, createdAt: "2026-09-08", updatedAt: "2026-09-08" }

describe("lead filters", () => {
  it("keeps every lead with defaults", () => {
    expect(matchesLeadFilters(lead, defaultLeadFilters)).toBe(true)
  })

  it("intersects status, priority, work mode, and fit", () => {
    expect(matchesLeadFilters(lead, { status: "lead", priority: "p0", workMode: "remote", fit: "strong" })).toBe(true)
    expect(matchesLeadFilters(lead, { status: "lead", priority: "p1", workMode: "remote", fit: "strong" })).toBe(false)
    expect(matchesLeadFilters(lead, { status: "lead", priority: "p0", workMode: "remote", fit: "possible" })).toBe(false)
  })
})
