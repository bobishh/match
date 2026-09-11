import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test"
import { ensureJobSearchWorkspace } from "./support/workspaces"

async function addLead(page: Page, company: string) {
  await ensureJobSearchWorkspace(page)
  await page.getByRole("button", { name: /Add lead to/ }).first().click()
  await page.getByLabel("Company *").fill(company)
  await page.getByLabel("Role *").fill("Engineer")
  await page.getByRole("button", { name: "Create item" }).click()
  await page.getByRole("button", { name: "Close detail" }).click()
}

async function pairWorkspace(host: Page, guest: Page) {
  await ensureJobSearchWorkspace(host)
  await host.getByRole("button", { name: "Sync", exact: true }).click()
  const hostDialog = host.getByRole("dialog", { name: "Device sync" })
  await hostDialog.getByRole("button", { name: "Add someone" }).click()
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
  return invite
}

async function isolatedContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext()
  await context.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
  return context
}

test("Given a joined workspace with local data, when an editor leaves the mesh, then its copy remains and rejoining requires merge confirmation", async ({ browser, page }) => {
  test.setTimeout(120_000)
  const context = await isolatedContext(browser)
  const guest = await context.newPage()
  try {
    await Promise.all([page.goto("/"), guest.goto("/")])
    await addLead(page, "Kept locally")
    await pairWorkspace(page, guest)

    await guest.getByRole("button", { name: "Sync", exact: true }).click()
    const guestDialog = guest.getByRole("dialog", { name: "Device sync" })
    await guestDialog.getByRole("button", { name: "Leave mesh" }).click()
    await expect(guestDialog.getByText("Workspace data stays on this device.")).toBeVisible()
    await guestDialog.getByRole("button", { name: "Leave mesh, keep copy" }).click()
    await expect(guest.getByLabel("Mesh empty")).toBeVisible({ timeout: 20_000 })
    await expect(guestDialog.getByText(/^Reconnect:/)).toHaveCount(0)
    await expect(guestDialog.getByRole("alert")).toHaveCount(0)
    await expect(guestDialog.getByRole("list", { name: "Mesh members" }).getByRole("button")).toHaveCount(0)
    await expect(guestDialog.getByRole("button", { name: "Leave mesh" })).toHaveCount(0)
    await guestDialog.getByRole("button", { name: "Close", exact: true }).first().click()
    await expect(guest.getByRole("button", { name: "Open Kept locally — Engineer" })).toBeVisible()

    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const hostDialog = page.getByRole("dialog", { name: "Device sync" })
    await hostDialog.getByRole("button", { name: "Add someone" }).click()
    await hostDialog.getByRole("button", { name: "Generate link" }).click()
    await guest.goto(await hostDialog.getByLabel("Pairing link").inputValue())
    await expect(guestDialog.getByRole("heading", { name: "Merge local copy?" })).toBeVisible()
    await expect(guestDialog.getByText("Existing local changes and incoming workspace history will be merged.")).toBeVisible()
    await guestDialog.getByRole("button", { name: "Merge and join" }).click()
    await hostDialog.getByLabel("Participant role").selectOption("editor")
    await hostDialog.getByRole("button", { name: "Approve access" }).click()
    await expect(guestDialog.getByText(/Connected to/)).toBeVisible({ timeout: 30_000 })
  } finally { await context.close() }
})

test("Given a paired editor, when the invitation tab reloads repeatedly, then trust and editing survive and sync resumes without approval", async ({ browser, page }) => {
  test.setTimeout(120_000)
  const context = await isolatedContext(browser)
  const guest = await context.newPage()
  try {
    await Promise.all([page.goto("/"), guest.goto("/")])
    const invite = await pairWorkspace(page, guest)
    const identity = await guest.evaluate(() => JSON.parse(localStorage.getItem("match.local_profile.v1")!).identity.personId)
    for (let i = 0; i < 2; i++) {
      await guest.reload()
      await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
      await expect(guest.getByLabel("Workspace role: editor")).toBeVisible()
      await expect(guest.getByRole("dialog", { name: "Device sync" })).toHaveCount(0)
      expect(await guest.evaluate(() => JSON.parse(localStorage.getItem("match.local_profile.v1")!).identity.personId)).toBe(identity)
      await addLead(guest, `Reload ${i}`)
      await expect(page.getByRole("button", { name: `Open Reload ${i} — Engineer` })).toBeVisible({ timeout: 20_000 })
      await addLead(page, `Host after reload ${i}`)
      await expect(guest.getByRole("button", { name: `Open Host after reload ${i} — Engineer` })).toBeVisible({ timeout: 20_000 })
    }
    // An older client could leave the consumed invitation in its address bar.
    const stale = new URL(invite)
    const params = new URLSearchParams(stale.hash.slice(1))
    params.set("expiresAt", "2020-01-01T00:00:00.000Z")
    stale.hash = params.toString()
    await guest.goto(stale.href)
    await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    await expect(guest.getByRole("dialog", { name: "Device sync" })).toHaveCount(0)
    await expect(guest.getByLabel("Workspace role: editor")).toBeVisible()
    expect(new URL(guest.url()).pathname).toBe("/")
  } finally { await context.close() }
})

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

    const hostContext = page.context()
    await guest.close()
    await page.close()

    const host = await hostContext.newPage()
    await host.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
    guest = await guestContext.newPage()
    await Promise.all([host.goto("/"), guest.goto("/")])
    await expect(host.getByLabel("Mesh connected")).toBeVisible({ timeout: 35_000 })
    await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 35_000 })

    await addLead(guest, "After restart")
    await expect(host.getByRole("button", { name: "Open After restart — Engineer" })).toBeVisible({ timeout: 20_000 })

    const followerTab = await hostContext.newPage()
    await followerTab.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
    await followerTab.goto("/")
    await expect(followerTab.getByLabel("Mesh connected")).toBeVisible({ timeout: 10_000 })
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

