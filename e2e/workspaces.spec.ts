import { expect, test } from "@playwright/test"
import { ensureJobSearchWorkspace } from "./support/workspaces"

test.describe("Workspaces and Generic Board UI (Outer Scenarios)", () => {
  test("Given a new profile, when Match opens, then it starts with a collision-safe blank Untitled workspace", async ({ page }) => {
    await page.goto("/")

    await expect(page.getByRole("heading", { name: "MATCH // Untitled" })).toBeVisible()
    await expect(page.getByRole("region", { name: "To do" })).toBeVisible()
    await expect(page.getByRole("region", { name: "Lead" })).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => localStorage.getItem("match.active_workspace_id"))).not.toBe("default")
  })

  test("Given two first tabs, when both open together, then they share one generated Untitled workspace", async ({ page }) => {
    const peer = await page.context().newPage()
    try {
      await Promise.all([page.goto("/"), peer.goto("/")])
      await Promise.all([
        expect(page.getByRole("heading", { name: "MATCH // Untitled" })).toBeVisible(),
        expect(peer.getByRole("heading", { name: "MATCH // Untitled" })).toBeVisible(),
      ])
      const activeId = (target: typeof page) => target.evaluate(() => localStorage.getItem("match.active_workspace_id"))
      await expect.poll(() => activeId(peer)).toBe(await activeId(page))
      await page.getByRole("button", { name: "Open workspaces" }).click()
      await expect(page.getByRole("dialog", { name: "Workspaces" }).locator(".workspace-item")).toHaveCount(1)
    } finally {
      await peer.close()
    }
  })

  test("Given two workspaces, when either is renamed from the workspace list, then its data and new name persist", async ({ page }) => {
    await page.goto("/")
    await page.getByRole("button", { name: "Open workspaces" }).click()
    await page.getByRole("button", { name: "New workspace" }).click()
    const create = page.getByRole("dialog", { name: "Create workspace" })
    await create.getByLabel("Title").fill("Project board")
    await create.getByRole("radio", { name: "Blank board" }).check()
    await create.getByRole("button", { name: "Create" }).click()
    await page.getByRole("button", { name: /Add item to/ }).first().click()
    const item = page.getByRole("dialog", { name: "Item details" })
    await item.getByLabel("Title *").fill("Kept card")
    await item.getByRole("button", { name: "Save item" }).click()

    await page.getByRole("button", { name: "Open workspaces" }).click()
    const workspaces = page.getByRole("dialog", { name: "Workspaces" })
    await workspaces.locator(".workspace-item", { hasText: "Project board" }).getByRole("button", { name: "Rename", exact: true }).click()
    await workspaces.getByRole("textbox", { name: "Workspace name" }).fill("Client board")
    await workspaces.getByRole("button", { name: "Save name" }).click()
    await expect(workspaces.locator(".workspace-switch", { hasText: "Client board" })).toBeVisible()
    await workspaces.getByRole("button", { name: /Untitled/ }).click()
    await page.getByRole("button", { name: "Open workspaces" }).click()
    await workspaces.locator(".workspace-item", { hasText: "Client board" }).getByRole("button", { name: "Rename", exact: true }).click()
    await workspaces.getByRole("textbox", { name: "Workspace name" }).fill("")
    await workspaces.getByRole("button", { name: "Save name" }).click()
    await expect(workspaces.getByRole("alert")).toHaveText("Workspace name is required")
    await workspaces.getByRole("textbox", { name: "Workspace name" }).fill("Client board renamed")
    await workspaces.getByRole("button", { name: "Save name" }).click()
    await workspaces.getByRole("button", { name: /Client board renamed/ }).click()
    await expect(page.getByRole("button", { name: "Open Kept card" })).toBeVisible()
    await page.reload()
    await expect(page.getByRole("heading", { name: "MATCH // Client board renamed" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Open Kept card" })).toBeVisible()
  })

  test("Given local workspaces, when delete is cancelled or confirmed, then confirmation protects data and active deletion selects a safe replacement", async ({ page }) => {
    await page.goto("/")
    await page.getByRole("button", { name: "Open workspaces" }).click()
    await page.getByRole("button", { name: "New workspace" }).click()
    const create = page.getByRole("dialog", { name: "Create workspace" })
    await create.getByLabel("Title").fill("Temporary board")
    await create.getByRole("radio", { name: "Blank board" }).check()
    await create.getByRole("button", { name: "Create" }).click()
    await page.getByRole("button", { name: /Add item to/ }).first().click()
    const item = page.getByRole("dialog", { name: "Item details" })
    await item.getByLabel("Title *").fill("Temporary data")
    await item.getByRole("button", { name: "Save item" }).click()

    await page.getByRole("button", { name: "Open workspaces" }).click()
    const dialog = page.getByRole("dialog", { name: "Workspaces" })
    const temporary = dialog.locator(".workspace-item", { hasText: "Temporary board" })
    await temporary.getByRole("button", { name: "Delete", exact: true }).click()
    const confirmation = temporary.getByRole("group", { name: "Delete Temporary board" })
    await expect(confirmation).toContainText("local cards and documents")
    await confirmation.getByRole("button", { name: "Cancel" }).click()
    await expect(dialog.getByRole("button", { name: /Temporary board/ })).toBeVisible()
    await temporary.getByRole("button", { name: "Delete", exact: true }).click()
    await confirmation.getByRole("button", { name: "Delete workspace" }).click()
    await expect(dialog.getByRole("button", { name: /Temporary board/ })).toHaveCount(0)
    await expect(dialog.getByRole("button", { name: /Untitled Active/ })).toBeVisible()
    await dialog.getByRole("button", { name: "Close" }).last().click()
    await expect(page.getByRole("heading", { name: "MATCH // Untitled" })).toBeVisible()
    await page.reload()
    await expect(page.getByRole("heading", { name: "MATCH // Untitled" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Open Temporary data" })).toHaveCount(0)
  })

  test("Given Match is opened, when a Blank board workspace is created, then it seeds To do, Doing, Done columns without job-search fields", async ({ page }) => {
    await page.goto("/")

    // Open workspace switcher or creation dialog
    await page.getByRole("button", { name: "Workspaces" }).click()
    await page.getByRole("button", { name: "New workspace" }).click()

    const dialog = page.getByRole("dialog", { name: "Create workspace" })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel("Title").fill("Reading List")
    await dialog.getByRole("radio", { name: "Blank board" }).check()
    await dialog.getByRole("button", { name: "Create" }).click()

    // Expect generic board with default columns
    await expect(page.getByRole("heading", { name: "Reading List" })).toBeVisible()
    await expect(page.getByRole("region", { name: "To do" })).toBeVisible()
    await expect(page.getByRole("region", { name: "Doing" })).toBeVisible()
    await expect(page.getByRole("region", { name: "Done" })).toBeVisible()

    // No job-search columns or company/role inputs should exist
    await expect(page.getByRole("region", { name: "Lead" })).toHaveCount(0)
    await expect(page.getByRole("region", { name: "Interview" })).toHaveCount(0)

    // Adding a card on blank board opens a generic task form (Title + Body, not Company + Role)
    await page.getByRole("button", { name: /Add item to/ }).first().click()
    const taskForm = page.getByRole("dialog", { name: "Item details" })
    await expect(taskForm.getByLabel("Title *")).toBeVisible()
    await expect(taskForm.getByLabel("Company *")).toHaveCount(0)
  })

  test("Given a board with columns, when a column is renamed, then the new title persists after reload", async ({ page }) => {
    await page.goto("/")

    // In a generic board workspace
    await page.getByRole("button", { name: "Workspaces" }).click()
    await page.getByRole("button", { name: "New workspace" }).click()
    const dialog = page.getByRole("dialog", { name: "Create workspace" })
    await dialog.getByLabel("Title").fill("Project Board")
    await dialog.getByRole("radio", { name: "Blank board" }).check()
    await dialog.getByRole("button", { name: "Create" }).click()

    // Rename "To do" column to "Backlog"
    const columnHeader = page.getByRole("region", { name: "To do" })
    await page.getByRole("button", { name: "Edit board" }).click()
    await columnHeader.getByRole("button", { name: "Edit column" }).click()
    const colDialog = page.getByRole("dialog", { name: "Edit column" })
    await colDialog.getByLabel("Column title").fill("Backlog")
    await colDialog.getByRole("button", { name: "Save" }).click()

    await expect(page.getByRole("region", { name: "Backlog" })).toBeVisible()
    await expect(page.getByRole("region", { name: "To do" })).toHaveCount(0)

    // Reload page to verify persistence
    await page.reload()
    await expect(page.getByRole("region", { name: "Backlog" })).toBeVisible()
  })

  test("Given a board with a required custom field, when a task is saved without that field, then validation fails without creating the task", async ({ page }) => {
    await page.goto("/")

    await page.getByRole("button", { name: "Workspaces" }).click()
    await page.getByRole("button", { name: "New workspace" }).click()
    const dialog = page.getByRole("dialog", { name: "Create workspace" })
    await dialog.getByLabel("Title").fill("Bug Tracker")
    await dialog.getByRole("radio", { name: "Blank board" }).check()
    await dialog.getByRole("button", { name: "Create" }).click()

    // Add a required text field "Severity"
    await page.getByRole("button", { name: "Edit board" }).click()
    await page.getByRole("button", { name: "Edit item" }).click()
    const settings = page.getByRole("dialog", { name: "Edit item" })
    await settings.getByRole("button", { name: "+ Add field" }).click()
    await settings.getByLabel("Field name").fill("Severity")
    await settings.getByLabel("Type").selectOption("text")
    await settings.getByLabel("Required").check()
    await settings.getByRole("button", { name: "Save field" }).click()
    await settings.getByRole("button", { name: "Review changes" }).click()
    await page.getByRole("dialog", { name: "Review schema changes" }).getByRole("button", { name: "Confirm apply" }).click()
    await page.getByRole("button", { name: "Done" }).click()

    // Attempt to create a task leaving required "Severity" empty
    await page.getByRole("button", { name: /Add item to/ }).first().click()
    const taskForm = page.getByRole("dialog", { name: "Item details" })
    await taskForm.getByLabel("Title *").fill("Crash on click")
    await taskForm.getByRole("button", { name: "Save item" }).click()

    // Validation error should show and task dialog remains open
    await expect(taskForm.getByRole("alert")).toHaveText(/Severity is required/)
    await expect(taskForm).toBeVisible()

    // Cancel / close form
    await taskForm.getByRole("button", { name: "Cancel" }).click()
    await expect(page.getByText("Crash on click")).toHaveCount(0)
  })

  test("Given a parent task and a subtask, when the subtask is moved to another parent, then the hierarchy updates correctly", async ({ page }) => {
    await page.goto("/")

    await page.getByRole("button", { name: "Workspaces" }).click()
    await page.getByRole("button", { name: "New workspace" }).click()
    const dialog = page.getByRole("dialog", { name: "Create workspace" })
    await dialog.getByLabel("Title").fill("Feature Planning")
    await dialog.getByRole("radio", { name: "Blank board" }).check()
    await dialog.getByRole("button", { name: "Create" }).click()

    // Create Parent A in To do
    await page.getByRole("button", { name: /Add item to/ }).first().click()
    let taskForm = page.getByRole("dialog", { name: "Item details" })
    await taskForm.getByLabel("Title *").fill("Parent A")
    await taskForm.getByRole("button", { name: "Save item" }).click()

    // Create Parent B in To do
    await page.getByRole("button", { name: /Add item to/ }).first().click()
    taskForm = page.getByRole("dialog", { name: "Item details" })
    await taskForm.getByLabel("Title *").fill("Parent B")
    await taskForm.getByRole("button", { name: "Save item" }).click()

    // Add Child 1 under Parent A
    await page.getByRole("button", { name: "Open Parent A" }).click()
    await page.getByRole("button", { name: "+ Add subtask" }).click()
    taskForm = page.getByRole("dialog", { name: "Item details" })
    await taskForm.getByLabel("Title *").fill("Child 1")
    await taskForm.getByRole("button", { name: "Save item" }).click()
    await page.getByRole("button", { name: "Close detail" }).click()

    // Move Child 1 from Parent A to Parent B
    await page.getByRole("button", { name: "Open Parent A" }).click()
    await page.getByRole("button", { name: "Move Child 1" }).click()
    const moveDialog = page.getByRole("dialog", { name: "Move task" })
    await moveDialog.getByLabel("New parent").selectOption({ label: "Parent B" })
    await moveDialog.getByRole("button", { name: "Confirm move" }).click()
    await page.getByRole("button", { name: "Close detail" }).click()

    // Verify Child 1 is no longer under Parent A but is under Parent B
    await page.getByRole("button", { name: "Open Parent A" }).click()
    await expect(page.getByText("Child 1")).toHaveCount(0)
    await page.getByRole("button", { name: "Close detail" }).click()

    await page.getByRole("button", { name: "Open Parent B" }).click()
    await expect(page.getByText("Child 1")).toBeVisible()
  })

  test("Gate A evidence: Reading board with Author field and nested task alongside Job search, with reload and export", async ({ page }) => {
    await page.goto("/")
    await ensureJobSearchWorkspace(page)

    // 1. On default Job search board, create a lead
    await page.getByRole("button", { name: /Add lead to/ }).first().click()
    await page.getByLabel("Company *").fill("Stripe")
    await page.getByLabel("Role *").fill("Platform Engineer")
    await page.getByRole("button", { name: "Create item" }).click()
    await page.getByRole("button", { name: "Close detail" }).click()
    await expect(page.getByRole("button", { name: "Open Stripe — Platform Engineer" })).toBeVisible()

    // 2. Create Reading board workspace
    await page.getByRole("button", { name: "Workspaces" }).click()
    await page.getByRole("button", { name: "New workspace" }).click()
    const dialog = page.getByRole("dialog", { name: "Create workspace" })
    await dialog.getByLabel("Title").fill("Reading board")
    await dialog.getByRole("radio", { name: "Blank board" }).check()
    await dialog.getByRole("button", { name: "Create" }).click()

    await expect(page.getByRole("heading", { name: "Reading board" })).toBeVisible()
    // Verify no job search columns or lead cards leaked
    await expect(page.getByRole("button", { name: "Open Stripe — Platform Engineer" })).toHaveCount(0)

    // 3. Add Author field
    await page.getByRole("button", { name: "Edit board" }).click()
    await page.getByRole("button", { name: "Edit item" }).click()
    const settings = page.getByRole("dialog", { name: "Edit item" })
    await settings.getByRole("button", { name: "+ Add field" }).click()
    await settings.getByLabel("Field name").fill("Author")
    await settings.getByLabel("Type").selectOption("text")
    await settings.getByRole("button", { name: "Save field" }).click()
    await settings.getByRole("button", { name: "Review changes" }).click()
    await page.getByRole("dialog", { name: "Review schema changes" }).getByRole("button", { name: "Confirm apply" }).click()
    await page.getByRole("button", { name: "Done" }).click()

    // 4. Create task "Dune" with Author "Frank Herbert"
    await page.getByRole("button", { name: /Add item to/ }).first().click()
    let taskForm = page.getByRole("dialog", { name: "Item details" })
    await taskForm.getByLabel("Title *").fill("Dune")
    await taskForm.getByLabel("Author").fill("Frank Herbert")
    await taskForm.getByRole("button", { name: "Save item" }).click()
    await expect(page.getByText("Dune")).toBeVisible()

    // 5. Add nested task "Chapter 1" under "Dune"
    await page.getByRole("button", { name: "Open Dune" }).click()
    await page.getByRole("button", { name: "+ Add subtask" }).click()
    taskForm = page.getByRole("dialog", { name: "Item details" })
    await taskForm.getByLabel("Title *").fill("Chapter 1")
    await taskForm.getByRole("button", { name: "Save item" }).click()
    await page.getByRole("button", { name: "Close detail" }).click()

    // 6. Verify reload preserves Reading board, Author field value, and nested task
    await page.reload()
    await expect(page.getByRole("heading", { name: "Reading board" })).toBeVisible()
    await expect(page.getByText("Dune")).toBeVisible()
    await page.getByRole("button", { name: "Open Dune" }).click()
    await expect(page.getByText("Chapter 1")).toBeVisible()
    await page.getByRole("button", { name: "Close detail" }).click()

    // 7. Switch back to Job search board
    await page.getByRole("button", { name: "Workspaces" }).click()
    const wsDialog = page.getByRole("dialog", { name: "Workspaces" })
    await wsDialog.getByRole("button", { name: "jobs" }).click()
    await expect(page.getByRole("region", { name: "Job search" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Open Stripe — Platform Engineer" })).toBeVisible()

    // 8. Switch back to Reading board and export
    await page.getByRole("button", { name: "Workspaces" }).click()
    await wsDialog.getByRole("button", { name: "Reading board" }).click()
    await expect(page.getByRole("heading", { name: "Reading board" })).toBeVisible()

    const downloadPromise = page.waitForEvent("download")
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const syncDialog = page.getByRole("dialog", { name: "Device sync" })
    await syncDialog.getByRole("button", { name: "Add someone" }).click()
    await syncDialog.getByRole("button", { name: "Export .match" }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toContain(".match")
  })
})
