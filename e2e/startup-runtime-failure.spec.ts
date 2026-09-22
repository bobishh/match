import { expect, test } from "@playwright/test"

test("Given the Rust runtime request fails, when Match opens, then it identifies the runtime rather than local data", async ({ page }) => {
  await page.route(/\/meta_mesh_bg\.wasm(?:\?.*)?$/, route => route.abort("failed"))

  await page.goto("/")

  const alert = page.getByRole("alert")
  await expect(alert).toContainText("Could not load Match’s local runtime")
  await expect(alert).not.toContainText("Could not open your local data")
})
