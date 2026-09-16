import { expect, test, type Page } from "@playwright/test"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createBlankWorkspace(page: Page, title: string) {
  await page.goto("/")
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const dialog = page.getByRole("dialog", { name: "Create workspace" })
  await dialog.getByLabel("Title").fill(title)
  await dialog.getByRole("radio", { name: "Blank board" }).check()
  await dialog.getByRole("button", { name: "Create" }).click()
  await expect(dialog).toBeHidden()
}

/** Add a text + select schema field via the Schema Editor. */
async function addSchemaFields(page: Page) {
  await page.getByRole("button", { name: "Edit board" }).click()
  await page.getByRole("button", { name: "Edit item" }).click()
  const editor = page.locator(".schema-editor-dialog")

  // Add a text field "Notes"
  await editor.getByRole("button", { name: "+ Add field" }).click()
  const addFieldForm = editor.locator(".schema-add-field-form")
  await addFieldForm.getByPlaceholder("e.g. Severity").fill("Notes")
  // type defaults to text
  await addFieldForm.getByRole("button", { name: "Save field" }).click()
  await expect(addFieldForm).toBeHidden()

  // Add a select field "Priority" with options High, Low
  await editor.getByRole("button", { name: "+ Add field" }).click()
  await addFieldForm.getByPlaceholder("e.g. Severity").fill("Priority")
  await addFieldForm.locator("select").selectOption("select")
  await addFieldForm.getByPlaceholder("e.g. Low, Medium, High").fill("High, Low")
  await addFieldForm.getByRole("button", { name: "Save field" }).click()
  await expect(addFieldForm).toBeHidden()

  await editor.getByRole("button", { name: "Review changes" }).click()
  await page.getByRole("button", { name: "Confirm apply" }).click()
  await expect(editor).toBeHidden()
  await page.getByRole("button", { name: "Done" }).click()
}

async function createItem(page: Page, title: string) {
  await page.getByRole("button", { name: /Add item to/ }).first().click()
  const dialog = page.getByRole("dialog", { name: "Item details" })
  await dialog.getByLabel("Title *").fill(title)
  await dialog.getByRole("button", { name: "Save item" }).click()
  await expect(dialog).toBeHidden()
}

