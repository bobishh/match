import { expect, test, type Page } from "@playwright/test"
import { createJobSearchWorkspace } from "./support/workspaces"

async function openItem(page: Page, title: string) {
  await page.goto("/")
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const workspace = page.getByRole("dialog", { name: "Create workspace" })
  await workspace.getByLabel("Title", { exact: true }).fill("Quick notes")
  await workspace.getByRole("button", { name: "Create", exact: true }).click()
  await page.getByRole("button", { name: "Add item to To do", exact: true }).click()
  const form = page.getByRole("dialog", { name: "Item details", exact: true })
  await form.getByLabel("Title *", { exact: true }).fill(title)
  await form.getByRole("button", { name: "Save item", exact: true }).click()
  await page.getByRole("button", { name: `Open ${title}`, exact: true }).click()
}

test("Given an item overview, when a quick note is added, then it appears immediately and survives reload", async ({ page }) => {
  await openItem(page, "Remember this")
  const detail = page.getByRole("dialog", { name: "Item overview", exact: true })

  await detail.getByRole("textbox", { name: "Quick note", exact: true }).fill("Call Alice after lunch")
  await detail.getByRole("button", { name: "Add note", exact: true }).click()

  await expect(detail.getByText("Call Alice after lunch", { exact: true })).toBeVisible()
  await expect(detail.getByRole("textbox", { name: "Quick note", exact: true })).toHaveValue("")
  await page.reload()
  await page.getByRole("button", { name: "Open Remember this", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Item overview", exact: true })
    .getByText("Call Alice after lunch", { exact: true })).toBeVisible()
})

test("Given quick-note persistence fails, when retry succeeds, then the draft stays and one note is saved", async ({ page }) => {
  await openItem(page, "Retry note")
  const detail = page.getByRole("dialog", { name: "Item overview", exact: true })
  const draft = detail.getByRole("textbox", { name: "Quick note", exact: true })
  await draft.fill("Do not lose this draft")
  await page.evaluate(() => { (window as any).__MATCH_INJECT_STORAGE_FAILURE__ = true })

  await detail.getByRole("button", { name: "Add note", exact: true }).click()

  await expect(detail.getByRole("alert")).toContainText("Note not saved")
  await expect(draft).toHaveValue("Do not lose this draft")
  await expect(detail.getByText("Do not lose this draft", { exact: true })).toHaveCount(0)
  await page.evaluate(() => { (window as any).__MATCH_INJECT_STORAGE_FAILURE__ = false })
  await detail.getByRole("button", { name: "Retry note", exact: true }).click()
  await expect(detail.getByText("Do not lose this draft", { exact: true })).toHaveCount(1)
})

test("Given a Job search lead, when a quick note is added, then it uses the preset Notes field", async ({ page }) => {
  await page.goto("/")
  await createJobSearchWorkspace(page, "Quick lead notes")
  await page.getByRole("region", { name: "Lead" }).getByRole("button", { name: "Add lead to Lead" }).click()
  const form = page.getByRole("dialog", { name: "Add item", exact: true })
  await form.getByLabel("Company *", { exact: true }).fill("Quick Note Corp")
  await form.getByLabel("Role *", { exact: true }).fill("Engineer")
  await form.getByLabel("Notes", { exact: true }).fill("Existing context")
  await form.getByRole("button", { name: "Create item", exact: true }).click()
  const detail = page.getByRole("dialog", { name: "Lead details", exact: true })
  await expect(detail).toBeVisible()

  await detail.getByRole("textbox", { name: "Quick note", exact: true }).fill("Follow up Friday")
  await detail.getByRole("button", { name: "Add note", exact: true }).click()

  await expect(detail.getByText("Existing context\n\nFollow up Friday", { exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole("button").filter({ hasText: "Quick Note Corp" }).click()
  await expect(page.getByRole("dialog", { name: "Lead details", exact: true })
    .getByText("Existing context\n\nFollow up Friday", { exact: true })).toBeVisible()
})
