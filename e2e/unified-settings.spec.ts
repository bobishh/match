import { expect, test } from "@playwright/test"

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
  await settings.getByLabel("Name").fill("Settings identity")
  await settings.getByRole("button", { name: "Save name" }).click()
  await expect(settings.getByLabel("Name")).toHaveValue("Settings identity")
  const nameWidth = await settings.getByLabel("Name").evaluate(element => element.getBoundingClientRect().width)
  const buttonWidth = await settings.getByRole("button", { name: "Save name" }).evaluate(element => element.getBoundingClientRect().width)
  expect(Math.abs(nameWidth - buttonWidth)).toBeLessThan(1)
  await settings.getByRole("tab", { name: "Participants" }).click()
  await expect(settings.getByRole("listitem").filter({ hasText: "You" })).toContainText("Settings identity")
  await expect(settings.getByRole("listitem").filter({ hasText: "You" })).toContainText("Chat name:")
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
