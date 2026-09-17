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
  await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
  await expect(guest.getByLabel("Workspace role: editor")).toBeVisible()
  await guestDialog.getByRole("button", { name: "Close", exact: true }).first().click()
  await hostDialog.getByRole("button", { name: "Close", exact: true }).first().click()
  return invite
}

async function isolatedContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext()
  await context.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
  return context
}

test("Given a legacy local device without metadata, when Sync opens in a known browser, then it shows the current browser and OS", async ({ browser }) => {
  test.setTimeout(120_000)
  const hostContext = await isolatedContext(browser)
  const guestContext = await isolatedContext(browser)
  await hostContext.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "userAgent", { configurable: true, get: () => "" })
  })
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  try {
    await Promise.all([host.goto("/"), guest.goto("/")])
    await pairWorkspace(host, guest)
    await host.evaluate(() => {
      Object.defineProperty(navigator, "userAgent", {
        configurable: true,
        value: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
      })
    })

    await host.getByRole("button", { name: "Sync", exact: true }).click()
    const dialog = host.getByRole("dialog", { name: "Device sync" })
    await dialog.getByRole("list", { name: "Mesh members" }).getByRole("button").filter({ hasText: "You" }).click()
    await expect(dialog.getByRole("list", { name: /Devices for/ })).toContainText("Likely Chrome · Linux")
  } finally {
    await Promise.all([hostContext.close(), guestContext.close()])
  }
})

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

test("Given two connected clients, when exactly one page reloads after a pending network state, then both sides restore live presence", async ({ browser }) => {
  test.setTimeout(120_000)
  const hostContext = await isolatedContext(browser)
  const guestContext = await isolatedContext(browser)
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  try {
    await Promise.all([host.goto("/"), guest.goto("/")])
    await pairWorkspace(host, guest)
    await expect(host.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })

    await guest.evaluate(() => window.dispatchEvent(new Event("offline")))
    await expect(guest.getByLabel("Mesh offline")).toBeVisible()
    await guest.reload()

    await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 35_000 })
    await expect(host.getByLabel("Mesh connected")).toBeVisible({ timeout: 35_000 })
    for (const client of [host, guest]) {
      await client.getByRole("button", { name: "Sync", exact: true }).click()
      const dialog = client.getByRole("dialog", { name: "Device sync" })
      await expect(dialog.getByText("Connected · Live channel active.")).toBeVisible()
      await expect(dialog.locator(".mesh-member-presence.is-online")).toHaveCount(2)
      await dialog.getByRole("button", { name: "Close", exact: true }).first().click()
    }

    await addLead(guest, "After one-sided reload")
    await expect(host.getByRole("button", { name: "Open After one-sided reload — Engineer" })).toBeVisible({ timeout: 20_000 })
  } finally {
    await Promise.all([hostContext.close(), guestContext.close()])
  }
})

