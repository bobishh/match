import { expect, test } from "@playwright/test"

test("Given local storage fails, when Match opens, then it shows the cause without a reload button", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => {
    (window as Window & { __MATCH_INJECT_STORAGE_FAILURE__?: boolean }).__MATCH_INJECT_STORAGE_FAILURE__ = true
  })

  await page.goto("/")

  const alert = page.getByRole("alert")
  await expect(alert).toContainText("Could not open your local data")
  await expect(alert).toContainText("Error: Storage failure injected")
  await expect(alert).toContainText("Do not clear website data")
  await expect(alert.locator(".startup-error-detail")).toBeInViewport()
  await expect(alert.getByRole("button", { name: "Reload" })).toHaveCount(0)
})

test("Given a saved board cannot open, when a device invitation opens, then pairing remains available and the board error stays visible", async ({ page }) => {
  await page.addInitScript(() => {
    (window as Window & { __MATCH_INJECT_STORAGE_FAILURE__?: boolean }).__MATCH_INJECT_STORAGE_FAILURE__ = true
  })
  const invite = "/pair#v=1&kind=device-enrollment&invitationId=recovery-test&issuerPersonId=person-1&issuerDeviceId=device-1&issuerPublicKey=public-key-1&endpoint=peer-1&createdAt=2026-01-01T00%3A00%3A00.000Z&expiresAt=2099-01-01T00%3A00%3A00.000Z&secret=recovery-secret"

  await page.goto(invite)

  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await expect(dialog.getByRole("button", { name: "Add this device" })).toBeVisible()
  await dialog.getByRole("button", { name: "Close", exact: true }).click()
  await expect(page.getByRole("alert").filter({ hasText: "Could not open your local data" })).toBeVisible()
})
