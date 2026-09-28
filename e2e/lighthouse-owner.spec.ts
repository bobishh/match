import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { once } from "node:events"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import * as Automerge from "@automerge/automerge"
import { expect, test, type Page } from "@playwright/test"
import { createJobSearchWorkspace } from "./support/workspaces"

const manifest = resolve(process.env.MATCH_LIGHTHOUSE_MANIFEST ?? "../mesh-lighthouse/Cargo.toml")
test.skip(!existsSync(manifest), "Standalone Lighthouse checkout is required")
test.use({ trace: "off" })

async function card(page: Page, title: string) {
  await page.getByRole("button", { name: /Add lead to/ }).first().click()
  await page.getByLabel("Company *").fill(title)
  await page.getByLabel("Role *").fill("Engineer")
  await page.getByRole("button", { name: "Create item" }).click()
  await page.getByRole("button", { name: "Close detail" }).click()
}

function node(...args: string[]) {
  return spawn("cargo", ["run", "--quiet", "--manifest-path", manifest, "--", ...args], { stdio: "pipe" })
}

function waitOutput(child: ChildProcessWithoutNullStreams, pattern: RegExp) {
  return new Promise<string>((resolve, reject) => {
    let output = ""
    const timer = setTimeout(() => finish(new Error(`Lighthouse timeout: ${output}`)), 90_000)
    const data = (chunk: Buffer) => { output += String(chunk); if (pattern.test(output)) finish() }
    const exited = (code: number | null) => finish(new Error(`Lighthouse exited ${code}: ${output}`))
    function finish(error?: Error) {
      clearTimeout(timer)
      child.stdout.off("data", data); child.stderr.off("data", data); child.off("exit", exited)
      if (error) reject(error); else resolve(output)
    }
    child.stdout.on("data", data); child.stderr.on("data", data); child.on("exit", exited)
  })
}

function captureStderr(child: ChildProcessWithoutNullStreams, output: { text: string }) {
  child.stderr.on("data", chunk => { output.text += String(chunk) })
}

async function stop(child?: ChildProcessWithoutNullStreams) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, "exit")
  child.kill("SIGINT")
  await exited
}

async function storedTitles(directory: string) {
  try {
    const config = JSON.parse(await readFile(join(directory, "config.json"), "utf8"))
    const scopes = [config, ...(config.additionalScopes ?? [])]
    return await Promise.all(scopes.map(async (scope: { statePath: string }) => {
      const state = JSON.parse(await readFile(scope.statePath, "utf8"))
      const doc = Automerge.load(Uint8Array.from(state.document))
      try { return JSON.stringify(Automerge.toJS(doc)) } finally { Automerge.free(doc) }
    }))
  } catch { return [] }
}

async function storedScopes(directory: string) {
  try {
    const config = JSON.parse(await readFile(join(directory, "config.json"), "utf8"))
    return await Promise.all([config, ...(config.additionalScopes ?? [])].map(
      (scope: { statePath: string }) => readFile(scope.statePath, "utf8").then(JSON.parse),
    ))
  } catch { return [] }
}

async function switchWorkspace(page: Page, title: string) {
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("dialog", { name: "Workspaces" }).getByRole("button", { name: new RegExp(`^${title}\\b`) }).click()
  await page.getByRole("button", { name: /Add lead to/ }).first().waitFor()
}

async function saveBrowserMeshTrace(page: Page) {
  const trace = await page.evaluate(async () => (await import("/src/sync/meshTrace.ts")).meshTraceSnapshot()).catch(() => [])
  await test.info().attach("browser-mesh-trace.json", {
    body: Buffer.from(JSON.stringify(trace, null, 2)),
    contentType: "application/json",
  })
  return trace
}

async function waitWorkspaceConnected(page: Page, nativeErrors: { text: string }) {
  await expect(page.getByLabel("Mesh connected", { exact: true })).toBeVisible({ timeout: 30_000 }).catch(async error => {
    const trace = await saveBrowserMeshTrace(page)
    throw new Error(`${error}\nLighthouse stderr: ${nativeErrors.text}\nBrowser mesh trace events: ${trace.length}`)
  })
}

