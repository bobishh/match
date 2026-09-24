import { expect, test } from "@playwright/test"

test("idle cards age while the page stays open and reviewing them restores freshness", async ({ page }, testInfo) => {
  await page.clock.install({ time: new Date("2026-09-01T12:00:00Z") })
  await page.goto("/")
  const id = await page.evaluate(async () => {
    const { useMatch } = await import("/src/state.ts")
    const match = useMatch()
    await match.whenReady()
    await match.createWorkspaceAsync("Aging demo", "blank")
    const column = Object.values(match.getActiveDoc()!.entities).find(entity => entity.kind === "column" && entity.title === "To do")!
    const id = crypto.randomUUID()
    await match.executeCommandAsync({ kind: "createItem", id, parentId: column.id, title: "Follow up on interview" })
    return id
  })
  const card = page.locator(`[data-item-id="${id}"]`)
  await expect(card).toHaveClass(/card-aging-fresh/)
  await page.clock.fastForward(15 * 86_400_000)
  await expect(card).toHaveClass(/card-aging-aged/)
  await expect(card).toContainText("No activity for 15 days")
  await page.screenshot({ path: testInfo.outputPath("aged-board.png"), fullPage: true })
  await card.click()
  await page.getByRole("button", { name: "Reviewed", exact: true }).click()
  await expect(card).toHaveClass(/card-aging-fresh/)
  await expect(card).not.toContainText("No activity")
})

test("aging threshold changes are explained before applying", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => {
    const { useMatch } = await import("/src/state.ts")
    const match = useMatch()
    await match.whenReady()
    await match.createWorkspaceAsync("Aging settings", "blank")
  })
  await page.getByRole("button", { name: "Edit board", exact: true }).click()
  await page.getByRole("button", { name: "Edit item", exact: true }).click()
  await page.getByLabel("Watch after days").fill("3")
  await page.getByRole("button", { name: "Review changes" }).click()
  const preview = page.getByRole("dialog", { name: "Preview schema changes" })
  await expect(preview).toContainText("Card aging: 7 / 14 / 30 → 3 / 14 / 30 days")
  await preview.getByRole("button", { name: "Confirm apply" }).click()
  await expect(page.getByText("Schema updated", { exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole("button", { name: "Edit board", exact: true }).click()
  await page.getByRole("button", { name: "Edit item", exact: true }).click()
  await expect(page.getByLabel("Watch after days")).toHaveValue("3")
})
