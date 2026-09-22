import { describe, expect, it, vi } from "vitest"
import { runAppStartup } from "./startup"

describe("runAppStartup", () => {
  it("Given the Rust policy runtime cannot load, when startup begins, then it does not read local state", async () => {
    const loadRuntime = vi.fn().mockRejectedValue(new Error("WASM request failed"))
    const hydrate = vi.fn()

    const result = await runAppStartup({
      loadRuntime,
      hydrate,
      setupLocalBoard: vi.fn(),
      startSync: vi.fn(),
    })

    expect(result).toMatchObject({ status: "fatal", stage: "runtime" })
    expect(hydrate).not.toHaveBeenCalled()
  })

  it("Given local storage cannot hydrate, when the policy runtime is ready, then startup reports storage failure", async () => {
    const runtime = vi.fn()
    const hydrate = vi.fn().mockRejectedValue(new Error("IndexedDB blocked"))

    const result = await runAppStartup({
      loadRuntime: runtime,
      hydrate,
      setupLocalBoard: vi.fn(),
      startSync: vi.fn(),
    })

    expect(result).toMatchObject({ status: "fatal", stage: "storage" })
    expect(runtime).toHaveBeenCalledBefore(hydrate)
  })

  it("Given mesh sync cannot start, when the local board is ready, then startup keeps the board usable", async () => {
    const setupLocalBoard = vi.fn()
    const startSync = vi.fn()
    const syncFailure = new Error("relay unavailable")

    const result = await runAppStartup({
      loadRuntime: vi.fn(),
      hydrate: vi.fn(),
      setupLocalBoard,
      startSync: startSync.mockRejectedValue(syncFailure),
    })

    expect(result).toEqual({ status: "ready", syncError: syncFailure })
    expect(setupLocalBoard).toHaveBeenCalledOnce()
    expect(setupLocalBoard).toHaveBeenCalledBefore(startSync)
  })
})
