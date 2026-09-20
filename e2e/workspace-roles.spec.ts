import { expect, test } from "@playwright/test"
import { ensureJobSearchWorkspace } from "./support/workspaces"

for (const role of ["visitor", "editor"] as const) {
  test(`Given an owner and pending guest, when approved as ${role}, then role controls writes and board settings`, async ({ page, browser }) => {
    test.setTimeout(60000)
    await page.goto("/")
    await ensureJobSearchWorkspace(page)
    await expect(page.getByLabel("Workspace role: owner")).toBeVisible()
    await expect(page.getByLabel("Mesh empty")).toBeVisible()
    await page.getByRole("button", { name: /Add lead to/ }).first().click()
    await page.getByLabel("Company *").fill("Role test")
    await page.getByLabel("Role *").fill("Engineer")
    await page.getByRole("button", { name: "Create item" }).click()
    await page.getByRole("button", { name: "Close detail" }).click()
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const host = page.getByRole("dialog", { name: "Device sync" })
    await host.getByRole("button", { name: "Add someone" }).click()
    await host.getByRole("button", { name: "Generate link" }).click()
    const context = await browser.newContext()
    try {
      const guest = await context.newPage()
      await guest.goto(await host.getByLabel("Pairing link").inputValue())
      const dialog = guest.getByRole("dialog", { name: "Device sync" })
      await dialog.getByRole("button", { name: "Accept and join" }).click()
      await expect(host.getByRole("region", { name: "Access request" })).toContainText("wants to join")
      await expect(host.getByLabel("Participant role")).toHaveValue("visitor")
      await expect(dialog.getByText(/Connected to/)).toHaveCount(0)
      await host.getByLabel("Participant role").selectOption(role)
      await host.getByRole("button", { name: "Approve access" }).click()
      await expect(dialog.getByText(/Connected to/)).toBeVisible({ timeout: 25000 })
      await dialog.getByRole("button", { name: "Close", exact: true }).first().click()
      await host.getByRole("button", { name: "Close", exact: true }).first().click()
      await expect(guest.getByLabel(`Workspace role: ${role}`)).toBeVisible()
      await expect(guest.getByRole("button", { name: "Edit board", exact: true })).toHaveCount(0)
      await guest.getByRole("button", { name: "Open workspaces" }).click()
      const workspaces = guest.getByRole("dialog", { name: "Workspaces" })
      const activeWorkspace = workspaces.locator(".workspace-item-active")
      if (role === "editor") await expect(activeWorkspace.getByRole("button", { name: "Rename", exact: true })).toBeVisible()
      else await expect(activeWorkspace.getByRole("button", { name: "Rename", exact: true })).toHaveCount(0)
      await workspaces.getByRole("button", { name: "Close", exact: true }).last().click()
      await guest.getByRole("button", { name: "Sync", exact: true }).click()
      const guestSync = guest.getByRole("dialog", { name: "Device sync" })
      await expect(guestSync.getByRole("button", { name: "Import .match" })).toHaveCount(0)
      await guestSync.getByRole("button", { name: "Close", exact: true }).first().click()
      const rejection = await guest.evaluate(async () => {
        const { useMatch } = await import('/src/state.ts')
        const state = useMatch()
        try { await state.executeCommandAsync({ kind: 'renameWorkspace', title: 'editor renamed' }); return 'allowed' }
        catch (error) { return String(error) }
      })
      if (role === 'visitor') expect(rejection).toContain('Visitors can only view')
      else expect(rejection).toBe('allowed')
      if (role === "visitor") {
        await expect(guest.getByRole("button", { name: /Add lead to/ })).toHaveCount(0)
        await guest.getByRole("button", { name: "Open Role test — Engineer" }).click()
        await expect(guest.locator('.status-strip button').first()).toBeDisabled()
      } else {
        await guest.getByRole("button", { name: "Open Role test — Engineer" }).click()
        await guest.locator('.status-strip button').filter({ hasText: 'Interview' }).click()
        await expect(page.getByRole("region", { name: "Interview", exact: true }).getByRole("button", { name: "Open Role test — Engineer" })).toBeVisible({ timeout: 15000 })
      }
      await guest.reload()
      await expect(guest.getByLabel(`Workspace role: ${role}`)).toBeVisible()
    } finally { await context.close() }
  })
}

test("Given a pending access request, when the owner declines, then no shared workspace arrives", async ({ page, browser }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const host = page.getByRole("dialog", { name: "Device sync" })
  await host.getByRole("button", { name: "Add someone" }).click()
  await host.getByRole("button", { name: "Generate link" }).click()
  const context = await browser.newContext()
  try {
    const guest = await context.newPage()
    await guest.goto(await host.getByLabel("Pairing link").inputValue())
    const dialog = guest.getByRole("dialog", { name: "Device sync" })
    await dialog.getByRole("button", { name: "Accept and join" }).click()
    await expect(host.getByLabel("Participant role")).toHaveValue("visitor")
    await host.getByRole("button", { name: "Decline", exact: true }).click()
    await expect(dialog.getByRole("alert")).toContainText("declined")
    await expect(dialog.getByText(/Connected to/)).toHaveCount(0)
  } finally { await context.close() }
})
