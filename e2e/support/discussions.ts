import { expect, type Locator, type Page } from "@playwright/test"

export async function discussObject(page: Page, item: Locator) {
  await item.locator(".detail-head").click({ button: "right", position: { x: 2, y: 2 } })
  const menu = page.getByRole("menu", { name: "Discussion actions" })
  await expect(menu).toBeVisible()
  await menu.getByRole("menuitem", { name: "Discuss", exact: true }).click()
}
