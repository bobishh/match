import { expect, test } from "@playwright/test"
import { ensureJobSearchWorkspace } from "./support/workspaces"

test.describe("Scoped Sync Outer Scenarios", () => {
  test("Given Sync is opened, when user selects Sync all (Add my device), then it requires mutual approval and displays authentication code before completing enrollment", async ({ browser, page }) => {
    test.setTimeout(120_000)
    const origin = "http://127.0.0.1:4244"
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin })
    const secondContext = await browser.newContext()
    await secondContext.grantPermissions(["clipboard-read", "clipboard-write"], { origin })
    const secondPage = await secondContext.newPage()

    try {
      await page.goto("/")
      await ensureJobSearchWorkspace(page)
      await page.getByRole("button", { name: /Add lead to/ }).first().click()
      await page.getByLabel("Company *").fill("Enrollment proof")
      await page.getByLabel("Role *").fill("Engineer")
      await page.getByRole("button", { name: "Create item" }).click()
      await page.getByRole("button", { name: "Close detail" }).click()
      await page.getByRole("button", { name: "Sync", exact: true }).click()

      const hostDialog = page.getByRole("dialog", { name: "Device sync" })
      // Choose "Sync all" ("Add my device")
      await hostDialog.getByRole("button", { name: "Add someone" }).click()
      await hostDialog.getByRole("button", { name: "Add my device", exact: true }).click()

      // Should show enrollment invitation link / QR
      await expect(hostDialog.getByText("Add your second device")).toBeVisible()
      await hostDialog.getByRole("button", { name: "Copy enrollment link" }).click()
      const inviteLink = await page.evaluate(() => navigator.clipboard.readText())

      await expect(hostDialog.getByRole("button", { name: "Approve device" })).toHaveCount(0)

      // Second device opens invitation
      await secondPage.goto(inviteLink)
      const secondDialog = secondPage.getByRole("dialog", { name: "Device sync" })
      await expect(secondDialog.getByRole("heading", { name: "Add your device" })).toBeVisible()

      // Target device starts pairing and enters waiting approval state
      await secondDialog.getByRole("button", { name: "Add this device" }).click()
      await expect(secondDialog.getByText("Waiting for approval")).toBeVisible()

      await expect(secondPage.getByRole("button", { name: "Open Enrollment proof — Engineer" })).toHaveCount(0)
      await expect(hostDialog.getByLabel("Participant role")).toHaveCount(0)

      // Both devices show the matching authentication code
      const authCodeHost = await hostDialog.locator(".auth-code").innerText()
      const authCodeTarget = await secondDialog.locator(".auth-code").innerText()
      expect(authCodeHost).toBeTruthy()
      expect(authCodeHost).toEqual(authCodeTarget)

      // Host approves second device
      await hostDialog.getByRole("button", { name: "Approve device" }).click()

      // Both devices become connected
      await expect.poll(async () => {
        const failure = await secondDialog.getByRole("alert").textContent({ timeout: 100 }).catch(() => null)
        return failure || await secondDialog.getByText("Device enrolled", { exact: true }).count()
      }, { timeout: 15000 }).toBe(1)
      await expect(hostDialog.getByText("Device enrolled")).toBeVisible()
      await secondDialog.getByRole("button", { name: "Close", exact: true }).first().click()
      await hostDialog.getByRole("button", { name: "Close", exact: true }).first().click()
      await expect(secondPage.getByRole("button", { name: "Open Enrollment proof — Engineer" })).toBeVisible()
      await expect(secondPage.getByLabel("Workspace role: owner")).toBeVisible()
      const identity = (target: typeof page) => target.evaluate(() => JSON.parse(localStorage.getItem("match.local_profile.v1")!).identity.personId)
      expect(await identity(secondPage)).toBe(await identity(page))
      await secondPage.reload()
      await expect(secondPage.getByLabel("Workspace role: owner")).toBeVisible()
      await expect(secondPage.getByRole("button", { name: "Open Enrollment proof — Engineer" })).toBeVisible()
      await expect(secondPage.getByLabel("Mesh connected")).toBeVisible({ timeout: 60_000 })
      await expect(page.getByLabel("Mesh connected")).toBeVisible({ timeout: 60_000 })
      await secondPage.getByRole("button", { name: /Add lead to/ }).first().click()
      await secondPage.getByLabel("Company *").fill("After reload")
      await secondPage.getByLabel("Role *").fill("Engineer")
      await secondPage.getByRole("button", { name: "Create item" }).click()
      await expect(page.getByRole("button", { name: "Open After reload — Engineer" })).toBeVisible({ timeout: 20000 })

    } finally {
      await secondContext.close()
    }
  })

  test("Given Sync is opened, when active workspace is preselected, then Generate link creates a usable single-workspace invite without extra navigation", async ({ browser, page }) => {
    const origin = "http://127.0.0.1:4244"
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin })
    const guestContext = await browser.newContext()
    await guestContext.grantPermissions(["clipboard-read", "clipboard-write"], { origin })
    const guestPage = await guestContext.newPage()

    try {
      await page.goto("/")
      await ensureJobSearchWorkspace(page)
      await page.getByRole("button", { name: "Sync", exact: true }).click()

      const hostDialog = page.getByRole("dialog", { name: "Device sync" })
      await hostDialog.getByRole("button", { name: "Add someone" }).click()
      // Active workspace "Job search" is already preselected
      await expect(hostDialog.getByLabel("Job search")).toBeChecked()
      // Directly click Generate link without preliminary chooser or dropdown navigation
      await hostDialog.getByRole("button", { name: "Generate link" }).click()

      await hostDialog.getByRole("button", { name: "Copy invite link" }).click()
      const inviteLink = await page.evaluate(() => navigator.clipboard.readText())

      // Guest visits the link
      await guestPage.goto(inviteLink)
      const guestDialog = guestPage.getByRole("dialog", { name: "Device sync" })
      await expect(guestDialog.getByRole("heading", { name: "Join workspace" })).toBeVisible()
      await expect(guestDialog.getByText("You have been invited to join Job search")).toBeVisible()

      // Explicit acceptance
      await guestDialog.getByRole("button", { name: "Accept and join" }).click()
      await page.getByLabel("Participant role").selectOption("editor")
      await page.getByRole("button", { name: "Approve access" }).click()
      await expect(guestDialog.getByText("Connected to Job search")).toBeVisible()
    } finally {
      await guestContext.close()
    }
  })

  test("Given multiple workspaces, when user selects A+B, then one invitation is generated for both, recipient sees both names on acceptance, and both connect", async ({ browser, page }) => {
    const origin = "http://127.0.0.1:4244"
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin })
    const guestContext = await browser.newContext()
    await guestContext.grantPermissions(["clipboard-read", "clipboard-write"], { origin })
    const guestPage = await guestContext.newPage()

    try {
      await page.goto("/")
      await ensureJobSearchWorkspace(page)
      // Create a second workspace "Reading list"
      await page.getByRole("button", { name: "Workspaces" }).click()
      await page.getByRole("button", { name: "New workspace" }).click()
      const createDialog = page.getByRole("dialog", { name: "Create workspace" })
      await createDialog.getByLabel("Title").fill("Reading list")
      await createDialog.getByRole("button", { name: "Create" }).click()

      // Open Sync
      await page.getByRole("button", { name: "Sync", exact: true }).click()
      const hostDialog = page.getByRole("dialog", { name: "Device sync" })
      await hostDialog.getByRole("button", { name: "Add someone" }).click()

      // Active workspace "Reading list" is preselected; check "Job search" too
      await expect(hostDialog.getByLabel("Reading list")).toBeChecked()
      await hostDialog.getByLabel("Job search").check()
      expect(await hostDialog.getByLabel("Reading list").isChecked()).toBe(true)
      expect(await hostDialog.getByLabel("Job search").isChecked()).toBe(true)

      // Generate single invitation for the fixed set
      await hostDialog.getByRole("button", { name: "Generate link" }).click()
      await hostDialog.getByRole("button", { name: "Copy invite link" }).click()
      const inviteLink = await page.evaluate(() => navigator.clipboard.readText())

      // Guest visits link
      await guestPage.goto(inviteLink)
      const guestDialog = guestPage.getByRole("dialog", { name: "Device sync" })
      await expect(guestDialog.getByRole("heading", { name: "Join workspace" })).toBeVisible()
      // Recipient acceptance displays selected names
      await expect(guestDialog.locator("li", { hasText: "Reading list" })).toBeVisible()
      await expect(guestDialog.locator("li", { hasText: "Job search" })).toBeVisible()

      await guestDialog.getByRole("button", { name: "Accept and join" }).click()
      await page.getByLabel("Participant role").selectOption("editor")
      await page.getByRole("button", { name: "Approve access" }).click()
      await expect(guestDialog.getByText(/Connected to/i)).toBeVisible()
    } finally {
      await guestContext.close()
    }
  })

  test("Given Sync is opened, when all workspaces are deselected, then Generate link is disabled", async ({ page }) => {
    await page.goto("/")
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const hostDialog = page.getByRole("dialog", { name: "Device sync" })
    await hostDialog.getByRole("button", { name: "Add someone" }).click()

    // Active workspace is initially checked
    const checkbox = hostDialog.getByLabel("Untitled")
    await expect(checkbox).toBeChecked()
    await expect(hostDialog.getByRole("button", { name: "Generate link" })).toBeEnabled()

    // Uncheck it -> empty selection disables generation
    await checkbox.uncheck()
    await expect(checkbox).not.toBeChecked()
    await expect(hostDialog.getByRole("button", { name: "Generate link" })).toBeDisabled()
  })

  test("Given an expired invitation link, when opened, then it reports expiration and prevents connection", async ({ page }) => {
    // Generate an expired invitation URL (expiresAt in the past)
    const expiredInvite = "/pair#v=1&kind=workspace-join&invitationId=expired_1&workspaceId=ws_1&expiresAt=2020-01-01T00:00:00.000Z&endpoint=peer1&secret=abc"
    await page.goto(expiredInvite)

    const dialog = page.getByRole("dialog", { name: "Device sync" })
    await expect(dialog.getByRole("heading", { name: "Couldn’t sync" })).toBeVisible()
    await expect(dialog.getByRole("alert")).toHaveText(/This invitation has expired/i)
    await expect(dialog.getByRole("button", { name: "Connect" })).toHaveCount(0)
  })

  test("Given enrolled devices, when either device reloads, then it retains durable trust without requiring another QR", async ({ browser, page }) => {
    test.setTimeout(120_000)
    const origin = "http://127.0.0.1:4244"
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin })
    const secondContext = await browser.newContext()
    await secondContext.grantPermissions(["clipboard-read", "clipboard-write"], { origin })
    const secondPage = await secondContext.newPage()

    try {
      await page.goto("/")
      await page.getByRole("button", { name: "Sync", exact: true }).click()
      const hostDialog = page.getByRole("dialog", { name: "Device sync" })
      await hostDialog.getByRole("button", { name: "Add someone" }).click()
      await hostDialog.getByRole("button", { name: "Add my device", exact: true }).click()

      await hostDialog.getByRole("button", { name: "Copy enrollment link" }).click()
      const inviteLink = await page.evaluate(() => navigator.clipboard.readText())

      await secondPage.goto(inviteLink)
      const secondDialog = secondPage.getByRole("dialog", { name: "Device sync" })
      await secondDialog.getByRole("button", { name: "Add this device" }).click()
      await hostDialog.getByRole("button", { name: "Approve device" }).click()

      await expect(hostDialog.getByText("Device enrolled")).toBeVisible()
      await expect(secondDialog.getByText("Device enrolled")).toBeVisible()

      const identity = await secondPage.evaluate(() => JSON.parse(localStorage.getItem("match.local_profile.v1")!).identity.personId)
      await secondPage.reload()
      await expect(secondPage.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
      await expect(secondPage.getByLabel("Workspace role: owner")).toBeVisible()
      await page.reload()
      await expect(page.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
      await secondContext.setOffline(true)
      await secondPage.evaluate(() => window.dispatchEvent(new Event("offline")))
      await expect(secondPage.getByLabel("Mesh offline")).toBeVisible({ timeout: 15_000 })
      await expect(secondPage.getByLabel("Workspace role: owner")).toBeVisible()
      await secondContext.setOffline(false)
      await secondPage.evaluate(() => window.dispatchEvent(new Event("online")))
      await expect(secondPage.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
      expect(await secondPage.evaluate(() => JSON.parse(localStorage.getItem("match.local_profile.v1")!).identity.personId)).toBe(identity)
    } finally {
      await secondContext.close()
    }
  })
})


