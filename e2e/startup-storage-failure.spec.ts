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