async function waitExit(child: ChildProcessWithoutNullStreams, timeoutMs = 90_000) {
  if (child.exitCode !== null) return child.exitCode
  return await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Lighthouse join did not finish after owner declined")), timeoutMs)
    const onExit = (code: number | null) => finish(undefined, code)
    function finish(error?: Error, code?: number | null) {
      clearTimeout(timer)
      child.off("exit", onExit)
      if (error) reject(error)
      else resolve(code ?? null)
    }
    child.on("exit", onExit)
  })
}

test("Given an owner with two boards, when Lighthouse joins that owner, then existing and future boards replicate after restart", async ({ page }) => {
  test.setTimeout(180_000)
  const directory = await mkdtemp(join(tmpdir(), "match-owner-keeper-"))
  const nativeErrors = { text: "" }
  const browserConsole: string[] = []
  let successful = false
  page.on("console", message => {
    if (message.type() === "warning" || message.type() === "error") {
      browserConsole.push(message.text().replace(/https?:\/\/[^\s]+/g, "<url>"))
    }
  })
  let joining: ChildProcessWithoutNullStreams | undefined
  let running: ChildProcessWithoutNullStreams | undefined
  try {
    await page.goto("/")
    for (const title of ["Owner A", "Owner B"]) {
      await createJobSearchWorkspace(page, title)
      await card(page, `${title} initial`)
    }
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const sync = page.getByRole("dialog", { name: "Device sync" })
    await sync.getByRole("button", { name: "Add someone" }).click()
    await sync.getByLabel("Owner A", { exact: true }).check()
    await sync.getByRole("button", { name: "Generate link" }).click()
    joining = node("join", await sync.getByLabel("Pairing link").inputValue(), directory)
    captureStderr(joining, nativeErrors)
    const joined = waitOutput(joining, /Lighthouse joined/)
    // Observe rejection immediately as well as the browser approval route.
    await Promise.race([page.getByLabel("Participant role").waitFor(), joined])
    await page.getByLabel("Participant role").selectOption("editor")
    await page.getByLabel("Connect all my boards, including future boards").check()
    await page.getByRole("button", { name: "Approve access" }).click()
    await joined
    await stop(joining); joining = undefined
    const config = JSON.parse(await readFile(join(directory, "config.json"), "utf8"))
    const scopes = [config, ...(config.additionalScopes ?? [])]
    expect(scopes).toHaveLength(2)
    const servicePersonId = config.localHandshake.peer.advertisement.payload.personId
    expect(servicePersonId).not.toBe(config.genesisPersonId)
    expect(scopes.map((scope: { genesisPersonId: string }) => scope.genesisPersonId))
      .toEqual([config.genesisPersonId, config.genesisPersonId])
    await sync.getByRole("button", { name: "Close", exact: true }).first().click()
    await expect.poll(async () => (await storedTitles(directory)).filter(doc => /Owner [AB] initial/.test(doc)).length).toBe(2)
    running = node(join(directory, "config.json"))
    captureStderr(running, nativeErrors)
    await waitOutput(running, /Lighthouse .* listening/)
    await expect.poll(async () => (await storedTitles(directory)).length, { timeout: 30_000 }).toBe(3)
      .catch(async error => {
        const trace = await saveBrowserMeshTrace(page)
        throw new Error(`${error}\nLighthouse stderr: ${nativeErrors.text}\nBrowser trace events: ${trace.length}`)
      })
    await switchWorkspace(page, "Owner A")
    await waitWorkspaceConnected(page, nativeErrors)
    await card(page, "Existing board live card")
    await expect.poll(async () => (await storedTitles(directory)).some(doc => doc.includes("Existing board live card")), { timeout: 10_000 })
      .toBe(true).catch(async error => {
        const trace = await saveBrowserMeshTrace(page)
        throw new Error(`${error}\nLighthouse stderr: ${nativeErrors.text}\nBrowser mesh trace events: ${trace.length}`)
      })
    await switchWorkspace(page, "Owner B")
    await waitWorkspaceConnected(page, nativeErrors)
    await card(page, "Second existing board live card")
    await expect.poll(async () => (await storedTitles(directory)).some(doc => doc.includes("Second existing board live card")), { timeout: 10_000 })
      .toBe(true).catch(async error => {
        const trace = await saveBrowserMeshTrace(page)
        throw new Error(`${error}\nLighthouse stderr: ${nativeErrors.text}\nBrowser mesh trace events: ${trace.length}`)
      })
    await createJobSearchWorkspace(page, "Owner C")
    await expect.poll(async () => (await storedTitles(directory)).length, { timeout: 30_000 }).toBe(4)
      .catch(async error => {
        const trace = await saveBrowserMeshTrace(page)
        throw new Error(`${error}\nLighthouse stderr: ${nativeErrors.text}\nBrowser mesh trace events: ${trace.length}`)
      })
    await waitWorkspaceConnected(page, nativeErrors)
    await card(page, "Future owner card")
    await expect.poll(async () => (await storedTitles(directory)).some(doc => doc.includes("Future owner card")), { timeout: 10_000 })
      .toBe(true).catch(async error => {
        const trace = await saveBrowserMeshTrace(page)
        throw new Error(`${error}\nLighthouse stderr: ${nativeErrors.text}\nBrowser mesh trace events: ${trace.length}\nLighthouse state directory: ${directory}`)
      })
    await page.getByRole("button", { name: "Workspace chat", exact: true }).filter({ visible: true }).click()
    const chat = page.getByRole("dialog", { name: "Workspace chat", exact: true })
    await chat.getByRole("textbox", { name: "Message", exact: true }).fill("Owner keeper chat message")
    await chat.getByRole("button", { name: "Send message", exact: true }).click()
    await expect.poll(async () => (await storedScopes(directory)).some(scope => JSON.stringify(scope.chat).includes("Owner keeper chat message")), { timeout: 10_000 })
      .toBe(true).catch(error => { throw new Error(`${error}\nLighthouse stderr: ${nativeErrors.text}`) })
    await chat.getByRole("button", { name: "Close", exact: true }).click()
    await stop(running); running = undefined
    await card(page, "Keeper offline card")
    running = node(join(directory, "config.json"))
    captureStderr(running, nativeErrors)
    await waitOutput(running, /Lighthouse .* listening/)
    await expect.poll(async () => (await storedTitles(directory)).some(doc => doc.includes("Keeper offline card")), { timeout: 30_000 }).toBe(true)
    successful = true
  } catch (error) {
    const trace = await saveBrowserMeshTrace(page)
    await test.info().attach("lighthouse-stderr.log", {
      body: nativeErrors.text,
      contentType: "text/plain",
    })
    await test.info().attach("browser-console.log", {
      body: browserConsole.join("\n"),
      contentType: "text/plain",
    })
    throw new Error(`${error}\nLighthouse stderr: ${nativeErrors.text}\nBrowser console: ${browserConsole.join("\n")}\nBrowser trace events: ${trace.length}\nLighthouse state directory: ${directory}`)
  } finally {
    await stop(joining); await stop(running)
    if (successful) await rm(directory, { recursive: true, force: true })
  }
})

