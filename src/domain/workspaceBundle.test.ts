import { readFile } from "node:fs/promises"
import { beforeAll, expect, it } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { createWorkspaceDoc } from "./seeds"
import { exportWorkspaceBundleV2, readWorkspaceBundleV2 } from "./workspaceBundle"
beforeAll(async () => {
  await Automerge.initializeWasm(await readFile("node_modules/@automerge/automerge/dist/automerge.wasm"))
})

it("exports v2 bundle and validates manifest, format, and rejects corrupt bundles", async () => {
  const doc = Automerge.from(createWorkspaceDoc("bundle", "Bundle", "owner", "blank"))

  const bundleBytes = await exportWorkspaceBundleV2(doc, [])
  expect(bundleBytes.length).toBeGreaterThan(0)

  // Read back valid bundle
  const readResult = await readWorkspaceBundleV2(bundleBytes)
  expect(readResult.ok).toBe(true)
  if (!readResult.ok) return

  expect(readResult.value.manifest.format).toBe("match")
  expect(readResult.value.manifest.version).toBe(2)
  expect(readResult.value.manifest.workspaceId).toBe(doc.id)
  expect(readResult.value.doc.id).toBe(doc.id)

  // Invalid archive is rejected
  const unzipped = await readWorkspaceBundleV2(new Uint8Array([1, 2, 3, 4]))
  expect(unzipped.ok).toBe(false)
  if (!unzipped.ok) {
    expect(unzipped.error.code).toBe("unsupported_format")
  }
})
