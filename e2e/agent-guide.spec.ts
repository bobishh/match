import { expect, test } from "@playwright/test"

test.describe("Agent guide", () => {
  test("Given current Match, when an agent opens the guide, then workspace and MCP instructions match the live contract", async ({ page }) => {
    await page.goto("/agent/")

    await expect(page.getByRole("heading", { level: 1, name: "Match agent guide" })).toBeVisible()
    await expect(page.getByRole("banner")).toContainText("MATCH")
    await expect(page.getByRole("banner")).not.toContainText("jobs")

    const guide = page.getByRole("main")
    for (const tool of [
      "get_workspace_settings",
      "apply_workspace_settings",
      "create_task",
      "patch_task",
      "move_entity",
      "set_entity_deleted",
      "restore_and_move",
      "list_placement_issues",
    ]) {
      await expect(guide.locator(".tool-name", { hasText: tool })).toHaveText(tool)
    }

    await expect(guide).toContainText("documentTemplates")
    await expect(guide).toContainText("expectedHeads")
    await expect(guide).toContainText("Soft deletion")
    await expect(guide).toContainText("current workspace")
    await expect(guide).toContainText("Add my device")
    await expect(guide.getByText("move_task", { exact: true })).toHaveCount(0)
    await expect(guide).not.toContainText("global CV and cover-letter")
  })

  test("Given invalid or stale settings, when an agent follows recovery guidance, then validation and conflict behavior is explicit", async ({ page }) => {
    await page.goto("/agent/")

    const safety = page.getByRole("heading", { name: "Mutation rules" }).locator("..")
    await expect(safety).toContainText("Unknown fields are rejected without mutation")
    await expect(safety).toContainText("re-read settings")
    await expect(safety).toContainText("conflict")
    await expect(safety).toContainText("Keep returned IDs")
  })

  test("Given a narrow viewport, when the guide opens, then content remains within the viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto("/agent/")

    await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
    const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    expect(hasHorizontalOverflow).toBe(false)
  })
})