test("Given an existing editor, when the owner enrolls another device, then the owner device verifies that editor after reload", async ({ browser, page }) => {
  test.setTimeout(120_000)
  const editorContext = await isolatedContext(browser)
  const phoneContext = await isolatedContext(browser)
  const editor = await editorContext.newPage()
  const phone = await phoneContext.newPage()
  try {
    await Promise.all([page.goto("/"), editor.goto("/"), phone.goto("/")])
    await addLead(page, "Before owner enrollment")
    await pairWorkspace(page, editor)

    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const hostDialog = page.getByRole("dialog", { name: "Device sync" })
    await hostDialog.getByRole("button", { name: "Add someone" }).click()
    await hostDialog.getByRole("button", { name: "Add my device", exact: true }).click()
    await phone.goto(await hostDialog.getByLabel("Pairing link").inputValue())
    const phoneDialog = phone.getByRole("dialog", { name: "Device sync" })
    await phoneDialog.getByRole("button", { name: "Add this device" }).click()
    await hostDialog.getByRole("button", { name: "Approve device" }).click()
    await expect(phoneDialog.getByText("Device enrolled", { exact: true })).toBeVisible({ timeout: 30_000 })
    await phoneDialog.getByRole("button", { name: "Close", exact: true }).first().click()
    await hostDialog.getByRole("button", { name: "Close", exact: true }).first().click()

    await phone.reload()
    await expect(phone.getByLabel("Workspace role: owner")).toBeVisible()
    await expect(phone.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    await expect(phone.getByText(/Invalid workspace grant signature/)).toHaveCount(0)
    await phone.getByRole("button", { name: "Workspace settings" }).click()
    const phoneSettings = phone.getByRole("dialog", { name: "Workspace settings" })
    await phoneSettings.getByRole("tab", { name: "Your profile" }).click()
    await phoneSettings.getByRole("textbox", { name: "Your name", exact: true }).fill("Enrolled owner")
    await phoneSettings.getByRole("button", { name: "Save name", exact: true }).click()
    await expect(phoneSettings.locator(".effective-value")).toHaveText("Enrolled owner")
    await expect(phoneSettings.getByRole("alert")).toHaveCount(0)
    await phoneSettings.getByRole("button", { name: "Dismiss", exact: true }).click()
    await addLead(editor, "Editor after owner enrollment")
    await expect(phone.getByRole("button", { name: "Open Editor after owner enrollment — Engineer" })).toBeVisible({ timeout: 20_000 })
  } finally {
    await Promise.all([editorContext.close(), phoneContext.close()])
  }
})

test("Given trusted devices and multiple tabs, when tabs close and reopen, then each tab keeps an independent channel under one device", async ({ browser, page }) => {
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

    const secondTab = await hostContext.newPage()
    await secondTab.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
    await secondTab.goto("/")
    await expect(secondTab.getByLabel("Mesh connected")).toBeVisible({ timeout: 10_000 })
    await addLead(secondTab, "From second tab")
    await expect(guest.getByRole("button", { name: "Open From second tab — Engineer" })).toBeVisible({ timeout: 20_000 })

    await guest.getByRole("button", { name: "Sync", exact: true }).click()
    const guestDialog = guest.getByRole("dialog", { name: "Device sync" })
    await guestDialog.getByRole("list", { name: "Mesh members" }).getByRole("button").filter({ hasText: "OWNER" }).click()
    await expect(guestDialog.getByText("2 tabs", { exact: true })).toBeVisible({ timeout: 20_000 })
    await guestDialog.getByRole("button", { name: "Close", exact: true }).first().click()

    await host.close()
    await addLead(guest, "After first tab closed")
    await expect(secondTab.getByRole("button", { name: "Open After first tab closed — Engineer" })).toBeVisible({ timeout: 30_000 })
    await secondTab.close()
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
    await expect(syncDialog.getByText(/^Reconnect:/)).toHaveCount(0)
    await expect(syncDialog.locator(".mesh-member-presence.is-online")).toHaveCount(1)
    await expect(syncDialog.locator(".mesh-member-presence.is-offline")).toHaveCount(1)
    const selfMember = syncDialog.getByRole("list", { name: "Mesh members" }).getByRole("button").filter({ hasText: "You" })
    await expect(selfMember).toContainText("1 device · 1 online · You")
    await expect(syncDialog.getByRole("list", { name: "Mesh members" })).toContainText("1 device · 0 online")
    await selfMember.click()
    const selectedMemberFits = await selfMember.evaluate(member => {
      const list = member.parentElement!.getBoundingClientRect()
      const card = member.getBoundingClientRect()
      return card.left >= list.left && card.right + 3 <= list.right && card.bottom + 3 <= list.bottom
    })
    expect(selectedMemberFits).toBe(true)
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
  await guestContext.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "userAgent", { configurable: true, get: () => "" })
  })
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
    const unknownDevices = dialog.getByRole("list", { name: /Devices for/ })
    await expect(unknownDevices.getByRole("listitem")).toHaveCount(1)
    await expect(unknownDevices).toContainText("Browser / OS unknown")
    await expect(dialog.getByRole("button", { name: "Transfer ownership" })).toBeEnabled()
    await dialog.getByRole("button", { name: "Transfer ownership" }).click()

    await expect(page.getByLabel("Workspace role: editor")).toBeVisible({ timeout: 20_000 })
    await expect(guest.getByLabel("Workspace role: owner")).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole("button", { name: "Edit board", exact: true })).toHaveCount(0)
    await expect(guest.getByRole("button", { name: "Edit board", exact: true })).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Add someone" })).toHaveCount(0)
    await expect(dialog.getByRole("button", { name: /^Vote for/ })).toHaveCount(0)
    await expect(dialog.getByText("No recovery policy.", { exact: false })).toBeVisible()
    await guest.getByRole("button", { name: "Sync", exact: true }).click()
    const newOwnerDialog = guest.getByRole("dialog", { name: "Device sync" })
    await newOwnerDialog.getByRole("list", { name: "Mesh members" }).getByRole("button").filter({ hasText: "editor" }).click()
    const knownDevices = newOwnerDialog.getByRole("list", { name: /Devices for/ })
    await expect(knownDevices).toContainText(/Likely Chrome ·/)
    await expect(knownDevices.getByText("User agent", { exact: true })).toBeVisible()
    await newOwnerDialog.getByRole("button", { name: "Add someone" }).click()
    await expect(newOwnerDialog.getByRole("button", { name: "Generate link" })).toBeEnabled()
    await newOwnerDialog.getByRole("button", { name: "Generate link" }).click()
    await expect(newOwnerDialog.getByLabel("Pairing link")).toHaveValue(/workspace-join/)

    await Promise.all([page.reload(), guest.reload()])
    await expect(page.getByLabel("Workspace role: editor")).toBeVisible({ timeout: 20_000 })
    await expect(guest.getByLabel("Workspace role: owner")).toBeVisible({ timeout: 20_000 })
    await guest.getByRole("button", { name: "Workspace settings" }).click()
    const profile = guest.getByRole("dialog", { name: "Workspace settings" })
    await profile.getByRole("tab", { name: "Your profile" }).click()
    await profile.getByRole("textbox", { name: "Your name", exact: true }).fill("Successor owner")
    await profile.getByRole("button", { name: "Save name", exact: true }).click()
    await expect(profile.locator(".effective-value")).toHaveText("Successor owner")
    await expect(profile.getByRole("alert")).toHaveCount(0)

    await page.getByRole("button", { name: "Workspace settings" }).click()
    const formerOwnerProfile = page.getByRole("dialog", { name: "Workspace settings" })
    await formerOwnerProfile.getByRole("tab", { name: "Your profile" }).click()
    await formerOwnerProfile.getByRole("textbox", { name: "Your name", exact: true }).fill("Former owner editor")
    await formerOwnerProfile.getByRole("button", { name: "Save name", exact: true }).click()
    await expect(formerOwnerProfile.locator(".effective-value")).toHaveText("Former owner editor")
    await expect(formerOwnerProfile.getByRole("alert")).toHaveCount(0)
  } finally {
    await guestContext.close()
  }
})


