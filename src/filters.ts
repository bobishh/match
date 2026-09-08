import type { Lead, LeadPriority, LeadStatus } from "./types"

export type LeadFilters = {
  status: LeadStatus | "all"
  priority: LeadPriority | "all"
  workMode: NonNullable<Lead["workMode"]> | "all"
  fit: "all" | "strong" | "possible" | "low" | "unscored"
}

export const defaultLeadFilters: LeadFilters = {
  status: "all",
  priority: "all",
  workMode: "all",
  fit: "all",
}

export function matchesLeadFilters(lead: Lead, filters: LeadFilters) {
  const fit = lead.fitScore
  const matchesFit = filters.fit === "all"
    || (filters.fit === "strong" && fit !== undefined && fit >= 8)
    || (filters.fit === "possible" && fit !== undefined && fit >= 6 && fit < 8)
    || (filters.fit === "low" && fit !== undefined && fit < 6)
    || (filters.fit === "unscored" && fit === undefined)

  return (filters.status === "all" || lead.status === filters.status)
    && (filters.priority === "all" || lead.priority === filters.priority)
    && (filters.workMode === "all" || lead.workMode === filters.workMode)
    && matchesFit
}
