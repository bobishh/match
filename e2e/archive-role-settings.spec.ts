import { expect, test } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"

test("Given an Archive column, when role moves in column settings, then Archive role stays independent from collapse", async ({ page }) => {
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  await page.getByRole("button", { name: "Edit board" }).click()

  const archive = page.getByRole("region", { name: "Archive", exact: true })
  await archive.getByRole("button", { name: /Open Archive with/ }).click()
  await archive.getByRole("button", { name: "Edit column" }).click()
  const dialog = page.getByRole("dialog", { name: "Edit column" })
  const archiveRole = dialog.getByRole("checkbox", { name: "Designate as Archive column" })
  const collapsible = dialog.getByRole("checkbox", { name: "Allow this column to collapse" })
  await expect(archiveRole).toBeChecked()
  await expect(collapsible).toBeChecked()
  await archiveRole.uncheck()
  await expect(collapsible).toBeChecked()
  await dialog.getByRole("button", { name: "Save" }).click()

  const rejected = page.getByRole("region", { name: "Rejected", exact: true })
  await rejected.getByRole("button", { name: "Edit column" }).click()
  const rejectedDialog = page.getByRole("dialog", { name: "Edit column" })
  const rejectedRole = rejectedDialog.getByRole("checkbox", { name: "Designate as Archive column" })
  const rejectedCollapsible = rejectedDialog.getByRole("checkbox", { name: "Allow this column to collapse" })
  await rejectedRole.check()
  await rejectedCollapsible.uncheck()
  await rejectedDialog.getByRole("button", { name: "Save" }).click()

  await expect(rejected).toHaveClass(/bin-column/)
  await expect(rejected.getByRole("button", { name: "Collapse Rejected" })).toHaveCount(0)
  await expect(archive).not.toHaveClass(/bin-column/)
  await expect(archive.getByRole("button", { name: "Collapse Archive" })).toBeVisible()
})
