import { WasmStateCore } from "@meta-uber/mesh-transport/wasm"
import { afterEach, expect, it, vi } from "vitest"

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it("Given transferred document bytes, When checking worker access, Then the policy receives its original numeric document format", async () => {
  const decision = vi.spyOn(WasmStateCore, "decideWorkspaceAccess").mockImplementation(input => {
    expect(input.snapshot.document).toEqual([1, 2, 3])
    expect(Array.isArray(input.snapshot.document)).toBe(true)
    return "owner"
  })
  let complete!: (value: unknown) => void
  const response = new Promise(resolve => { complete = resolve })
  vi.stubGlobal("onmessage", undefined)
  vi.stubGlobal("postMessage", complete)
  await import("./workspaceAccessWorker")
  const scope = globalThis as unknown as { onmessage(event: { data: { id: number; input: { snapshot: { document: Uint8Array } } } }): void }
  scope.onmessage({ data: { id: 17, input: { snapshot: { document: new Uint8Array([1, 2, 3]) } } } })
  await expect(response).resolves.toEqual({ id: 17, role: "owner" })
  expect(decision).toHaveBeenCalledTimes(1)
})
