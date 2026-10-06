import { describe, expect, it, vi } from "vitest"
import { runAppStartup, startupFailureDetail, startupFailureMessage } from "./startup"

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

  it("Given an invitation and a broken board, when startup runs, then it opens pairing before board validation", async () => {
    const prepareLocalState = vi.fn()
    const openPairing = vi.fn().mockReturnValue(true)
    const hydrate = vi.fn().mockRejectedValue(new Error("Broken board"))
    const startSync = vi.fn()

    const result = await runAppStartup({
      loadRuntime: vi.fn(), prepareLocalState, openPairing, hydrate,
      setupLocalBoard: vi.fn(), startSync,
    })

    expect(result).toMatchObject({ status: "fatal", stage: "storage" })
    expect(prepareLocalState).toHaveBeenCalledBefore(openPairing)
    expect(openPairing).toHaveBeenCalledBefore(hydrate)
    expect(startSync).not.toHaveBeenCalled()
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

  it.each([false, true])("Given ready local data and pairing opened=%s, when startup succeeds, then automatic transport starts only without pairing", async pairingOpened => {
    const hydrate = vi.fn()
    const setupLocalBoard = vi.fn()
    const startSync = vi.fn()
    expect(await runAppStartup({
      loadRuntime: vi.fn(), prepareLocalState: vi.fn(), openPairing: () => pairingOpened,
      hydrate, setupLocalBoard, startSync,
    })).toEqual({ status: "ready" })
    expect(hydrate).toHaveBeenCalledBefore(setupLocalBoard)
    expect(startSync).toHaveBeenCalledTimes(pairingOpened ? 0 : 1)
    if (!pairingOpened) expect(setupLocalBoard).toHaveBeenCalledBefore(startSync)
  })

  it("Given local catalog preparation fails, when policy is ready, then pairing and document reads stay blocked", async () => {
    const openPairing = vi.fn()
    const hydrate = vi.fn()
    const error = new Error("Catalog unavailable")
    expect(await runAppStartup({
      loadRuntime: vi.fn(), prepareLocalState: vi.fn().mockRejectedValue(error),
      openPairing, hydrate, setupLocalBoard: vi.fn(), startSync: vi.fn(),
    })).toEqual({ status: "fatal", stage: "storage", error })
    expect(openPairing).not.toHaveBeenCalled()
    expect(hydrate).not.toHaveBeenCalled()
  })

  it("Given local UI setup fails, when data is validated, then startup reports UI failure without starting transport", async () => {
    const startSync = vi.fn()
    const error = new Error("Board setup failed")
    expect(await runAppStartup({
      loadRuntime: vi.fn(), hydrate: vi.fn(), setupLocalBoard: vi.fn().mockRejectedValue(error), startSync,
    })).toEqual({ status: "fatal", stage: "local-ui", error })
    expect(startSync).not.toHaveBeenCalled()
  })

  it("Given pairing parsing throws, when local data is valid, then startup still opens the local board", async () => {
    const hydrate = vi.fn()
    const startSync = vi.fn()
    expect(await runAppStartup({
      loadRuntime: vi.fn(), openPairing: vi.fn().mockRejectedValue(new Error("Invalid invitation")),
      hydrate, setupLocalBoard: vi.fn(), startSync,
    })).toEqual({ status: "ready" })
    expect(hydrate).toHaveBeenCalledOnce()
    expect(startSync).toHaveBeenCalledOnce()
  })
})

describe("startup diagnostics", () => {
  it.each([
    ["runtime", "Could not load tincanban’s local runtime."],
    ["storage", "Could not open your local data."],
    ["local-ui", "Could not finish setting up your local board."],
  ] as const)("Given %s failure, when explained, then the failed stage stays distinct", (stage, message) => {
    expect(startupFailureMessage(stage)).toBe(message)
  })

  it("Given an asset failure with a nested cause, when formatted, then both errors survive without blaming stored data", () => {
    expect(startupFailureDetail(new Error("Policy download failed", { cause: new TypeError("Network unavailable") })))
      .toBe("Error: Policy download failed; cause: TypeError: Network unavailable")
  })

  it.each([
    [undefined, "undefined"], [null, "null"], ["offline", "offline"],
    [{}, "Error: No error message"], [{ name: "", message: "" }, "Error: No error message"],
    [{ name: 7, message: false, cause: "offline" }, "Error: No error message; cause: offline"],
  ])("Given a nonstandard error %j, when formatted, then diagnostics remain printable", (error, detail) => {
    expect(startupFailureDetail(error)).toBe(detail)
  })
})
