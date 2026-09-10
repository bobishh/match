import { expect, test } from "@playwright/test"

async function addLead(page: import("@playwright/test").Page, input: { company: string; role: string; priority: string; workMode: string; fit: string }) {
  await page.getByRole("button", { name: /Add lead to/ }).first().click()
  const form = page.locator("form.dialog")
  await form.getByLabel("Company *").fill(input.company)
  await form.getByLabel("Role *").fill(input.role)
  await form.getByLabel("Priority").selectOption(input.priority)
  await form.getByLabel("Work mode").selectOption(input.workMode)
  await form.getByLabel("Fit score").fill(input.fit)
  await form.getByRole("button", { name: "Create item" }).click()
  await page.getByRole("button", { name: "Close detail" }).click()
}

test("Given cards still loading on first visit, when Match opens, then delayed progress appears within the board shell", async ({ page }) => {
  await page.addInitScript(() => {
    const instantiateStreaming = WebAssembly.instantiateStreaming.bind(WebAssembly)
    WebAssembly.instantiateStreaming = async (source, imports) => {
      await new Promise<void>((release) => {
        window.addEventListener("match:release-automerge", () => release(), { once: true })
      })
      return instantiateStreaming(source, imports)
    }
  })

  await page.goto("/", { waitUntil: "domcontentloaded" })

  const preloader = page.getByRole("status")
  await expect(preloader).toBeVisible()
  await expect(preloader.getByText("Loading your cards")).toBeVisible()
  await expect(page.locator(".boot-placeholder")).toBeVisible()
  await expect(page.locator(".topbar")).toBeVisible()
  await expect(page.getByRole("region", { name: "Job search" })).toHaveCount(0)

  await page.evaluate(() => window.dispatchEvent(new Event("match:release-automerge")))
  await expect(page.getByRole("region", { name: "Job search" })).toBeVisible()
  await expect(preloader).toHaveCount(0)
})

test("Given a saved base CV, when a generated PDF is attached to a lead, then it keeps template provenance and rejects incomplete artifacts", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Settings" }).click()
  const templates = page.getByRole("dialog", { name: "Workspace settings" })
  await templates.getByLabel("Name").fill("General software CV")
  await templates.getByLabel("Markdown").fill("# Candidate\n\nExperience")
  await templates.getByRole("button", { name: "Save template" }).click()
  await expect(templates.getByRole("button", { name: "General software CV" })).toBeVisible()
  await templates.getByRole("button", { name: "Dismiss" }).click()

  await page.getByRole("button", { name: /Add lead to/ }).first().click()
  await page.getByLabel("Company *").fill("Cleo")
  await page.getByLabel("Role *").fill("Ruby Engineer")
  await page.getByRole("button", { name: "Create item" }).click()

  await page.getByRole("button", { name: "+ PDF" }).click()
  const artifactForm = page.locator("form.document-form").first()
  await artifactForm.getByRole("button", { name: "Attach PDF" }).click()
  await expect(artifactForm.getByRole("alert")).toHaveText("Title, base template, and PDF path required")
  await expect(page.getByText("No generated PDFs")).toBeVisible()

  await artifactForm.getByLabel("Title").fill("Cleo CV")
  await artifactForm.getByLabel("Base template").selectOption({ label: "General software CV" })
  await artifactForm.getByLabel("PDF path").fill("/tmp/cleo-cv.pdf")
  await artifactForm.getByRole("button", { name: "Attach PDF" }).click()

  await expect(page.getByText("Cleo CV")).toBeVisible()
  await expect(page.getByText("CV PDF · from template")).toBeVisible()
})

