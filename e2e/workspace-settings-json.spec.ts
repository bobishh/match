import { expect, test, type Page } from "@playwright/test"

async function createBlankWorkspace(page: Page) {
  await page.goto("/")
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const dialog = page.getByRole("dialog", { name: "Create workspace" })
  await dialog.getByLabel("Title").fill("Configurable")
  await dialog.getByRole("radio", { name: "Blank board" }).check()
  await dialog.getByRole("button", { name: "Create" }).click()
}

test.describe("Workspace settings JSON", () => {
  test("Given settings JSON, when one draft changes all settings, then one apply persists them", async ({ page }) => {
    await createBlankWorkspace(page)
    await page.getByRole("button", { name: "Workspace settings" }).click()
    const dialog = page.getByRole("dialog", { name: "Workspace settings" })
    await dialog.getByRole("tab", { name: "JSON" }).click()
    const editor = dialog.getByLabel("Workspace settings JSON")
    const config = JSON.parse(await editor.inputValue())
    config.workspace.title = "Reading"
    config.board.entityName = "book"
    config.board.columns[0].title = "Unread"
    config.board.fields = [{ title: "Author", valueType: "text", required: true }]
    config.documentTemplates = [{ title: "Review", markdown: "# {{title}}" }]
    await editor.fill(JSON.stringify(config, null, 2))
    await dialog.getByRole("button", { name: "Apply JSON" }).click()

    await expect(page.getByText("MATCH // Reading")).toBeVisible()
    await expect(page.getByRole("button", { name: "Add book to Unread" })).toBeVisible()
    await expect(page.getByRole("region", { name: "Unread" })).toBeVisible()
    await page.reload()
    await expect(page.getByRole("button", { name: "Add book to Unread" })).toBeVisible()
  })

  test("Given invalid JSON, when edited, then apply stays blocked with exact path", async ({ page }) => {
    await createBlankWorkspace(page)
    await page.getByRole("button", { name: "Workspace settings" }).click()
    const dialog = page.getByRole("dialog", { name: "Workspace settings" })
    await dialog.getByRole("tab", { name: "JSON" }).click()
    const editor = dialog.getByLabel("Workspace settings JSON")
    const config = JSON.parse(await editor.inputValue())
    config.board.entityName = ""
    await editor.fill(JSON.stringify(config, null, 2))

    await expect(dialog.getByText("/board/entityName")).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Apply JSON" })).toBeDisabled()
  })
})
