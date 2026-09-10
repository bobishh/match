import { expect, test } from "@playwright/test"

for (const width of [1440, 390]) {
  test(`Given a ${width}px viewport, when creating a workspace, then presets stay beside their controls and validation allows recovery`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/")
    await page.getByRole("button", { name: "Open workspaces" }).click()
    await page.getByRole("button", { name: "New workspace" }).click()
    const dialog = page.getByRole("dialog", { name: "Create workspace" })
    for (const name of ["Blank board", "Job search"]) {
      const radio = dialog.getByRole("radio", { name })
      const control = await radio.boundingBox()
      const label = await dialog.getByText(name, { exact: true }).boundingBox()
      expect(control).not.toBeNull()
      expect(label).not.toBeNull()
      expect(control!.width).toBeLessThanOrEqual(24)
      expect(label!.x - control!.x - control!.width).toBeLessThanOrEqual(16)
      expect(Math.abs(label!.y + label!.height / 2 - control!.y - control!.height / 2)).toBeLessThan(2)
    }
    await dialog.getByText("Job search", { exact: true }).click()
    await expect(dialog.getByRole("radio", { name: "Job search" })).toBeChecked()
    await dialog.getByRole("button", { name: "Create", exact: true }).click()
    await expect(dialog.getByRole("alert")).toHaveText("Workspace title is required")
    await dialog.getByLabel("Title", { exact: true }).fill("New job board")
    await dialog.getByRole("button", { name: "Create", exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole("heading", { name: "MATCH // New job board", exact: true })).toBeVisible()
    await expect(page.getByRole("region", { name: "Lead", exact: true })).toBeVisible()
  })
}
