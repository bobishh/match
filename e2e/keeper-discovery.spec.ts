import { expect, test } from "@playwright/test"
import { ensureJobSearchWorkspace } from "./support/workspaces"

test("Given an owned board, when a Lighthouse origin is discovered, then Match shows identity, capabilities and pending-only boundary", async ({ page }) => {
  await page.route("http://127.0.0.1:8080/.well-known/mesh-lighthouse", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      protocolVersions: [1],
      service: { personId: "keeper-person", publicKey: "keeper-public-key", deviceId: "keeper-device", certificates: [] },
      displayName: "Test Lighthouse",
      capabilities: { products: ["match"], modes: ["replicate"], documentReplication: true, chatReplication: true, blobReplication: false, pairing: false, provisioning: false },
      publicOrigin: "http://127.0.0.1:8080",
      managementPath: "/admin",
    }),
  }))
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await dialog.getByRole("button", { name: "Add keeper" }).click()
  await dialog.getByRole("textbox", { name: "Keeper hostname" }).fill("http://127.0.0.1:8080")
  await dialog.getByRole("button", { name: "Discover keeper" }).click()
  await expect(dialog.getByRole("heading", { name: "Test Lighthouse" })).toBeVisible()
  await expect(dialog.getByText("Fingerprint")).toBeVisible()
  await expect(dialog.getByText("Job search")).toBeVisible()
  await expect(dialog.getByText("Pairing and provisioning are unavailable")).toBeVisible()
  await expect(dialog.getByText("Connected", { exact: true })).toHaveCount(0)
})

test("Given discovery reports another origin, when Match checks it, then it rejects identity redirection", async ({ page }) => {
  await page.route("http://127.0.0.1:8080/.well-known/mesh-lighthouse", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ protocolVersions: [1], service: { personId: "keeper-person", publicKey: "key", deviceId: "device", certificates: [] }, displayName: "Wrong origin", capabilities: {}, publicOrigin: "https://other.example", managementPath: "/admin" }),
  }))
  await page.goto("/")
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await dialog.getByRole("button", { name: "Add keeper" }).click()
  await dialog.getByRole("textbox", { name: "Keeper hostname" }).fill("http://127.0.0.1:8080")
  await dialog.getByRole("button", { name: "Discover keeper" }).click()
  await expect(dialog.getByRole("alert")).toContainText("origin does not match")
  await expect(dialog.getByRole("heading", { name: "Wrong origin" })).toHaveCount(0)
})
