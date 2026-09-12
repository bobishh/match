import { expect, test } from "@playwright/test"

test("Given Device sync members are open, when the user wants to dismiss it, then only the header close control is shown", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Sync", exact: true }).click()

  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toHaveCount(1)
  await expect(dialog.getByText("Close", { exact: true })).toHaveCount(0)
  await dialog.getByRole("button", { name: "Close", exact: true }).click()
  await expect(dialog).toBeHidden()
})
test("Given Device sync shows an invalid-link failure, when it renders recovery actions, then Dismiss remains and Close is not duplicated", async ({ page }) => {
  await page.goto("/pair#invalid")

  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await expect(dialog.getByRole("alert")).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Dismiss", exact: true })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toHaveCount(1)
  await expect(dialog.getByText("Close", { exact: true })).toHaveCount(0)
})