test("Given a real pending device request, when declined, then guest sees refusal and keeps its identity", async ({ page, browser }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const host = page.getByRole("dialog", { name: "Device sync" })
  await host.getByRole("button", { name: "Add someone" }).click()
  await host.getByRole("button", { name: "Add my device", exact: true }).click()
  const context = await browser.newContext()
  try {
    const guest = await context.newPage()
    await guest.goto(await host.getByLabel("Pairing link").inputValue())
    const profile = await guest.evaluate(() => localStorage.getItem("match.local_profile.v1"))
    const dialog = guest.getByRole("dialog", { name: "Device sync" })
    await dialog.getByRole("button", { name: "Add this device" }).click()
    await host.getByRole("button", { name: "Decline device" }).click()
    await expect(dialog.getByRole("alert")).toContainText("declined")
    await expect(host.getByRole("alert")).toContainText("declined")
    expect(await guest.evaluate(() => localStorage.getItem("match.local_profile.v1"))).toBe(profile)
    await expect(dialog.getByText("Device enrolled", { exact: true })).toHaveCount(0)
  } finally { await context.close() }
})

test("Given approved enrollment but failed storage, when receiving identity, then both devices report failure without claiming success", async ({ page, browser }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const host = page.getByRole("dialog", { name: "Device sync" })
  await host.getByRole("button", { name: "Add someone" }).click()
  await host.getByRole("button", { name: "Add my device", exact: true }).click()
  const context = await browser.newContext()
  try {
    const guest = await context.newPage()
    await guest.goto(await host.getByLabel("Pairing link").inputValue())
    const original = await guest.evaluate(() => localStorage.getItem("match.local_profile.v1"))
    await guest.evaluate(async () => {
      const { setStorageFailureHookForTest } = await import('/src/storage.ts')
      setStorageFailureHookForTest(true)
    })
    const dialog = guest.getByRole("dialog", { name: "Device sync" })
    await dialog.getByRole("button", { name: "Add this device" }).click()
    await host.getByRole("button", { name: "Approve device" }).click()
    await expect(dialog.getByRole("alert")).toContainText(/storage|save|injected/i)
    await expect(host.getByRole("alert")).toBeVisible()
    await expect(host.getByText("Device enrolled", { exact: true })).toHaveCount(0)
    expect(await guest.evaluate(() => localStorage.getItem("match.local_profile.v1"))).toBe(original)
  } finally { await context.close() }
})

