export type AppStartupStage = "runtime" | "storage" | "local-ui"

export type AppStartupResult =
  | { status: "fatal"; stage: AppStartupStage; error: unknown }
  | { status: "ready"; syncError?: unknown }

export type AppStartupSteps = {
  /** Loads the Rust policy runtime before any workspace access. */
  loadRuntime: () => Promise<void> | void
  /** Opens the local identity and workspace catalog without validating documents. */
  prepareLocalState?: () => Promise<void> | void
  /** Shows a pairing invitation before any stored document can block it. */
  openPairing?: () => Promise<boolean> | boolean
  /** Reads and validates local documents after the recovery UI can open. */
  hydrate: () => Promise<void> | void
  /** Makes the already-hydrated local board interactive. */
  setupLocalBoard: () => Promise<void> | void
  /** Starts optional device synchronization after the local board is usable. */
  startSync: () => Promise<void> | void
}

/**
 * Starts tincanban in dependency order while keeping device sync optional.
 *
 * The Rust runtime deliberately remains ahead of hydration: local policy is
 * evaluated by the runtime and must not be approximated in TypeScript.
 */
export async function runAppStartup(steps: AppStartupSteps): Promise<AppStartupResult> {
  const runtimeFailure = await runRequiredStage("runtime", steps.loadRuntime)
  if (runtimeFailure) return runtimeFailure

  if (steps.prepareLocalState) {
    const preparationFailure = await runRequiredStage("storage", steps.prepareLocalState)
    if (preparationFailure) return preparationFailure
  }

  let pairingOpened = false
  if (steps.openPairing) {
    try { pairingOpened = await steps.openPairing() }
    catch (error) { console.error("[tincanban.startup] pairing failed", error) }
  }

  const storageFailure = await runRequiredStage("storage", steps.hydrate)
  if (storageFailure) return storageFailure

  const localUiFailure = await runRequiredStage("local-ui", steps.setupLocalBoard)
  if (localUiFailure) return localUiFailure

  try {
    if (!pairingOpened) await steps.startSync()
    return { status: "ready" }
  } catch (syncError) {
    return { status: "ready", syncError }
  }
}

export function startupFailureMessage(stage: AppStartupStage): string {
  switch (stage) {
    case "runtime": return "Could not load tincanban’s local runtime."
    case "storage": return "Could not open your local data."
    case "local-ui": return "Could not finish setting up your local board."
  }
}

export function startupFailureDetail(error: unknown): string {
  if (error && typeof error === "object") {
    const value = error as { name?: unknown; message?: unknown; cause?: unknown }
    const name = typeof value.name === "string" && value.name ? value.name : "Error"
    const message = typeof value.message === "string" && value.message ? value.message : "No error message"
    const cause = value.cause === undefined ? "" : `; cause: ${startupFailureDetail(value.cause)}`
    return `${name}: ${message}${cause}`
  }
  return String(error)
}

async function runRequiredStage(stage: AppStartupStage, step: () => Promise<void> | void): Promise<Extract<AppStartupResult, { status: "fatal" }> | undefined> {
  const started = Date.now()
  console.info("[tincanban.startup]", stage, "start")
  try {
    await step()
    console.info("[tincanban.startup]", stage, "done", Date.now() - started)
  } catch (error) {
    console.error("[tincanban.startup]", stage, "failed", error)
    return { status: "fatal", stage, error }
  }
}
