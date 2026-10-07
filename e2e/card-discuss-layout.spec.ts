import { expect, test } from "./support/coverage"
import { createJobSearchWorkspace } from "./support/workspaces"

for (const width of [390, 1440]) {
  test(`Given ${width}px board and fit score, when Discuss appears on hover or focus then score stays readable and unsent draft survives closing`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/")
    await createJobSearchWorkspace(page, "Card controls")
    await page.getByRole("button", { name: "Add lead to Lead", exact: true }).click()
    const form = page.getByRole("dialog", { name: "Add item" })
    await form.getByLabel("Company *").fill("Reedsy")
    await form.getByLabel("Role *").fill("Senior Ruby Engineer")
    await form.getByLabel("Location", { exact: true }).fill("Remote Europe")
    await form.getByLabel("Fit score").fill("8")
    await form.getByRole("button", { name: "Create item" }).click()
    const details = page.getByRole("dialog", { name: "Lead details" })
    await details.getByRole("button", { name: "Close detail", exact: true }).click()
    const card = page.locator(".item-card").filter({ hasText: "Reedsy" })
    const discuss = card.getByRole("button", { name: /Discuss Reedsy/ })
    for (const activate of [() => card.hover(), () => discuss.focus()]) {
      await activate()
      await expect(discuss).toHaveCSS("opacity", "1")
      const fit = (await card.locator(".fit").boundingBox())!
      const button = (await discuss.boundingBox())!
      expect(fit.x + fit.width + 4).toBeLessThanOrEqual(button.x)
      expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    }
    await card.screenshot({ path: info.outputPath(`card-controls-${width}.png`) })
    await discuss.click()
    const discussion = page.getByRole("dialog", { name: /^Discussion · Reedsy/ })
    await expect(details).toHaveCount(0)
    await expect(discussion.getByRole("button", { name: "Send message", exact: true })).toBeDisabled()
    await discussion.getByRole("textbox", { name: "Message", exact: true }).fill("Unsent card question")
    await discussion.getByRole("button", { name: "Close", exact: true }).click()
    await discuss.focus()
    await discuss.click()
    await expect(discussion.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Unsent card question")
  })
}
