export type AppStartupStage = "runtime" | "storage" | "local-ui"

export type AppStartupResult =
  | { status: "fatal"; stage: AppStartupStage; error: unknown }
  | { status: "ready"; syncError?: unknown }

export type AppStartupSteps = {
  /** Loads the Rust policy runtime. It must finish before state is hydrated. */
  loadRuntime: () => Promise<void> | void
  /** Reads local state, which depends on the Rust policy runtime. */
  hydrate: () => Promise<void> | void
  /** Makes the already-hydrated local board interactive. */
  setupLocalBoard: () => Promise<void> | void
  /** Starts optional device synchronization after the local board is usable. */
  startSync: () => Promise<void> | void
}

/**
 * Starts Match in dependency order while keeping device sync optional.
 *
 * The Rust runtime deliberately remains ahead of hydration: local policy is
 * evaluated by the runtime and must not be approximated in TypeScript.
 */
export async function runAppStartup(steps: AppStartupSteps): Promise<AppStartupResult> {
  const runtimeFailure = await runRequiredStage("runtime", steps.loadRuntime)
  if (runtimeFailure) return runtimeFailure

  const storageFailure = await runRequiredStage("storage", steps.hydrate)
  if (storageFailure) return storageFailure

  const localUiFailure = await runRequiredStage("local-ui", steps.setupLocalBoard)
  if (localUiFailure) return localUiFailure

  try {
    await steps.startSync()
    return { status: "ready" }
  } catch (syncError) {
    return { status: "ready", syncError }
  }
}

export function startupFailureMessage(stage: AppStartupStage): string {
  switch (stage) {
    case "runtime": return "Could not load Match’s local runtime. Reload to try again."
    case "storage": return "Could not open your local data. Reload to try again."
    case "local-ui": return "Could not finish setting up your local board. Reload to try again."
  }
}

async function runRequiredStage(stage: AppStartupStage, step: () => Promise<void> | void): Promise<Extract<AppStartupResult, { status: "fatal" }> | undefined> {
  try {
    await step()
  } catch (error) {
    return { status: "fatal", stage, error }
  }
}
