import { expect, test } from "@playwright/test"

test("Given an existing v0 IndexedDB workspace, when Match upgrades, then legacy cards survive migration and reload", async ({ page }) => {
  await page.goto("/")

  await page.evaluate(async () => {
    localStorage.clear()

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("match", 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("workspace")) {
          request.result.createObjectStore("workspace")
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })

    const legacy = {
      workspace: {
        leads: [{
          id: "legacy_lead",
          company: "Legacy Corp",
          role: "Staff Engineer",
          status: "interview",
          priority: "p1",
          createdAt: "2026-01-01T10:00:00.000Z",
          updatedAt: "2026-01-02T10:00:00.000Z",
        }],
        documents: [],
        templates: [],
        artifacts: [],
      },
    }

    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("workspace", "readwrite")
      transaction.objectStore("workspace").put(legacy, "default")
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    database.close()
  })

  await page.reload()
  await expect(page.getByRole("button", { name: "Open Legacy Corp — Staff Engineer" })).toBeVisible()

  await page.reload()
  await expect(page.getByRole("button", { name: "Open Legacy Corp — Staff Engineer" })).toBeVisible()
})

test("Given an existing v0 IndexedDB workspace with a rejected lead, when Match upgrades, then it appears in the Rejected column and survives reload", async ({ page }) => {
  await page.goto("/")

  await page.evaluate(async () => {
    localStorage.clear()

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("match", 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("workspace")) {
          request.result.createObjectStore("workspace")
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })

    const legacy = {
      workspace: {
        leads: [{
          id: "legacy_rejected_lead",
          company: "Rejected Corp",
          role: "Staff Engineer",
          status: "rejected",
          priority: "p1",
          createdAt: "2026-01-01T10:00:00.000Z",
          updatedAt: "2026-01-02T10:00:00.000Z",
        }],
        documents: [],
        templates: [],
        artifacts: [],
      },
    }

    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("workspace", "readwrite")
      transaction.objectStore("workspace").put(legacy, "default")
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    database.close()
  })

  await page.reload()
  const rejectedCol = page.locator(".column-rejected")
  await expect(rejectedCol).toBeVisible()
  await expect(rejectedCol.getByRole("button", { name: "Open Rejected Corp — Staff Engineer" })).toBeVisible()

  await page.reload()
  await expect(rejectedCol.getByRole("button", { name: "Open Rejected Corp — Staff Engineer" })).toBeVisible()
})
