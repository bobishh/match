import { expect, test } from "@playwright/test"

test.describe("Scoped Sync Outer Scenarios", () => {
  test("Given Sync is opened, when user selects Sync all (Add my device), then it requires mutual approval and displays authentication code before completing enrollment", async ({ browser, page }) => {
    const origin = "http://127.0.0.1:4244"
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin })
    const secondContext = await browser.newContext()
    await secondContext.grantPermissions(["clipboard-read", "clipboard-write"], { origin })
    const secondPage = await secondContext.newPage()

    try {
      await page.goto("/")
      await page.getByRole("button", { name: "Sync", exact: true }).click()

      const hostDialog = page.getByRole("dialog", { name: "Device sync" })
      // Choose "Sync all" ("Add my device")
      await hostDialog.getByRole("button", { name: "Sync all", exact: true }).click()

      // Should show enrollment invitation link / QR
      await expect(hostDialog.getByText("Add your second device")).toBeVisible()
      await hostDialog.getByRole("button", { name: "Copy enrollment link" }).click()
      const inviteLink = await page.evaluate(() => navigator.clipboard.readText())

      // Second device opens invitation
      await secondPage.goto(inviteLink)
      const secondDialog = secondPage.getByRole("dialog", { name: "Device sync" })
      await expect(secondDialog.getByRole("heading", { name: "Enroll this device" })).toBeVisible()

      // Target device starts pairing and enters waiting approval state
      await secondDialog.getByRole("button", { name: "Request enrollment" }).click()
      await expect(secondDialog.getByText("Waiting for approval")).toBeVisible()

      // Both devices show the matching authentication code
      const authCodeHost = await hostDialog.locator(".auth-code").innerText()
      const authCodeTarget = await secondDialog.locator(".auth-code").innerText()
      expect(authCodeHost).toBeTruthy()
      expect(authCodeHost).toEqual(authCodeTarget)

      // Host approves second device
      await hostDialog.getByRole("button", { name: "Approve device" }).click()

      // Both devices become connected
      await expect(hostDialog.getByText("Device enrolled")).toBeVisible()
      await expect(secondDialog.getByText("Device enrolled")).toBeVisible()
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
      await page.getByRole("button", { name: "Sync", exact: true }).click()

      const hostDialog = page.getByRole("dialog", { name: "Device sync" })
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
      await expect(guestDialog.getByText("You have been invited to edit Job search")).toBeVisible()

      // Explicit acceptance
      await guestDialog.getByRole("button", { name: "Accept and join" }).click()
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
      // Create a second workspace "Reading list"
      await page.getByRole("button", { name: "Workspaces" }).click()
      await page.getByRole("button", { name: "New workspace" }).click()
      const createDialog = page.getByRole("dialog", { name: "Create workspace" })
      await createDialog.getByLabel("Title").fill("Reading list")
      await createDialog.getByRole("button", { name: "Create" }).click()

      // Open Sync
      await page.getByRole("button", { name: "Sync", exact: true }).click()
      const hostDialog = page.getByRole("dialog", { name: "Device sync" })

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
      await expect(guestDialog.getByText(/Connected to/i)).toBeVisible()
    } finally {
      await guestContext.close()
    }
  })

  test("Given Sync is opened, when all workspaces are deselected, then Generate link is disabled", async ({ page }) => {
    await page.goto("/")
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const hostDialog = page.getByRole("dialog", { name: "Device sync" })

    // Active workspace is initially checked
    const checkbox = hostDialog.getByLabel("Job search")
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
    const origin = "http://127.0.0.1:4244"
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin })
    const secondContext = await browser.newContext()
    await secondContext.grantPermissions(["clipboard-read", "clipboard-write"], { origin })
    const secondPage = await secondContext.newPage()

    try {
      await page.goto("/")
      await page.getByRole("button", { name: "Sync", exact: true }).click()
      const hostDialog = page.getByRole("dialog", { name: "Device sync" })
      await hostDialog.getByRole("button", { name: "Sync all", exact: true }).click()

      await hostDialog.getByRole("button", { name: "Copy enrollment link" }).click()
      const inviteLink = await page.evaluate(() => navigator.clipboard.readText())

      await secondPage.goto(inviteLink)
      const secondDialog = secondPage.getByRole("dialog", { name: "Device sync" })
      await secondDialog.getByRole("button", { name: "Request enrollment" }).click()
      await hostDialog.getByRole("button", { name: "Approve device" }).click()

      await expect(hostDialog.getByText("Device enrolled")).toBeVisible()
      await expect(secondDialog.getByText("Device enrolled")).toBeVisible()

      // Reload second device
      await secondPage.reload()
      // Durable trust persists in storage, board loads properly
      await expect(secondPage.getByRole("heading", { name: "Match" })).toBeVisible()
      await secondPage.getByRole("button", { name: "Sync", exact: true }).click()
      const reloadedDialog = secondPage.getByRole("dialog", { name: "Device sync" })
      // Opening sync opens chooser without starting a node or claiming an un-enrolled state
      await expect(reloadedDialog.getByRole("button", { name: "Sync all" })).toBeVisible()
    } finally {
      await secondContext.close()
    }
  })
})