test("Given a visitor already has the owner's board, when the same device is enrolled, then the board stays and owner access survives reload", async ({ page, browser }) => {
  test.setTimeout(90_000)
  const context = await browser.newContext()
  const guest = await context.newPage()
  try {
    await page.goto("/")
    await ensureJobSearchWorkspace(page)
    await page.getByRole("button", { name: /Add lead to/ }).first().click()
    await page.getByLabel("Company *").fill("Existing shared board")
    await page.getByLabel("Role *").fill("Engineer")
    await page.getByRole("button", { name: "Create item" }).click()
    await page.getByRole("button", { name: "Close detail" }).click()
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const host = page.getByRole("dialog", { name: "Device sync" })
    await host.getByRole("button", { name: "Add someone" }).click()
    await host.getByRole("button", { name: "Generate link" }).click()
    await guest.goto(await host.getByLabel("Pairing link").inputValue())
    const dialog = guest.getByRole("dialog", { name: "Device sync" })
    await dialog.getByRole("button", { name: "Accept and join" }).click()
    await page.getByRole("button", { name: "Approve access" }).click()
    await expect(dialog.getByText(/Connected to/)).toBeVisible()
    await dialog.getByRole("button", { name: "Close", exact: true }).first().click()
    await host.getByRole("button", { name: "Close", exact: true }).first().click()
    await expect(guest.getByLabel("Workspace role: visitor")).toBeVisible()
    const deviceId = await guest.evaluate(() => JSON.parse(localStorage.getItem("match.local_profile.v1")!).device.deviceId)
    await expect(page.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    await host.getByRole("button", { name: "Add someone", exact: true }).click()
    await host.getByRole("button", { name: "Add my device", exact: true }).click()
    await guest.goto(await host.getByLabel("Pairing link").inputValue())
    await dialog.getByRole("button", { name: "Add this device" }).click()
    await host.getByRole("button", { name: "Approve device" }).click()
    await expect(dialog.getByText("Device enrolled", { exact: true })).toBeVisible({ timeout: 30_000 })
    await guest.reload()
    await expect(guest.getByLabel("Workspace role: owner")).toBeVisible()
    await expect(guest.getByRole("button", { name: "Open Existing shared board — Engineer" })).toBeVisible()
    await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    expect(await guest.evaluate(() => JSON.parse(localStorage.getItem("match.local_profile.v1")!).device.deviceId)).toBe(deviceId)
  } finally { await context.close() }
})

test("Given existing data under another identity, when enrollment is approved, then the same device joins the owner and keeps its local board", async ({ page, browser }) => {
  test.setTimeout(90_000)
  await page.goto("/")
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const host = page.getByRole("dialog", { name: "Device sync" })
  await host.getByRole("button", { name: "Add someone" }).click()
  await host.getByRole("button", { name: "Add my device", exact: true }).click()
  const context = await browser.newContext()
  try {
    const guest = await context.newPage()
    await guest.goto("/")
    await ensureJobSearchWorkspace(guest)
    await guest.getByRole("button", { name: /Add lead to/ }).first().click()
    await guest.getByLabel("Company *").fill("Keep my data")
    await guest.getByLabel("Role *").fill("Engineer")
    await guest.getByRole("button", { name: "Create item" }).click()
    await guest.getByRole("button", { name: "Close detail" }).click()
    // This identity previously enabled mesh for its own local board.
    await guest.getByRole("button", { name: "Sync", exact: true }).click()
    const oldIdentityDialog = guest.getByRole("dialog", { name: "Device sync" })
    await oldIdentityDialog.getByRole("button", { name: "Add someone" }).click()
    await oldIdentityDialog.getByRole("button", { name: "Generate link" }).click()
    await expect(oldIdentityDialog.getByLabel("Pairing link")).toHaveValue(/workspace-join/)
    const original = await guest.evaluate(() => localStorage.getItem("match.local_profile.v1"))
    await guest.goto(await host.getByLabel("Pairing link").inputValue())
    const dialog = guest.getByRole("dialog", { name: "Device sync" })
    await dialog.getByRole("button", { name: "Add this device" }).click()
    await expect(host.getByRole("button", { name: "Approve device" })).toBeVisible()
    expect(await guest.evaluate(() => localStorage.getItem("match.local_profile.v1"))).toBe(original)
    await host.getByRole("button", { name: "Approve device" }).click()
    await expect(dialog.getByText("Device enrolled", { exact: true })).toBeVisible()
    await dialog.getByRole("button", { name: "Close", exact: true }).first().click()
    await expect(guest.getByLabel("Workspace role: owner")).toBeVisible()
    const enrolled = await guest.evaluate(() => JSON.parse(localStorage.getItem("match.local_profile.v1")!))
    expect(enrolled.device.deviceId).toBe(JSON.parse(original!).device.deviceId)
    expect(enrolled.identity.personId).toBe(await page.evaluate(() => JSON.parse(localStorage.getItem("match.local_profile.v1")!).identity.personId))
    expect(await guest.evaluate(personId => localStorage.getItem(`match.local_profile.v1.backup.${personId}`), JSON.parse(original!).identity.personId)).toBe(original)
    await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    await expect(guest.getByText(/Invalid workspace grant signature/)).toHaveCount(0)
    await guest.getByRole("button", { name: "Open workspaces" }).click()
    await guest.getByRole("dialog", { name: "Workspaces" }).getByRole("button", { name: /^jobs/ }).click()
    await expect(guest.getByRole("button", { name: "Open Keep my data — Engineer" })).toBeVisible()
  } finally { await context.close() }
})

test("Given a delegated owner device, when it grants an editor access twice, then the editor verifies both grants", async ({ page, browser }) => {
  test.setTimeout(180_000)
  const ownerContext = await browser.newContext()
  const editorContext = await browser.newContext()
  const owner2 = await ownerContext.newPage()
  const editor = await editorContext.newPage()
  try {
    await page.goto("/")
    await ensureJobSearchWorkspace(page)
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const owner1Dialog = page.getByRole("dialog", { name: "Device sync" })
    await owner1Dialog.getByRole("button", { name: "Add someone" }).click()
    await owner1Dialog.getByRole("button", { name: "Add my device", exact: true }).click()
    await owner2.goto(await owner1Dialog.getByLabel("Pairing link").inputValue())
    const owner2Dialog = owner2.getByRole("dialog", { name: "Device sync" })
    await owner2Dialog.getByRole("button", { name: "Add this device" }).click()
    await owner1Dialog.getByRole("button", { name: "Approve device" }).click()
    await expect(owner2Dialog.getByText("Device enrolled", { exact: true })).toBeVisible()
    await owner2Dialog.getByRole("button", { name: "Close", exact: true }).first().click()

    const inviteEditor = async () => {
      await owner2.getByRole("button", { name: "Sync", exact: true }).click()
      await owner2Dialog.getByRole("button", { name: "Add someone" }).click()
      await owner2Dialog.getByRole("button", { name: "Generate link" }).click()
      await editor.goto(await owner2Dialog.getByLabel("Pairing link").inputValue())
      const editorDialog = editor.getByRole("dialog", { name: "Device sync" })
      if (await editorDialog.getByRole("button", { name: "Merge and join" }).count()) await editorDialog.getByRole("button", { name: "Merge and join" }).click()
      else await editorDialog.getByRole("button", { name: "Accept and join" }).click()
      await owner2Dialog.getByLabel("Participant role").selectOption("editor")
      await owner2Dialog.getByRole("button", { name: "Approve access" }).click()
      await expect(editorDialog.getByText(/Connected to/)).toBeVisible({ timeout: 30_000 })
      await editorDialog.getByRole("button", { name: "Close", exact: true }).first().click()
      await owner2Dialog.getByRole("button", { name: "Close", exact: true }).first().click()
    }

    await inviteEditor()
    await editor.getByRole("button", { name: /Add lead to/ }).first().click()
    await editor.getByLabel("Company *").fill("Offline editor history")
    await editor.getByLabel("Role *").fill("Engineer")
    await editor.getByRole("button", { name: "Create item" }).click()
    await editor.getByRole("button", { name: "Close detail" }).click()
    await editor.getByRole("button", { name: "Sync", exact: true }).click()
    const editorDialog = editor.getByRole("dialog", { name: "Device sync" })
    await editorDialog.getByRole("button", { name: "Leave mesh" }).click()
    await editorDialog.getByRole("button", { name: "Leave mesh, keep copy" }).click()
    await editorDialog.getByRole("button", { name: "Close", exact: true }).first().click()
    await inviteEditor()
    await expect(editor.getByLabel("Workspace role: editor")).toBeVisible()
  } finally {
    await ownerContext.close()
    await editorContext.close()
  }
})
