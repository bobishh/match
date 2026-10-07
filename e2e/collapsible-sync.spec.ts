import { expect, test, type Browser, type BrowserContext, type Page } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"

async function pairWorkspace(host: Page, guest: Page) {
  await ensureJobSearchWorkspace(host)
  await host.getByRole("button", { name: "Sync", exact: true }).click()
  const hostDialog = host.getByRole("dialog", { name: "Device sync" })
  await hostDialog.getByRole("button", { name: "Add someone" }).click()
  await hostDialog.getByRole("button", { name: "Generate link" }).click()
  await guest.goto(await hostDialog.getByLabel("Pairing link").inputValue())
  const guestDialog = guest.getByRole("dialog", { name: "Device sync" })
  await guestDialog.getByRole("button", { name: "Accept and join" }).click()
  await host.getByLabel("Participant role").selectOption("editor")
  await host.getByRole("button", { name: "Approve access" }).click()
  await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
  await expect(guest.getByLabel("Workspace role: editor")).toBeVisible()
  if (await guestDialog.isVisible()) await guestDialog.getByRole("button", { name: "Close", exact: true }).first().click()
  if (await hostDialog.isVisible()) await hostDialog.getByRole("button", { name: "Close", exact: true }).first().click()
}

async function isolatedContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  await context.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
  return context
}

test("Given paired desktop and mobile peers, when desktop enables collapse for a column, then mobile receives shared capability but keeps local open state", async ({ browser, page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const context = await isolatedContext(browser)
  const mobile = await context.newPage()
  try {
    await Promise.all([page.goto("/"), mobile.goto("/")])
    await pairWorkspace(page, mobile)

    const mobileLead = mobile.getByRole("region", { name: "Lead", exact: true })
    await expect(mobileLead.getByRole("button", { name: "Collapse Lead" })).toHaveCount(0)

    await page.getByRole("button", { name: "Edit board", exact: true }).click()
    const lead = page.getByRole("region", { name: "Lead", exact: true })
    await lead.getByRole("button", { name: "Edit column" }).click()
    const dialog = page.getByRole("dialog", { name: "Edit column" })
    await dialog.getByRole("checkbox", { name: "Allow this column to collapse" }).check()
    await dialog.getByRole("button", { name: "Save" }).click()

    await expect(mobileLead.getByRole("button", { name: "Collapse Lead" })).toBeVisible({ timeout: 30_000 })
    await expect(mobileLead.getByRole("button", { name: /Open Lead with/ })).toHaveCount(0)
    await mobileLead.getByRole("button", { name: "Collapse Lead" }).click()
    await expect(mobileLead.getByRole("button", { name: /Open Lead with/ })).toBeVisible()
    await expect(lead.getByRole("button", { name: "Collapse Lead" })).toBeVisible()
  } finally {
    await context.close()
  }
})
