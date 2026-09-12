import { expect, test, type Page } from "@playwright/test"
import { ensureJobSearchWorkspace } from "./support/workspaces"

async function openChat(page: Page) {
  await page.getByRole("button", { name: "Workspace chat", exact: true }).filter({ visible: true }).click()
  return page.getByRole("dialog", { name: "Workspace chat", exact: true })
}

async function profileSettings(page: Page) {
  if ((page.viewportSize()?.width ?? 1280) < 768) await page.getByRole("button", { name: "Menu", exact: true }).click()
  await page.getByRole("button", { name: "Workspace settings", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Workspace settings", exact: true })
  await dialog.getByRole("tab", { name: "Your profile" }).click()
  return dialog
}

for (const width of [1280, 375]) {
  test(`Given a ${width}px workspace, when I name myself and send a message, then both persist after reload`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/")
    let settings = await profileSettings(page)
    await expect(settings.getByRole("textbox", { name: "Your name", exact: true })).not.toHaveValue("")
    await settings.getByRole("textbox", { name: "Your name", exact: true }).fill("Тревожная мимоза")
    await settings.getByRole("button", { name: "Save name", exact: true }).click()
    await expect(settings.locator(".effective-value")).toHaveText("Тревожная мимоза")
    await settings.getByRole("button", { name: "Dismiss", exact: true }).click()
    let chat = await openChat(page)
    await expect(chat.getByRole("button", { name: "Send message" })).toBeDisabled()
    await chat.getByRole("textbox", { name: "Message", exact: true }).fill("Hello workspace <script>alert(1)</script>")
    await chat.getByRole("button", { name: "Send message" }).click()
    await expect(chat.getByText("Hello workspace <script>alert(1)</script>", { exact: true })).toBeVisible()
    await expect(chat.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("")
    await expect(chat.locator(".chat-message-author")).toHaveText("Тревожная мимоза")
    const geometry = await chat.evaluate(el => ({ width: el.clientWidth, content: el.scrollWidth }))
    expect(geometry.content).toBeLessThanOrEqual(geometry.width)
    await page.reload()
    chat = await openChat(page)
    await expect(chat.getByText("Hello workspace <script>alert(1)</script>", { exact: true })).toBeVisible()
    await chat.getByRole("button", { name: "Close", exact: true }).click()
    settings = await profileSettings(page)
    await expect(settings.getByRole("textbox", { name: "Your name", exact: true })).toHaveValue("Тревожная мимоза")
  })
}

test("Given a storage failure, when a message is submitted, then the draft remains and retry writes once", async ({ page }) => {
  await page.goto("/")
  const settings = await profileSettings(page)
  await expect(settings.getByRole("textbox", { name: "Your name", exact: true })).not.toHaveValue("")
  await settings.getByRole("button", { name: "Dismiss", exact: true }).click()
  const chat = await openChat(page)
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put
    ;(window as any).__restoreChatPut = () => { IDBObjectStore.prototype.put = original }
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof original>) {
      if (this.name === "messages") throw new DOMException("Storage full", "QuotaExceededError")
      return original.apply(this, args)
    }
  })
  await chat.getByRole("textbox", { name: "Message", exact: true }).fill("Keep my draft")
  await chat.getByRole("button", { name: "Send message" }).click()
  await expect(chat.getByRole("alert")).toContainText("Storage full")
  await expect(chat.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Keep my draft")
  await expect(chat.locator(".chat-message-body")).toHaveCount(0)
  await page.evaluate(() => (window as any).__restoreChatPut())
  await chat.getByRole("button", { name: "Send message" }).click()
  await expect(chat.locator(".chat-message-body")).toHaveText("Keep my draft")
  await expect(chat.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("")
})

test("Given paired workspaces, when matching names and messages sync, then both peers show stable suffixes and offline messages recover", async ({ page, browser }) => {
  test.setTimeout(90_000)
  const context = await browser.newContext()
  const guest = await context.newPage()
  try {
    await page.goto("/")
    await ensureJobSearchWorkspace(page)
    const settings = await profileSettings(page)
    await settings.getByRole("textbox", { name: "Your name", exact: true }).fill("Тревожная мимоза")
    await settings.getByRole("button", { name: "Save name", exact: true }).click()
    await expect(settings.locator(".effective-value")).toHaveText("Тревожная мимоза")
    await settings.getByRole("button", { name: "Dismiss", exact: true }).click()
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const hostSync = page.getByRole("dialog", { name: "Device sync" })
    await hostSync.getByRole("button", { name: "Add someone" }).click()
    await hostSync.getByRole("button", { name: "Generate link" }).click()
    const inviteUrl = await hostSync.getByLabel("Pairing link").inputValue()
    await guest.goto("/")
    const privateChat = await openChat(guest)
    await privateChat.getByRole("textbox", { name: "Message", exact: true }).fill("Private local chat")
    await privateChat.getByRole("button", { name: "Send message" }).click()
    await expect(privateChat.getByText("Private local chat", { exact: true })).toBeVisible()
    await guest.goto(inviteUrl)
    const guestSync = guest.getByRole("dialog", { name: "Device sync" })
    await guestSync.getByRole("button", { name: "Accept and join" }).click()
    await page.getByLabel("Participant role").selectOption("editor")
    await page.getByRole("button", { name: "Approve access" }).click()
    await expect(guestSync.getByText("Connected to Job search")).toBeVisible({ timeout: 30_000 })
    await guestSync.getByRole("button", { name: "Close", exact: true }).first().click()
    await hostSync.getByRole("button", { name: "Close", exact: true }).first().click()
    const guestSettings = await profileSettings(guest)
    await guestSettings.getByRole("textbox", { name: "Your name", exact: true }).fill("Тревожная мимоза")
    await guestSettings.getByRole("button", { name: "Save name", exact: true }).click()
    await expect(guestSettings.locator(".effective-value")).toContainText(" · ")
    await guestSettings.getByRole("button", { name: "Dismiss", exact: true }).click()
    const guestChat = await openChat(guest)
    await expect(guestChat.getByText("Private local chat", { exact: true })).toHaveCount(0)
    await guestChat.getByRole("textbox", { name: "Message", exact: true }).fill("Hello from guest")
    await guestChat.getByRole("button", { name: "Send message" }).click()
    await expect(page.getByRole("button", { name: "Workspace chat", exact: true }).filter({ visible: true })).toContainText("1", { timeout: 15_000 })
    const hostChat = await openChat(page)
    await expect(hostChat.getByText("Private local chat", { exact: true })).toHaveCount(0)
    await expect(hostChat.getByText("Hello from guest", { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(hostChat.locator(".chat-message-author")).toHaveText(await guestChat.locator(".chat-message-author").textContent() ?? "")
    await hostChat.getByRole("button", { name: "Close", exact: true }).click()
    await page.bringToFront()
    await guest.evaluate(async () => {
      const path = "/src/chat/service.ts"
      const statePath = "/src/state.ts"
      const service = await import(/* @vite-ignore */ path)
      const state = await import(/* @vite-ignore */ statePath)
      await service.sendChatMessage(state.useMatch().activeWorkspace.id, "Background message")
    })
    await expect(page.locator(".chat-toast")).toContainText("Background message", { timeout: 15_000 })
    await page.getByRole("button", { name: "Dismiss chat notification" }).click()
    const replay = await guest.evaluate(async () => {
      const path = "/src/chat/service.ts"
      const statePath = "/src/state.ts"
      const state = await import(/* @vite-ignore */ statePath)
      return (await import(/* @vite-ignore */ path)).exportChat(state.useMatch().activeWorkspace.id)
    })
    await page.evaluate(async wire => {
      const path = "/src/chat/service.ts"
      const statePath = "/src/state.ts"
      const state = await import(/* @vite-ignore */ statePath)
      await (await import(/* @vite-ignore */ path)).receiveChat(state.useMatch().activeWorkspace.id, wire, false)
    }, replay)
    await expect(page.locator(".chat-toast")).toHaveCount(0)
    await openChat(page)
    await context.setOffline(true)
    await guestChat.getByRole("textbox", { name: "Message", exact: true }).fill("Offline chat survives")
    await guestChat.getByRole("button", { name: "Send message" }).click()
    await expect(guestChat.getByText("Offline chat survives", { exact: true })).toBeVisible()
    await context.setOffline(false)
    await expect(hostChat.getByText("Offline chat survives", { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(hostChat.locator(".chat-message-body")).toHaveCount(3)
    await guestChat.getByRole("button", { name: "Close", exact: true }).click()
    await guest.getByRole("button", { name: "Open workspaces", exact: true }).click()
    await guest.getByRole("button", { name: /^Untitled/ }).click()
    const restoredPrivate = await openChat(guest)
    await expect(restoredPrivate.getByText("Private local chat", { exact: true })).toBeVisible()
    await expect(restoredPrivate.getByText("Hello from guest", { exact: true })).toHaveCount(0)
  } finally { await context.close() }
})

test("Given owner and editor connected, when editor types, then typing and online counts update without saving a message", async ({ page, browser }) => {
  test.setTimeout(90_000)
  const context = await browser.newContext()
  const guest = await context.newPage()
  try {
    await page.goto("/")
    await ensureJobSearchWorkspace(page)
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const hostSync = page.getByRole("dialog", { name: "Device sync" })
    await hostSync.getByRole("button", { name: "Add someone" }).click()
    await hostSync.getByRole("button", { name: "Generate link" }).click()
    await guest.goto(await hostSync.getByLabel("Pairing link").inputValue())
    const guestSync = guest.getByRole("dialog", { name: "Device sync" })
    await guestSync.getByRole("button", { name: "Accept and join" }).click()
    await hostSync.getByLabel("Participant role").selectOption("editor")
    await hostSync.getByRole("button", { name: "Approve access" }).click()
    await expect(guestSync.getByText(/Connected to/)).toBeVisible({ timeout: 30_000 })
    await guestSync.getByRole("button", { name: "Close", exact: true }).first().click()
    await hostSync.getByRole("button", { name: "Close", exact: true }).first().click()

    await expect(page.getByLabel("Workspace presence")).toHaveText("1 editor · 2 devices online")
    const hostChat = await openChat(page)
    const guestChat = await openChat(guest)
    await guestChat.getByRole("textbox", { name: "Message", exact: true }).fill("Unsaved draft")
    await expect(hostChat.getByRole("status", { name: "Typing presence" })).toContainText("is typing", { timeout: 15_000 })
    await expect(hostChat.locator(".chat-message-item")).toHaveCount(0)

    await guestChat.getByRole("textbox", { name: "Message", exact: true }).fill("")
    await expect(hostChat.getByRole("status", { name: "Typing presence" })).toHaveCount(0, { timeout: 15_000 })
  } finally { await context.close() }
})