test("Given sibling tabs on both devices, when mesh reconnects concurrently, then connections settle without repeated closure", async ({ browser, page }) => {
  test.setTimeout(100_000)
  const context = await isolatedContext(browser)
  const guest = await context.newPage()
  const messages: string[] = []
  const observe = (target: Page) => target.on("console", message => {
    if (message.text().includes("[match.mesh]")) messages.push(message.text())
  })
  observe(page); observe(guest)
  try {
    await Promise.all([page.goto("/"), guest.goto("/")])
    await pairWorkspace(page, guest)
    const sibling = await context.newPage()
    const ownSibling = await page.context().newPage()
    observe(sibling); observe(ownSibling)
    await Promise.all([sibling.goto("/"), ownSibling.goto("/")])
    await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    await expect(sibling.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    await expect(ownSibling.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(5_000)
    messages.length = 0
    await page.waitForTimeout(12_000)
    const failures = messages.filter(message => /session\.(receive|publish|heartbeat)\.failed/.test(message))
    expect(failures, messages.join("\n")).toHaveLength(0)
    await addLead(ownSibling, "Stable sibling")
    await expect(sibling.getByRole("button", { name: "Open Stable sibling — Engineer" })).toBeVisible({ timeout: 20_000 })
    await ownSibling.close()
  } finally { await context.close() }
})

test("Given an editor has an unsigned change, when sync rejects it, then the channel stays connected and reports the blocked document", async ({ browser, page }) => {
  test.setTimeout(90_000)
  const context = await isolatedContext(browser)
  const guest = await context.newPage()
  try {
    await Promise.all([page.goto("/"), guest.goto("/")])
    await pairWorkspace(page, guest)
    await guest.evaluate(async () => {
      const state = await import("/src/state.ts")
      const storage = await import("/src/storage.ts")
      const A = await import("/@id/@automerge/automerge/slim")
      const doc = state.useMatch().getActiveDoc()!
      const unsigned = A.change(A.clone(doc), {message:"Regression unsigned edit"}, (draft: any) => { draft.title = "Untrusted title" })
      await storage.defaultStorage.saveSnapshot(doc.id, unsigned, A.save(unsigned))
    })
    await guest.reload()
    await page.getByRole("button", {name:"Sync",exact:true}).click()
    const dialog = page.getByRole("dialog",{name:"Device sync"})
    await expect(dialog.getByRole("status").filter({hasText:"Unsigned workspace change rejected"})).toContainText("Unsigned workspace change rejected",{timeout:30_000})
    await expect(dialog.getByRole("status").filter({hasText:"Unsigned workspace change rejected"})).toContainText("Sync issue:")
    await page.waitForTimeout(18_000)
    await expect(page.getByLabel("Mesh connected")).toBeVisible()
    await expect(guest.getByLabel("Mesh connected")).toBeVisible()
    await expect(dialog.getByRole("status").filter({hasText:"Unsigned workspace change rejected"})).toContainText("Regression unsigned edit")
    await expect(page.getByRole("heading",{name:/Untrusted title/})).toHaveCount(0)
  } finally { await context.close() }
})
