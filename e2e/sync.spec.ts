import { expect, test } from "@playwright/test"

async function addLead(page: import("@playwright/test").Page, input: { company: string; role: string; priority: string; workMode: string; fit: string }) {
  await page.getByRole("button", { name: "+ Add lead" }).click()
  const form = page.locator("form.dialog")
  await form.getByLabel("Company *").fill(input.company)
  await form.getByLabel("Role *").fill(input.role)
  await form.getByLabel("Priority").selectOption(input.priority)
  await form.getByLabel("Work mode").selectOption(input.workMode)
  await form.getByLabel("Fit score").fill(input.fit)
  await form.getByRole("button", { name: "Create card" }).click()
  await page.getByRole("button", { name: "Close detail" }).click()
}

test("Given several leads, when filters intersect, then only matching cards remain and an empty result is explicit", async ({ page }) => {
  await page.goto("/")
  await addLead(page, { company: "Cleo", role: "Ruby", priority: "p0", workMode: "remote", fit: "9" })
  await addLead(page, { company: "VREY", role: "Product", priority: "p3", workMode: "hybrid", fit: "4" })

  const filters = page.getByRole("group", { name: "Filters" })
  await filters.getByLabel("Priority").selectOption("p1")
  await expect(page.getByText("No cards").first()).toBeVisible()

  await filters.getByLabel("Priority").selectOption("p0")
  await filters.getByLabel("Work mode").selectOption("remote")
  await filters.getByLabel("Fit").selectOption("strong")
  await expect(page.getByRole("button", { name: "Drag Cleo — Ruby" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Drag VREY — Product" })).toHaveCount(0)
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
  expect(layout.columnWidth).toBeGreaterThanOrEqual(350)
  expect(layout.scrollWidth).toBeGreaterThan(layout.clientWidth)
  expect(layout.snap).toContain("x")
})

test("Given two tabs on one device, when one tab saves a card, then the other reads and merges IndexedDB without pairing", async ({ page }) => {
  const peer = await page.context().newPage()
  try {
    await page.goto("/")
    await peer.goto("/")

    await addLead(page, { company: "Local-first", role: "Stored workspace", priority: "p1", workMode: "remote", fit: "8" })
    await expect(peer.getByRole("button", { name: "Drag Local-first — Stored workspace" })).toBeVisible({ timeout: 5_000 })
  } finally {
    await peer.close()
  }
})

test("Given the board, when Sync is clicked, then pairing opens without a second start action", async ({ page }) => {
  await page.goto("/")
  expect(await page.evaluate(() => performance.getEntriesByType("resource").some((entry) => entry.name.includes("match_iroh")))).toBe(false)

  await page.getByRole("button", { name: "Sync", exact: true }).click()

  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole("heading", { name: "Pair a device" })).toBeVisible()
  await expect(dialog.getByText(/Preparing your pairing QR|Scan this with your other device/)).toBeVisible()
  await expect(dialog.getByText(/Iroh|Automerge|WASM|Wait for device|Connect \+ sync/)).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => performance.getEntriesByType("resource").some((entry) => entry.name.includes("match_iroh")))).toBe(true)
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
  const pairingLink = dialog.getByRole("textbox", { name: "Pairing link", exact: true })
  await expect(pairingLink).toHaveValue(/\/pair#v=0\.0\.1&endpoint=/)
  await dialog.getByRole("button", { name: "Copy pairing link" }).click()
  await expect(dialog.getByText("Clipboard unavailable. Select the pairing link and copy it manually.")).toBeVisible()
})

test("Given a malformed pairing link, when Match opens it, then it fails without claiming a sync", async ({ page }) => {
  await page.goto("/pair#v=0.0.1&endpoint=peer-without-secret")

  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await expect(dialog.getByRole("heading", { name: "Couldn’t sync" })).toBeVisible()
  await expect(dialog.getByRole("alert")).toHaveText("This pairing link is invalid.")
  await expect(dialog.getByText("Workspace synced.")).toHaveCount(0)
})

test("Given paired browser profiles, when either peer changes a card, then the other board updates without another QR", async ({ browser, page }) => {
  const origin = "http://127.0.0.1:4244"
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin })
  const peerContext = await browser.newContext()
  await peerContext.grantPermissions(["clipboard-read", "clipboard-write"], { origin })
  const peer = await peerContext.newPage()

  try {
    await page.goto("/")
    await page.getByRole("button", { name: "+ Add lead" }).click()
    await page.getByLabel("Company *").fill("Cleo")
    await page.getByLabel("Role *").fill("Senior Ruby Engineer")
    await page.getByRole("button", { name: "Create card" }).click()
    await expect(page.getByText("1 cards · 0 docs")).toBeVisible()
    await page.getByRole("button", { name: "Close detail" }).click()

    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const hostDialog = page.getByRole("dialog", { name: "Device sync" })
    await expect(hostDialog.getByLabel("Pairing QR code")).toBeVisible({ timeout: 10_000 })
    await hostDialog.getByRole("button", { name: "Copy pairing link" }).click()
    const invite = await page.evaluate(() => navigator.clipboard.readText())

    await peer.goto(invite)
    const peerDialog = peer.getByRole("dialog", { name: "Device sync" })
    await expect(peerDialog.getByRole("button", { name: "Connect to mesh" })).toBeVisible()
    await expect(peerDialog.getByText("Live sync is on. Changes appear in both tabs.")).toHaveCount(0)
    await peerDialog.getByRole("button", { name: "Connect to mesh" }).click()
    await expect(peerDialog.getByText("Live sync is on. Changes appear in both tabs.")).toBeVisible({ timeout: 25_000 })
    await expect(hostDialog.getByText("Live sync is on. Changes appear in both tabs.")).toBeVisible({ timeout: 25_000 })
    await expect(peer.getByText("1 cards · 0 docs")).toBeVisible()
    await peerDialog.getByRole("button", { name: "Close" }).click()

    // When the peer makes a later visible change, the already-paired host receives it.
    await peer.getByRole("button", { name: "+ Add lead" }).click()
    await peer.getByLabel("Company *").fill("Intercom")
    await peer.getByLabel("Role *").fill("Software Engineer")
    await peer.getByRole("button", { name: "Create card" }).click()

    // Then no second QR or import is needed for the host board to converge.
    await expect(page.getByText("2 cards · 0 docs")).toBeVisible({ timeout: 5_000 })
  } finally {
    await peerContext.close()
  }
})
