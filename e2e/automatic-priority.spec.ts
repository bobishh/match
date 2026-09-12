import { expect, test, type Page } from "@playwright/test"
import { createJobSearchWorkspace } from "./support/workspaces"

async function openPriorityRules(page: Page) {
  await page.getByRole("button", { name: "Workspace settings" }).click()
  const dialog = page.getByRole("dialog", { name: "Workspace settings" })
  await dialog.getByRole("tab", { name: "Priority rules" }).click()
  return dialog
}

async function addLead(page: Page, company: string, workMode: "remote" | "onsite") {
  await page.getByRole("region", { name: "Lead" }).getByRole("button", { name: "Add lead to Lead" }).click()
  const dialog = page.getByRole("dialog", { name: "Add item" })
  await expect(dialog.getByLabel("Priority")).toHaveCount(0)
  await expect(dialog.getByLabel("Fit score")).toHaveCount(0)
  await expect(dialog.getByText("Priority and fit are calculated from workspace preferences.")).toBeVisible()
  await dialog.getByLabel("Company *").fill(company)
  await dialog.getByLabel("Role *").fill("Backend Engineer")
  await dialog.getByLabel("Work mode").selectOption(workMode)
  await dialog.getByRole("button", { name: "Create item" }).click()
  await page.getByRole("dialog", { name: "Lead details" }).getByRole("button", { name: "Close detail" }).click()
}

test.describe("Automatic priority from workspace preferences", () => {
  test("Given weighted work-mode rules, when leads are created, then fit and priority are derived without manual fields", async ({ page }) => {
    await page.goto("/")
    await createJobSearchWorkspace(page, "Weighted jobs")

    const settings = await openPriorityRules(page)
    await settings.getByRole("button", { name: "Enable automatic priority" }).click()
    await expect(settings.getByRole("group", { name: "Weighted criteria" })).toContainText("Work mode")
    await expect(settings.getByLabel("Card order")).toHaveValue("fit_desc")
    await settings.getByRole("button", { name: "Save priority rules" }).click()

    await addLead(page, "Office only", "onsite")
    await addLead(page, "Remote first", "remote")

    const remote = page.getByRole("button", { name: "Open Remote first — Backend Engineer" })
    await expect(remote).toContainText("P0")
    await expect(remote).toContainText("8/10 fit")
    const onsite = page.getByRole("button", { name: "Open Office only — Backend Engineer" })
    await expect(onsite).toContainText("P3")
    await expect(onsite).toContainText("0/10 fit")
    const cards = page.getByRole("region", { name: "Lead" }).locator(".lead-card")
    await expect(cards.first()).toHaveAccessibleName("Open Remote first — Backend Engineer")

    const reopened = await openPriorityRules(page)
    await reopened.getByLabel("Card order").selectOption("fit_asc")
    await reopened.getByRole("button", { name: "Save priority rules" }).click()
    await expect(cards.first()).toHaveAccessibleName("Open Office only — Backend Engineer")
  })

  test("Given automatic priority with no criteria, when saving, then settings stay open with an actionable error", async ({ page }) => {
    await page.goto("/")
    await createJobSearchWorkspace(page, "Broken rules")

    const settings = await openPriorityRules(page)
    await settings.getByRole("button", { name: "Enable automatic priority" }).click()
    const removeRules = settings.getByRole("button", { name: /Remove .* rule/ })
    while (await removeRules.count()) await removeRules.first().click()
    await settings.getByRole("button", { name: "Save priority rules" }).click()

    await expect(settings.getByRole("alert")).toHaveText("Add at least one priority rule")
    await expect(settings).toBeVisible()
  })
})
