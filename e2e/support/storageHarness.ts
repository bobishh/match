import { expect, type Page } from "@playwright/test"

const STORAGE_HARNESS_PATH = "/__e2e_storage_harness__"

/** Serve a same-origin page with no application entry point for storage-only tests. */
export async function openStorageHarness(page: Page): Promise<void> {
  await page.route(`**${STORAGE_HARNESS_PATH}`, route => route.fulfill({
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: "<!doctype html><html><head><title>Storage harness</title></head><body><main data-storage-harness></main></body></html>",
  }))
  await page.goto(STORAGE_HARNESS_PATH)
  await expect(page.locator("[data-storage-harness]")).toHaveCount(1)
  await expect(page.locator("#app")).toHaveCount(0)
  expect(await page.locator("script").count()).toBe(0)
}