test("Given an owner access request, when owner declines, then Lighthouse leaves no active membership or stored state", async ({ page }) => {
  test.setTimeout(120_000)
  const directory = await mkdtemp(join(tmpdir(), "match-owner-decline-"))
  let joining: ChildProcessWithoutNullStreams | undefined
  const nativeErrors = { text: "" }
  try {
    await page.goto("/")
    await createJobSearchWorkspace(page, "Decline owner board")
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const sync = page.getByRole("dialog", { name: "Device sync" })
    await sync.getByRole("button", { name: "Add someone" }).click()
    await sync.getByRole("button", { name: "Generate link" }).click()
    joining = node("join", await sync.getByLabel("Pairing link").inputValue(), directory)
    captureStderr(joining, nativeErrors)
    await Promise.race([
      page.getByLabel("Participant role").waitFor({ timeout: 90_000 }),
      waitOutput(joining, /Lighthouse joined/),
    ]).catch(error => { throw new Error(`${error}\nLighthouse stderr: ${nativeErrors.text}`) })
    await page.getByRole("button", { name: "Decline", exact: true }).click()
    const exitCode = await waitExit(joining)
    joining = undefined
    expect(exitCode).not.toBe(0)
    await expect(page.getByLabel("Participant role")).toHaveCount(0)
    await expect(page.getByText("Lighthouse", { exact: true })).toHaveCount(0)
    await expect(async () => readFile(join(directory, "config.json"))).rejects.toThrow()
    await expect(async () => readFile(join(directory, "state.json"))).rejects.toThrow()
  } finally {
    await stop(joining)
    await rm(directory, { recursive: true, force: true })
  }
})
