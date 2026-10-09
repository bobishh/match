import { expect, test } from "./support/coverage"

for (const [initial, pending] of [[true, false], [false, true]] as const) {
  test(`Given background inert=${initial}, When its requested state becomes ${pending} during a dialog, Then closing restores the latest state`, async ({ page }) => {
    await page.goto("/")
    await page.locator(".boot-placeholder").waitFor({ state: "detached" })
    const header = page.locator(".topbar")
    const sync = page.getByRole("button", { name: "Sync", exact: true })
    await header.evaluate((element, value) => { (element as HTMLElement).inert = value }, initial)
    // Incoming invitations can open this dialog while startup still blocks the header.
    await sync.evaluate(element => (element as HTMLButtonElement).click())
    const dialog = page.getByRole("dialog", { name: "Device sync", exact: true })
    await expect(dialog).toBeVisible()
    await header.evaluate((element, value) => { (element as HTMLElement).inert = value }, pending)
    await expect.poll(() => header.evaluate(element => (element as HTMLElement).inert)).toBe(true)
    await dialog.getByRole("button", { name: "Close", exact: true }).first().click()
    await expect(dialog).toBeHidden()
    await expect.poll(() => header.evaluate(element => (element as HTMLElement).inert)).toBe(pending)
    if (pending) await header.evaluate(element => { (element as HTMLElement).inert = false })
    await sync.click()
    await expect(dialog).toBeVisible()
  })
}