test("Given an archived card, when Archive opens, then it expands into a filtered column and can collapse again", async ({ page }) => {
  await page.goto("/")
  await addLead(page, { company: "Cleo", role: "Ruby Engineer", priority: "p1", workMode: "remote", fit: "8" })
  await page.getByRole("button", { name: "Open Cleo — Ruby Engineer" }).click()
  await page.getByRole("button", { name: "Archive", exact: true }).click()
  await page.getByRole("button", { name: "Close detail" }).click()

  const board = page.getByRole("region", { name: "Job search" })
  await expect(page.getByRole("button", { name: "Open archive with 1 cards" })).toBeVisible()
  expect(await page.locator(".bin-column").evaluate((element) => getComputedStyle(element).transitionProperty)).toContain("flex-basis")

  await page.getByRole("button", { name: "Open archive with 1 cards" }).click()
  await expect(page.locator(".bin-column")).toHaveClass(/bin-column-open/)
  await expect(page.locator(".bin-column").getByRole("button", { name: "Open Cleo — Ruby Engineer" })).toBeVisible()

  await page.getByPlaceholder("Search company, role, notes").fill("missing")
  await expect(page.getByText("No matching cards", { exact: true })).toBeVisible()
  await expect(page.locator(".board > .column")).toHaveCount(0)
  await page.getByRole("button", { name: "Clear search and filters" }).click()
  await page.getByRole("button", { name: "Collapse archive" }).click()
  await expect(page.getByRole("button", { name: "Open archive with 1 cards" })).toBeVisible()
  await page.getByRole("group", { name: "Filters" }).getByRole("combobox", { name: "Status", exact: true }).selectOption({ label: "Archive" })
  await expect(page.locator(".board > .column")).toHaveCount(1)
  await expect(page.locator(".bin-column")).toHaveClass(/bin-column-open/)
  await expect(page.locator(".bin-column").getByRole("button", { name: "Open Cleo — Ruby Engineer" })).toBeVisible()
  await expect(page.locator(".bin-column").getByText("Remote", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Clear search and filters" }).click()
  await expect(page.getByRole("button", { name: "Open archive with 1 cards" })).toBeVisible()
})

test("Given several leads, when filters intersect, then only matching cards remain and an empty result is explicit", async ({ page }) => {
  await page.goto("/")
  await addLead(page, { company: "Cleo", role: "Ruby", priority: "p0", workMode: "remote", fit: "9" })
  await addLead(page, { company: "VREY", role: "Product", priority: "p3", workMode: "hybrid", fit: "4" })

  const filters = page.getByRole("group", { name: "Filters" })
  await filters.getByLabel("Priority").selectOption({ label: "P1" })
  await expect(page.getByText("No matching cards", { exact: true })).toBeVisible()

  await filters.getByLabel("Priority").selectOption({ label: "P0" })
  await filters.getByLabel("Work mode").selectOption({ label: "Remote" })
  await filters.getByLabel("Fit score minimum").fill("8")
  await expect(page.getByRole("button", { name: "Open Cleo — Ruby" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Open VREY — Product" })).toHaveCount(0)
})

test("Given a mid-size desktop viewport, when Match opens, then the title and filters stay legible without clipped controls", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 })
  await page.goto("/")

  await expect(page.getByRole("heading", { name: "MATCH" })).toBeVisible()
  const toolbar = await page.getByRole("region", { name: "Match controls" }).evaluate((element) => {
    const search = element.querySelector<HTMLElement>(".search-field")!
    const selects = [...element.querySelectorAll<HTMLSelectElement>("select")]
    const workModeLabel = selects.find((select) => select.labels?.[0]?.textContent?.includes("Work mode"))!.labels![0]
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      searchWidth: search.getBoundingClientRect().width,
      selectWidths: selects.map((select) => select.getBoundingClientRect().width),
      workModeLabelHeight: workModeLabel.getBoundingClientRect().height,
    }
  })

  expect(toolbar.scrollWidth).toBeLessThanOrEqual(toolbar.clientWidth)
  expect(toolbar.searchWidth).toBeGreaterThanOrEqual(220)
  expect(Math.min(...toolbar.selectWidths)).toBeGreaterThanOrEqual(150)
  expect(toolbar.workModeLabelHeight).toBeLessThanOrEqual(70)
})

test("Given an iPhone 17e portrait viewport, when Match opens, then filters start closed and columns snap one page at a time", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")

  const filters = page.getByRole("group", { name: "Filters" })
  await expect(filters).toBeHidden()
  await page.getByRole("button", { name: "Filters", exact: true }).click()
  await expect(filters).toBeVisible()

  const layout = await page.locator(".board").evaluate((board) => {
    const column = board.querySelector<HTMLElement>(".column")!
    const styles = getComputedStyle(board)
    return { clientWidth: board.clientWidth, scrollWidth: board.scrollWidth, columnWidth: column.getBoundingClientRect().width, snap: styles.scrollSnapType }
  })
  expect(layout.columnWidth).toBeLessThan(layout.clientWidth)
  expect(layout.scrollWidth).toBeGreaterThan(layout.clientWidth)
  expect(layout.snap).toContain("x")
})

test("Given two tabs on one device, when one tab saves a card, then the other reads and merges IndexedDB without pairing", async ({ page }) => {
  const peer = await page.context().newPage()
  try {
    await page.goto("/")
    await peer.goto("/")

    await addLead(page, { company: "Local-first", role: "Stored workspace", priority: "p1", workMode: "remote", fit: "8" })
    await expect(peer.getByRole("button", { name: "Open Local-first — Stored workspace" })).toBeVisible({ timeout: 5_000 })
  } finally {
    await peer.close()
  }
})

test("Given the board, when Sync is clicked, then workspace selection opens with active workspace checked without starting a node", async ({ page }) => {
  await page.goto("/")
  expect(await page.evaluate(() => performance.getEntriesByType("resource").some((entry) => entry.name.includes("match_iroh")))).toBe(false)

  await page.getByRole("button", { name: "Sync", exact: true }).click()

  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Generate link", exact: true })).toBeVisible()
  await expect(dialog.getByLabel("Job search")).toBeChecked()
  await expect(dialog.getByRole("button", { name: "Sync all", exact: true })).toBeVisible()
  expect(await page.evaluate(() => performance.getEntriesByType("resource").some((entry) => entry.name.includes("match_iroh")))).toBe(false)
})

