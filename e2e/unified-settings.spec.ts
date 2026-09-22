import { expect, test } from "@playwright/test"

test("Given Settings is open, when Recovery backup opens, then recovery stays above Settings and closes back to it", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.getByRole("dialog", { name: "Settings", exact: true })
  await settings.getByRole("tab", { name: "Identity", exact: true }).click()
  await settings.getByRole("button", { name: "Recovery backup", exact: true }).click()

  const recovery = page.getByRole("dialog", { name: "Identity recovery" })
  await expect(recovery.getByRole("heading", { name: "Back up or restore your identity" })).toBeVisible()
  await expect(recovery.getByRole("button", { name: "Restore identity" })).toBeDisabled()
  const recoveryOnTop = await page.locator(".overlay").evaluateAll(overlays => {
    const settingsOverlay = overlays.find(element => element.querySelector('[role="dialog"][aria-label="Settings"]'))!
    const recoveryOverlay = overlays.find(element => element.querySelector('[role="dialog"][aria-label="Identity recovery"]'))!
    return Number(getComputedStyle(recoveryOverlay).zIndex) > Number(getComputedStyle(settingsOverlay).zIndex)
  })
  expect(recoveryOnTop).toBe(true)
  await recovery.getByRole("button", { name: "Close" }).click()
  await expect(recovery).toHaveCount(0)
  await expect(settings.getByRole("button", { name: "Recovery backup", exact: true })).toBeVisible()
})

test("Settings keeps identity available while workspace controls stay role-gated", async ({ page }) => {
  await page.goto("/")
  const actions = page.locator(".top-actions-desktop")

  await expect(actions.getByRole("button", { name: "Settings" })).toHaveCount(1)
  await expect(actions.getByRole("button", { name: "Workspace settings" })).toHaveCount(0)
  await actions.getByRole("button", { name: "Settings" }).click()

  const settings = page.getByRole("dialog", { name: "Settings" })
  await expect(settings.getByRole("tab", { name: "Identity" })).toBeVisible()
  await expect(settings.getByRole("tab", { name: "Your profile" })).toHaveCount(0)
  await expect(settings.getByRole("tab", { name: "Participants" })).toBeVisible()
  await expect(settings.getByRole("tab", { name: "Document templates" })).toBeVisible()
  await settings.getByRole("tab", { name: "Identity" }).click()
  await expect(settings.getByLabel("Name")).toHaveValue(/^[A-Za-z]+ [A-Za-z]+$/)
  await settings.getByLabel("Name").fill("Settings identity")
  await settings.getByRole("button", { name: "Save name" }).click()
  await expect(settings.getByLabel("Name")).toHaveValue("Settings identity")
  const nameWidth = await settings.getByLabel("Name").evaluate(element => element.getBoundingClientRect().width)
  const buttonWidth = await settings.getByRole("button", { name: "Save name" }).evaluate(element => element.getBoundingClientRect().width)
  expect(Math.abs(nameWidth - buttonWidth)).toBeLessThan(1)
  await settings.getByRole("tab", { name: "Participants" }).click()
  await expect(settings.getByRole("listitem").filter({ hasText: "You" })).toContainText("Settings identity")
  await expect(settings.getByRole("listitem").filter({ hasText: "You" })).not.toContainText("Chat name:")
  await settings.getByRole("button", { name: "Dismiss" }).click()

  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const create = page.getByRole("dialog", { name: "Create workspace" })
  await create.getByLabel("Title").fill("Second board")
  await create.getByRole("button", { name: "Create" }).click()
  await expect(page.getByRole("region", { name: "Second board" })).toBeVisible()

  await actions.getByRole("button", { name: "Settings" }).click()
  const secondSettings = page.getByRole("dialog", { name: "Settings" })
  await secondSettings.getByRole("tab", { name: "Identity" }).click()
  await expect(secondSettings.getByLabel("Name")).toHaveValue("Settings identity")
})
