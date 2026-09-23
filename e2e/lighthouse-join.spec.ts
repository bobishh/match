import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Automerge from "@automerge/automerge"
import { expect, test, type Page } from "@playwright/test"
import { ensureJobSearchWorkspace } from "./support/workspaces"

const manifest = "crates/match-lighthouse/Cargo.toml"
test.use({ trace: "off" })

function lighthouse(...args: string[]) {
  return spawn("cargo", ["run", "--quiet", "--manifest-path", manifest, "--", ...args], {
    cwd: process.cwd(), stdio: "pipe",
  }) as ChildProcessWithoutNullStreams
}

function output(process: ChildProcessWithoutNullStreams, pattern: RegExp, timeoutMs = 60_000) {
  return new Promise<string>((resolve, reject) => {
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => finish(new Error(`Lighthouse output timed out: ${stderr}`)), timeoutMs)
    const onData = (chunk: Buffer) => {
      stdout += String(chunk)
      if (pattern.test(stdout)) finish()
    }
    const onError = (chunk: Buffer) => { stderr += String(chunk) }
    const onExit = (code: number | null) => finish(new Error(`Lighthouse exited ${code}: ${stderr}`))
    const finish = (error?: Error) => {
      clearTimeout(timer)
      process.stdout.off("data", onData)
      process.stderr.off("data", onError)
      process.off("exit", onExit)
      if (error) reject(error)
      else resolve(stdout)
    }
    process.stdout.on("data", onData)
    process.stderr.on("data", onError)
    process.on("exit", onExit)
  })
}

async function addLead(page: Page, company: string) {
  await page.getByRole("button", { name: /Add lead to/ }).first().click()
  await page.getByLabel("Company *").fill(company)
  await page.getByLabel("Role *").fill("Engineer")
  await page.getByRole("button", { name: "Create item" }).click()
  await page.getByRole("button", { name: "Close detail" }).click()
}

async function stateContains(path: string, company: string) {
  try {
    const state = JSON.parse(await readFile(path, "utf8")) as { document: number[] }
    const document = Automerge.load(Uint8Array.from(state.document))
    return JSON.stringify(Automerge.toJS(document)).includes(company)
  } catch { return false }
}

async function stop(process: ChildProcessWithoutNullStreams | undefined) {
  if (!process || process.exitCode !== null || process.signalCode !== null) return
  const exited = once(process, "exit")
  process.kill("SIGINT")
  await exited
}

test("Given a Match invitation, when native lighthouse joins and restarts, then it retains and receives board changes", async ({ page }) => {
  test.setTimeout(180_000)
  const temporary = await mkdtemp(join(tmpdir(), "match-lighthouse-e2e-"))
  const directory = join(temporary, "node")
  let server: ChildProcessWithoutNullStreams | undefined
  let joining: ChildProcessWithoutNullStreams | undefined
  let serverErrors = ""
  try {
    await page.goto("/")
    await ensureJobSearchWorkspace(page)
    await addLead(page, "Before lighthouse")
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Device sync" })
    await dialog.getByRole("button", { name: "Add someone" }).click()
    await dialog.getByRole("button", { name: "Generate link" }).click()
    const invite = await dialog.getByLabel("Pairing link").inputValue()

    joining = lighthouse("join", invite, directory)
    const joined = output(joining, /Lighthouse joined/, 90_000)
    await page.getByLabel("Participant role").selectOption("editor")
    await page.getByRole("button", { name: "Approve access" }).click()
    await joined
    joining = undefined
    const state = join(directory, "state.json")
    await expect.poll(() => stateContains(state, "Before lighthouse")).toBe(true)
    await dialog.getByRole("button", { name: "Close", exact: true }).first().click()

    server = lighthouse(join(directory, "config.json"))
    server.stderr.on("data", chunk => { serverErrors += String(chunk) })
    await output(server, /Lighthouse .* listening/, 30_000)
    await addLead(page, "Live lighthouse")
    await expect.poll(() => stateContains(state, "Live lighthouse"), { timeout: 25_000 }).toBe(true)
      .catch(error => { throw new Error(`${error}\nNative errors: ${serverErrors}`) })

    await stop(server)
    server = undefined
    await addLead(page, "After lighthouse restart")
    server = lighthouse(join(directory, "config.json"))
    server.stderr.on("data", chunk => { serverErrors += String(chunk) })
    await output(server, /Lighthouse .* listening/, 30_000)
    await expect.poll(() => stateContains(state, "After lighthouse restart"), { timeout: 30_000 }).toBe(true)
      .catch(error => { throw new Error(`${error}\nNative errors: ${serverErrors}`) })
  } finally {
    await stop(joining)
    await stop(server)
    await rm(temporary, { recursive: true, force: true })
  }
})
