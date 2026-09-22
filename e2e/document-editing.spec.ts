import { expect, test, type Page } from "@playwright/test"
import { ensureJobSearchWorkspace } from "./support/workspaces"

async function createBlankWorkspace(page: Page) {
  await page.goto("/")
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const create = page.getByRole("dialog", { name: "Create workspace" })
  await create.getByLabel("Title", { exact: true }).fill("Product work")
  await create.getByRole("radio", { name: "Blank board" }).check()
  await create.getByRole("button", { name: "Create", exact: true }).click()
}

async function createGenericCard(page: Page) {
  await page.getByRole("button", { name: "Add item to To do" }).click()
  const form = page.getByRole("dialog", { name: "Item details" })
  await form.getByLabel("Title *").fill("Ship document UX")
  await form.getByLabel("Body").fill("Initial body")
  await form.getByRole("button", { name: "Save item" }).click()
  await page.getByRole("button", { name: "Open Ship document UX" }).click()
}

test("Given a generic card, when Edit is selected, then its visible fields can be changed from the detail view", async ({ page }) => {
  await createBlankWorkspace(page)
  await createGenericCard(page)

  const detail = page.getByRole("dialog", { name: "Item overview" })
  await detail.getByRole("button", { name: "Edit" }).click()
  const editor = page.getByRole("dialog", { name: "Edit item" })
  await editor.getByLabel("Title *").fill("Ship complete document UX")
  await editor.getByLabel("Body").fill("Preview and download work")
  await editor.getByRole("button", { name: "Save changes" }).click()

  await expect(page.getByRole("button", { name: "Open Ship complete document UX" })).toBeVisible()
  await page.getByRole("button", { name: "Open Ship complete document UX" }).click()
  await expect(page.getByRole("dialog", { name: "Item overview" })).toContainText("Preview and download work")
})

test("Given a real file attachment, when it is reopened, then Match can preview and download its persisted bytes", async ({ page }) => {
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  await page.getByRole("button", { name: /Add lead to/ }).first().click()
  const item = page.getByRole("dialog", { name: "Add item" })
  await item.getByLabel("Company *").fill("Docs Inc")
  await item.getByLabel("Role *").fill("Product Engineer")
  await item.getByRole("button", { name: "Create item" }).click()

  await page.getByRole("button", { name: "+ Document" }).click()
  const form = page.getByRole("form", { name: "Attach document" })
  await form.getByLabel("Kind").selectOption("attachment")
  await form.getByLabel("Title").fill("Architecture notes")
  await form.getByLabel("File").setInputFiles({
    name: "architecture.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("MetaMesh owns replication; Match owns product UI."),
  })
  await form.getByRole("button", { name: "Attach" }).click()

  const attachment = page.getByRole("group", { name: "Architecture notes" })
  await expect(attachment).toContainText("architecture.txt")
  await attachment.getByRole("button", { name: "Preview" }).click()
  await expect(page.getByRole("dialog", { name: "Document preview" })).toContainText("MetaMesh owns replication; Match owns product UI.")
  await page.getByRole("dialog", { name: "Document preview" }).getByRole("button", { name: "Close" }).click()

  await page.reload()
  await page.getByRole("button", { name: "Open Docs Inc — Product Engineer" }).click()
  const restored = page.getByRole("group", { name: "Architecture notes" })
  const downloadStarted = page.waitForEvent("download")
  await restored.getByRole("button", { name: "Download" }).click()
  const download = await downloadStarted
  expect(download.suggestedFilename()).toBe("architecture.txt")
})