async function openCardDetail(page: Page, title: string) {
  await page.getByRole("button", { name: `Open ${title}` }).click()
  await expect(page.getByRole("dialog", { name: "Task overview" })).toBeVisible()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Card editing via task detail", () => {
  test("Given a card with schema fields, when the user edits title and body and saves, then the updated values appear and survive reload", async ({ page }) => {
    // GIVEN
    await createBlankWorkspace(page, "Edit board basic")
    await createItem(page, "Original title")

    // WHEN – open detail, trigger edit
    await openCardDetail(page, "Original title")
    const detail = page.getByRole("dialog", { name: "Task overview" })
    await detail.getByRole("button", { name: "Edit" }).click()

    const editDialog = page.getByRole("dialog", { name: "Edit item" })
    await expect(editDialog).toBeVisible()

    await editDialog.getByLabel("Title *").fill("Updated title")
    await editDialog.getByLabel("Body").fill("Some body text")
    await editDialog.getByRole("button", { name: /Save/i }).click()

    // THEN – edit dialog closes
    await expect(editDialog).toBeHidden()

    // The card now shows the updated title
    await expect(page.getByRole("button", { name: "Open Updated title" })).toBeVisible()

    // THEN – survives reload
    await page.reload()
    await expect(page.getByRole("button", { name: "Open Updated title" })).toBeVisible()
  })

  test("Given a card with select and text schema fields, when the user edits those fields and saves, then the detail view shows updated values", async ({ page }) => {
    // GIVEN – workspace with schema fields
    await createBlankWorkspace(page, "Edit board schema")
    await addSchemaFields(page)
    await createItem(page, "Schemed card")

    // WHEN – open card detail and press Edit
    await openCardDetail(page, "Schemed card")
    const detail = page.getByRole("dialog", { name: "Task overview" })
    await detail.getByRole("button", { name: "Edit" }).click()

    const editDialog = page.getByRole("dialog", { name: "Edit item" })
    await expect(editDialog).toBeVisible()

    // Fill the schema-driven text field "Notes"
    await editDialog.getByLabel("Notes").fill("My important note")

    // Pick "High" in the schema-driven select field "Priority"
    await editDialog.getByLabel("Priority").selectOption({ label: "High" })

    await editDialog.getByRole("button", { name: /Save/i }).click()
    await expect(editDialog).toBeHidden()

    // Re-open detail to verify
    await openCardDetail(page, "Schemed card")
    const detailAfter = page.getByRole("dialog", { name: "Task overview" })
    await expect(detailAfter).toContainText("My important note")
    await expect(detailAfter).toContainText("High")
  })

  test("Given a card, when the user edits and reloads, then custom field values persist", async ({ page }) => {
    // GIVEN
    await createBlankWorkspace(page, "Edit board persist")
    await addSchemaFields(page)
    await createItem(page, "Persist test")

    // WHEN
    await openCardDetail(page, "Persist test")
    const detail = page.getByRole("dialog", { name: "Task overview" })
    await detail.getByRole("button", { name: "Edit" }).click()
    const editDialog = page.getByRole("dialog", { name: "Edit item" })
    await editDialog.getByLabel("Notes").fill("Persisted note")
    await editDialog.getByRole("button", { name: /Save/i }).click()
    await expect(editDialog).toBeHidden()

    // THEN – reload and verify
    await page.reload()
    await openCardDetail(page, "Persist test")
    await expect(page.getByRole("dialog", { name: "Task overview" })).toContainText("Persisted note")
  })

  test("Given a save failure, when edit dialog saves, then it shows an error and does not publish partial data", async ({ page }) => {
    // GIVEN
    await createBlankWorkspace(page, "Edit board failure")
    await createItem(page, "Failure test card")

    // WHEN – open, edit, inject storage failure, save
    await openCardDetail(page, "Failure test card")
    const detail = page.getByRole("dialog", { name: "Task overview" })
    await detail.getByRole("button", { name: "Edit" }).click()
    const editDialog = page.getByRole("dialog", { name: "Edit item" })
    await editDialog.getByLabel("Title *").fill("Should not save")

    await page.evaluate(() => { (window as any).__MATCH_INJECT_STORAGE_FAILURE__ = true })
    await editDialog.getByRole("button", { name: /Save/i }).click()

    // THEN – dialog stays open with an error alert; card still has old title
    await expect(editDialog.getByRole("alert")).toBeVisible()
    await expect(editDialog).toBeVisible()
    // The board does NOT show the new title yet
    await expect(page.getByRole("button", { name: "Open Should not save" })).toHaveCount(0)

    // WHEN – storage restored, retry succeeds
    await page.evaluate(() => { (window as any).__MATCH_INJECT_STORAGE_FAILURE__ = false })
    await editDialog.getByRole("button", { name: /Retry save/i }).click()
    await expect(editDialog).toBeHidden()
    await expect(page.getByRole("button", { name: "Open Should not save" })).toBeVisible()
  })

  test("Given an edit dialog with a dirty draft, when the backdrop is clicked, then the dialog stays open", async ({ page }) => {
    // GIVEN
    await createBlankWorkspace(page, "Edit board draft protect")
    await createItem(page, "Draft protect card")

    // WHEN – open edit dialog and type something
    await openCardDetail(page, "Draft protect card")
    const detail = page.getByRole("dialog", { name: "Task overview" })
    await detail.getByRole("button", { name: "Edit" }).click()
    const editDialog = page.getByRole("dialog", { name: "Edit item" })
    await editDialog.getByLabel("Title *").fill("Edited but not saved")

    // Click outside the dialog
    await page.locator(".overlay").last().click({ position: { x: 5, y: 5 } })

    // THEN – dialog remains visible (draft protection)
    await expect(editDialog).toBeVisible()
    await expect(editDialog.getByLabel("Title *")).toHaveValue("Edited but not saved")
  })

  test("Given an edit dialog, when Cancel is clicked, then the dialog closes without saving", async ({ page }) => {
    // GIVEN
    await createBlankWorkspace(page, "Edit board cancel")
    await createItem(page, "Cancel test card")

    // WHEN
    await openCardDetail(page, "Cancel test card")
    const detail = page.getByRole("dialog", { name: "Task overview" })
    await detail.getByRole("button", { name: "Edit" }).click()
    const editDialog = page.getByRole("dialog", { name: "Edit item" })
    await editDialog.getByLabel("Title *").fill("Cancelled changes")
    await editDialog.getByRole("button", { name: "Cancel" }).click()

    // THEN – dialog closes; board still shows original title
    await expect(editDialog).toBeHidden()
    await expect(page.getByRole("button", { name: "Open Cancel test card" })).toBeVisible()
  })
})