test("Given clipboard access is denied, when Sync opens, then its pairing link remains selectable for manual copy", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => { throw new DOMException("Clipboard denied", "NotAllowedError") } },
    })
  })
  await page.goto("/")
  await page.getByRole("button", { name: "Sync", exact: true }).click()

  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await dialog.getByRole("button", { name: "Sync all", exact: true }).click()
  const pairingLink = dialog.getByRole("textbox", { name: "Pairing link", exact: true })
  await expect(pairingLink).toHaveValue(/\/pair#/)
  await dialog.getByRole("button", { name: "Copy pairing link" }).click()
  await expect(dialog.getByText("Clipboard unavailable. Select the pairing link and copy it manually.")).toBeVisible()
})

test("Given a malformed pairing link, when Match opens it, then it fails without claiming a sync", async ({ page }) => {
  await page.goto("/pair#v=0.0.1&endpoint=peer-without-secret")

  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await expect(dialog.getByRole("heading", { name: "Couldn’t sync" })).toBeVisible()
  await expect(dialog.getByRole("alert")).toHaveText("This pairing link is invalid.")
  await expect(dialog.getByText("Workspace synced.")).toHaveCount(0)
  await expect(page).toHaveURL(/\/pair#v=0\.0\.1&endpoint=peer-without-secret$/)
  await page.reload()
  await expect(dialog.getByRole("alert")).toHaveText("This pairing link is invalid.")
})

test("Given a QR invitation opened in a scanner, when its current URL opens in another browser then the invitation survives", async ({ page, browser }) => {
  const invite = "/pair#v=1&kind=workspace-join&invitationId=handoff-test&issuerPersonId=p1&issuerDeviceId=d1&issuerPublicKey=pk1&endpoint=ep1&createdAt=2026-01-01T00:00:00.000Z&expiresAt=2099-01-01T00:00:00.000Z&secret=handoff-secret&workspaceId=ws1&workspaceTitle=Handoff+board&role=editor"
  await page.goto(invite)
  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await expect(dialog.getByText("You have been invited to edit Handoff board", { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/\/pair#/)
  const handoffUrl = page.url()
  await page.reload()
  await expect(dialog.getByText("You have been invited to edit Handoff board", { exact: true })).toBeVisible()
  const otherContext = await browser.newContext()
  try {
    const other = await otherContext.newPage()
    await other.goto(handoffUrl)
    await expect(other.getByRole("dialog", { name: "Device sync" }).getByText("You have been invited to edit Handoff board", { exact: true })).toBeVisible()
    await expect(other).toHaveURL(handoffUrl)
  } finally {
    await otherContext.close()
  }
})

test("Given paired browser profiles, when either peer changes a card, then the other board updates without another QR", async ({ browser, page }) => {
  const origin = "http://127.0.0.1:4244"
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin })
  const peerContext = await browser.newContext()
  await peerContext.grantPermissions(["clipboard-read", "clipboard-write"], { origin })
  const peer = await peerContext.newPage()

  try {
    await page.goto("/")
    await page.getByRole("button", { name: /Add lead to/ }).first().click()
    await page.getByLabel("Company *").fill("Cleo")
    await page.getByLabel("Role *").fill("Senior Ruby Engineer")
    await page.getByRole("button", { name: "Create item" }).click()
    await expect(page.getByText("1 card · 0 docs")).toBeVisible()
    await page.getByRole("button", { name: "Close detail" }).click()

    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const hostDialog = page.getByRole("dialog", { name: "Device sync" })
    await hostDialog.getByRole("button", { name: "Sync all", exact: true }).click()
    await expect(hostDialog.getByLabel("Pairing QR code")).toBeVisible({ timeout: 10_000 })
    await hostDialog.getByRole("button", { name: "Copy pairing link" }).click()
    const invite = await page.evaluate(() => navigator.clipboard.readText())

    await peer.goto(invite)
    const peerDialog = peer.getByRole("dialog", { name: "Device sync" })
    await expect(peerDialog.getByRole("button", { name: "Connect to mesh" })).toBeVisible()
    await expect(peerDialog.getByText("Live sync is on. Changes appear in both tabs.")).toHaveCount(0)
    await peerDialog.getByRole("button", { name: "Connect to mesh" }).click()
    await expect(peerDialog.getByText("Live sync is on. Changes appear in both tabs.")).toBeVisible({ timeout: 25_000 })
    await expect(peer).toHaveURL(`${origin}/`)
    await expect(hostDialog.getByText("Live sync is on. Changes appear in both tabs.")).toBeVisible({ timeout: 25_000 })
    await expect(peer.getByText("1 card · 0 docs")).toBeVisible()
    await peerDialog.getByRole("button", { name: "Close" }).click()

    // When the peer makes a later visible change, the already-paired host receives it.
    await peer.getByRole("button", { name: /Add lead to/ }).first().click()
    await peer.getByLabel("Company *").fill("Intercom")
    await peer.getByLabel("Role *").fill("Software Engineer")
    await peer.getByRole("button", { name: "Create item" }).click()

    // Then no second QR or import is needed for the host board to converge.
    await expect(page.getByText("2 cards · 0 docs")).toBeVisible({ timeout: 5_000 })
  } finally {
    await peerContext.close()
  }
})