test("Given a connected peer closes its tab, when it returns, then presence turns offline and queued changes sync", async ({ browser, page }) => {
  test.setTimeout(90_000)
  await page.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
  const guestContext = await isolatedContext(browser)
  let guest = await guestContext.newPage()
  try {
    await Promise.all([page.goto("/"), guest.goto("/")])
    await pairWorkspace(page, guest)
    await expect(page.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })

    await guest.close()
    await expect(page.getByLabel("Mesh offline")).toBeVisible({ timeout: 20_000 })
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const syncDialog = page.getByRole("dialog", { name: "Device sync" })
    await expect(syncDialog.getByText("Offline · No live channel. Reconnecting automatically.")).toBeVisible()
    await expect(syncDialog.locator(".mesh-member-presence.is-online")).toHaveCount(0)
    await syncDialog.getByRole("button", { name: "Close", exact: true }).last().click()
    await addLead(page, "Queued while closed")

    guest = await guestContext.newPage()
    await guest.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
    await guest.goto("/")
    await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    await expect(guest.getByRole("button", { name: "Open Queued while closed — Engineer" })).toBeVisible({ timeout: 20_000 })
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
    await pairWorkspace(page, c)
    await page.close()

    await expect(b.getByLabel("Mesh connected")).toBeVisible({ timeout: 40_000 })
    await expect(c.getByLabel("Mesh connected")).toBeVisible({ timeout: 40_000 })
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
    await expect(guest.getByLabel("Mesh offline")).toBeVisible({ timeout: 20_000 })

    await expect(guest.getByRole("button", { name: /Add lead to/ })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Open Revoked write — Engineer" })).toHaveCount(0)
  } finally {
    await guestContext.close()
  }
})

test("Given an online editor, when owner selects them in mesh members and transfers ownership, then roles swap across devices", async ({ browser, page }) => {
  test.setTimeout(120_000)
  await page.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
  const guestContext = await isolatedContext(browser)
  const guest = await guestContext.newPage()
  try {
    await Promise.all([page.goto("/"), guest.goto("/")])
    await pairWorkspace(page, guest)
    await expect(page.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })

    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Device sync" })
    const members = dialog.getByRole("list", { name: "Mesh members" })
    await expect(members.locator(".mesh-member")).toHaveCount(2)
    await members.getByRole("button").filter({ hasText: "editor" }).click()
    await expect(dialog.getByRole("button", { name: "Transfer ownership" })).toBeEnabled()
    await dialog.getByRole("button", { name: "Transfer ownership" }).click()

    await expect(page.getByLabel("Workspace role: editor")).toBeVisible({ timeout: 20_000 })
    await expect(guest.getByLabel("Workspace role: owner")).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole("button", { name: "Edit board", exact: true })).toHaveCount(0)
    await expect(guest.getByRole("button", { name: "Edit board", exact: true })).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Add someone" })).toHaveCount(0)
    await guest.getByRole("button", { name: "Sync", exact: true }).click()
    const newOwnerDialog = guest.getByRole("dialog", { name: "Device sync" })
    await newOwnerDialog.getByRole("button", { name: "Add someone" }).click()
    await expect(newOwnerDialog.getByRole("button", { name: "Generate link" })).toBeEnabled()
    await newOwnerDialog.getByRole("button", { name: "Generate link" }).click()
    await expect(newOwnerDialog.getByLabel("Pairing link")).toHaveValue(/workspace-join/)

    await Promise.all([page.reload(), guest.reload()])
    await expect(page.getByLabel("Workspace role: editor")).toBeVisible({ timeout: 20_000 })
    await expect(guest.getByLabel("Workspace role: owner")).toBeVisible({ timeout: 20_000 })
  } finally {
    await guestContext.close()
  }
})
