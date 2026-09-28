import { expect, test } from "@playwright/test"

test("Given normal browser storage, when Match starts, then workspace controls load", async ({ page, baseURL }) => {
  await page.goto(baseURL ?? "http://127.0.0.1:4244")
  await expect(page.getByRole("button", { name: "Sync", exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByLabel("Opening workspace")).toHaveCount(0)
})

test("Given legacy journal connection stays open, when app upgrades, then startup reports blocked storage", async ({ browser, baseURL }) => {
  const context = await browser.newContext()
  const holder = await context.newPage()
  await holder.route("**/legacy-holder.html", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Legacy holder</title>" }))
  await holder.goto((baseURL ?? "http://127.0.0.1:4244") + "/legacy-holder.html")
  await holder.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("match-workspace-journal-v1", 1)
    request.onupgradeneeded = () => {
      for (const name of ["changes", "proofs", "receipts", "snapshots", "authorizations"]) {
        const store = request.result.createObjectStore(name, { keyPath: "id" })
        store.createIndex("workspaceId", "workspaceId", { unique: false })
      }
    }
    request.onsuccess = () => { (window as Window & { legacyDb?: IDBDatabase }).legacyDb = request.result; resolve() }
    request.onerror = () => reject(request.error)
  }))
  const app = await context.newPage()
  await app.goto(baseURL ?? "http://127.0.0.1:4244")
  await expect(app.getByRole("alert")).toBeVisible({ timeout: 15_000 })
  await expect(app.getByRole("alert")).toContainText("Could not open your local data")
  await context.close()
})
