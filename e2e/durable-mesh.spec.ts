import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test"

async function addLead(page: Page, company: string) {
  await page.getByRole("button", { name: /Add lead to/ }).first().click()
  await page.getByLabel("Company *").fill(company)
  await page.getByLabel("Role *").fill("Engineer")
  await page.getByRole("button", { name: "Create item" }).click()
  await page.getByRole("button", { name: "Close detail" }).click()
}

async function pairWorkspace(host: Page, guest: Page) {
  await host.getByRole("button", { name: "Sync", exact: true }).click()
  const hostDialog = host.getByRole("dialog", { name: "Device sync" })
  await hostDialog.getByRole("button", { name: "Generate link" }).click()
  const invite = await hostDialog.getByLabel("Pairing link").inputValue()
  await guest.goto(invite)
  const guestDialog = guest.getByRole("dialog", { name: "Device sync" })
  await guestDialog.getByRole("button", { name: "Accept and join" }).click()
  await host.getByLabel("Participant role").selectOption("editor")
  await host.getByRole("button", { name: "Approve access" }).click()
  await expect(guestDialog.getByText(/Connected to/)).toBeVisible({ timeout: 30_000 })
  await guestDialog.getByRole("button", { name: "Close", exact: true }).first().click()
  await hostDialog.getByRole("button", { name: "Close", exact: true }).first().click()
}

async function isolatedContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext()
  await context.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
  return context
}

test("Given trusted peers closed every tab, when both reopen without an invitation URL, then they reconnect and exchange offline changes", async ({ browser, page }) => {
  test.setTimeout(120_000)
  await page.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
  const guestContext = await isolatedContext(browser)
  let guest = await guestContext.newPage()
  try {
    await page.goto("/")
    await addLead(page, "Before restart")
    await guest.goto("/")
    await pairWorkspace(page, guest)

    await page.getByRole("button", { name: "Sync", exact: true }).click()
    await page.getByRole("dialog", { name: "Device sync" }).getByRole("button", { name: "Stop live sync" }).click()
    const hostContext = page.context()
    await guest.close()
    await page.close()

    const host = await hostContext.newPage()
    await host.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
    guest = await guestContext.newPage()
    await Promise.all([host.goto("/"), guest.goto("/")])
    await expect(host.locator(".local-state").first()).toContainText("Live", { timeout: 35_000 })
    await expect(guest.locator(".local-state").first()).toContainText("Live", { timeout: 35_000 })

    await addLead(guest, "After restart")
    await expect(host.getByRole("button", { name: "Open After restart — Engineer" })).toBeVisible({ timeout: 20_000 })

    const followerTab = await hostContext.newPage()
    await followerTab.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
    await followerTab.goto("/")
    await expect(followerTab.locator(".local-state").first()).toContainText("Live", { timeout: 10_000 })
    await addLead(followerTab, "From follower tab")
    await expect(guest.getByRole("button", { name: "Open From follower tab — Engineer" })).toBeVisible({ timeout: 20_000 })

    await host.close()
    await addLead(guest, "After leader closed")
    await expect(followerTab.getByRole("button", { name: "Open After leader closed — Engineer" })).toBeVisible({ timeout: 30_000 })
    await followerTab.close()
  } finally {
    await guestContext.close()
  }
})

test("Given owner introduced two editors, when owner goes offline, then editors discover each other and keep syncing", async ({ browser, page }) => {
  test.setTimeout(150_000)
  await page.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
  const bContext = await isolatedContext(browser)
  const cContext = await isolatedContext(browser)
  const b = await bContext.newPage()
  const c = await cContext.newPage()
  try {
    await Promise.all([page.goto("/"), b.goto("/"), c.goto("/")])
    await pairWorkspace(page, b)
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    await page.getByRole("dialog", { name: "Device sync" }).getByRole("button", { name: "Stop live sync" }).click()
    await pairWorkspace(page, c)
    await page.close()

    await expect(b.locator(".local-state").first()).toContainText("Live", { timeout: 40_000 })
    await expect(c.locator(".local-state").first()).toContainText("Live", { timeout: 40_000 })
    await addLead(b, "B without owner")
    await expect(c.getByRole("button", { name: "Open B without owner — Engineer" })).toBeVisible({ timeout: 25_000 })
  } finally {
    await Promise.all([bContext.close(), cContext.close()])
  }
})

test("Given an editor is trusted, when owner removes access, then UI marks revocation and peer cannot reconnect", async ({ browser, page }) => {
  test.setTimeout(100_000)
  await page.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
  const guestContext = await isolatedContext(browser)
  const guest = await guestContext.newPage()
  try {
    await Promise.all([page.goto("/"), guest.goto("/")])
    await pairWorkspace(page, guest)
    await page.getByRole("button", { name: "Workspace settings" }).click()
    const settings = page.getByRole("dialog")
    await settings.getByRole("tab", { name: "Your profile" }).click()
    await expect(settings.getByText("Trusted peer devices")).toBeVisible()
    const remove = settings.getByRole("button", { name: "Remove access" }).first()
    await remove.click()
    await expect(settings.getByText("Revoked")).toBeVisible()
    await expect(guest.locator(".local-state").first()).toContainText("Access removed", { timeout: 20_000 })

    await expect(guest.getByRole("button", { name: /Add lead to/ })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Open Revoked write — Engineer" })).toHaveCount(0)
  } finally {
    await guestContext.close()
  }
})
