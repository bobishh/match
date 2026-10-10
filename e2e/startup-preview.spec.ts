import { expect, test } from "./support/coverage"
import { createJobSearchWorkspace } from "./support/workspaces"

for (const width of [390, 1440]) for (const fail of [false, true]) test(`Given a saved board at ${width}px, When history checks ${fail ? "fail" : "are pending"}, Then saved cards stay readable beneath a stage status and edits wait for confirmed access`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 })
  await page.goto("/")
  await createJobSearchWorkspace(page, "Saved board")
  await page.evaluate(async () => {
    const app = (await import("/src/state.ts")).useTincanban()
    const A = await import("/@id/@automerge/automerge/slim")
    const storage = (await import("/src/storage.ts")).defaultStorage
    const column = app.genericColumns.value.find(column => column.title === "Lead")!
    await app.executeCommandAsync({ kind: "createItem", id: "saved-preview-card", parentId: column.id, title: "Saved engineer" })
    const saved = app.getActiveDoc()!
    const raw = A.change(A.clone(saved), draft => { draft.entities["saved-preview-card"].title = "Unverified replacement" })
    await storage.commitWorkspace(saved.id, saved, A.save(saved), [], undefined, { bytes: A.save(raw), decisions: [] })
    A.free(raw)
  })
  await page.addInitScript(({ fail }) => {
    const instantiate = WebAssembly.instantiateStreaming.bind(WebAssembly)
    const runtime = new Promise<void>(resolve => window.addEventListener("tincanban:finish-runtime", () => resolve(), { once: true }))
    WebAssembly.instantiateStreaming = async (source, imports) => { await runtime; return instantiate(source, imports) }
    const OriginalWorker = Worker
    window.Worker = class extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        if (options?.name !== "workspace-admission") return
        const send = this.postMessage.bind(this)
        this.postMessage = (message, transfer) => {
          if (message.kind === "access") { Reflect.apply(send, this, [message, transfer]); return }
          window.addEventListener("tincanban:finish-history-check", () => {
            if (fail) this.dispatchEvent(new MessageEvent("message", { data: { id: message.id, error: "History check failed", fatal: true } }))
            else Reflect.apply(send, this, [message, transfer])
          }, { once: true })
        }
      }
    }
  }, { fail })
  await page.reload({ waitUntil: "domcontentloaded" })
  const card = page.locator('[data-item-id="saved-preview-card"]')
  const status = page.getByRole("status", { name: "Board status" })
  await expect(status).toContainText("Starting local checks")
  await expect(page.locator(".toolbar")).toBeVisible()
  const initialStatus = await status.boundingBox()
  await page.evaluate(() => window.dispatchEvent(new Event("tincanban:finish-runtime")))
  await expect(card).toBeVisible()
  await expect(card).toContainText("Saved engineer")
  await expect(page.getByText("Unverified replacement", { exact: true })).toHaveCount(0)
  await expect(status).toContainText("Checking saved changes")
  await expect(status).toContainText("View only")
  await expect(page.locator(".boot-placeholder")).toHaveCount(0)
  await expect(page.getByRole("button", { name: /Add lead to/ })).toHaveCount(0)
  await expect(page.locator('.brand [data-role-stamp="visitor"]')).toHaveCount(0)
  const toolbar = await page.locator(".toolbar").boundingBox()
  const strip = await status.boundingBox()
  expect(Math.abs(strip!.y - initialStatus!.y)).toBeLessThan(2)
  expect(strip!.y).toBeGreaterThanOrEqual(toolbar!.y + toolbar!.height - 1)
  expect(strip!.height).toBeLessThan(64)
  await page.getByRole("searchbox", { name: "Search cards" }).fill("Saved engineer")
  await expect(card).toBeVisible()
  await card.click()
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeDisabled()
  await page.getByRole("button", { name: "Close detail" }).click()
  await page.screenshot({ path: info.outputPath(`preview-${width}.png`) })
  await page.evaluate(() => window.dispatchEvent(new Event("tincanban:finish-history-check")))
  if (fail) {
    await expect(page.getByRole("alert", { name: "Board status" })).toContainText("Saved board is view only")
    await expect(card).toBeVisible()
    await expect(page.getByRole("button", { name: /Add lead to/ })).toHaveCount(0)
  } else {
    await expect(page.getByRole("button", { name: /Add lead to/ }).first()).toBeVisible()
    await expect(status).toHaveCount(0)
    await expect(page.locator('.brand [data-role-stamp="owner"]')).toBeVisible()
    await expect(card).toContainText("Saved engineer")
    await expect(page.getByText("Unverified replacement", { exact: true })).toHaveCount(0)
  }
})
