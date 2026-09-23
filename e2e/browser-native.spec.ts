import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process"
import { promisify } from "node:util"
import { test, expect } from "@playwright/test"

const execFileAsync = promisify(execFile)

test("Given browser and native Rust peers, when they sync, then both documents converge and forged device is rejected", async () => {
  test.setTimeout(180_000)
  const native = spawn("cargo", ["run", "--locked", "--manifest-path", "crates/meta-mesh-native/Cargo.toml", "--example", "browser_document_probe"], {
    cwd: "vendor/meta-mesh",
    detached: true,
    stdio: "pipe",
  }) as ChildProcessWithoutNullStreams
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let output = ""
      let errors = ""
      const timer = setTimeout(() => reject(new Error(`Native peer startup timed out: ${errors}`)), 120_000)
      native.stdout.on("data", chunk => {
        output += String(chunk)
        const match = output.match(/\b[0-9a-f]{64}\b/)
        if (match) { clearTimeout(timer); resolve(match[0]) }
      })
      native.stderr.on("data", chunk => { errors += String(chunk) })
      native.on("exit", code => { clearTimeout(timer); reject(new Error(`Native peer exited ${code}: ${errors}`)) })
      native.on("error", error => { clearTimeout(timer); reject(error) })
    })
    const { stdout } = await execFileAsync("node", ["scripts/browser-native-probe.mjs", endpoint], {
      env: process.env,
      timeout: 90_000,
    })
    expect(stdout).toContain("Browser/native Rust Automerge sync converged; forged device rejected")
  } finally {
    if (native.pid) {
      try { process.kill(-native.pid, "SIGINT") } catch { /* Already stopped. */ }
    }
  }
})
