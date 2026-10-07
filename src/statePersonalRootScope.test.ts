import { beforeEach, describe, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest } from "./domain/identity"
import { createPersonalRoot, pruneForeignGenesisWorkspaceRefs, registerWorkspaceInRoot } from "./domain/personalRoot"
import type { WorkspaceStorage } from "./storage"
import { refreshAvailableWorkspaces, resetStateForTest } from "./statePersistence"
import { stateRuntime } from "./stateContext"

describe("identity-scoped local workspace catalog", () => {
  beforeEach(() => {
    resetIdentityStorageForTest()
    resetStateForTest()
  })

  it("shows root-entitled workspaces, including invited visitor refs, but hides another identity's local docs", async () => {
    const profile = await bootstrapIdentity("New identity")
    const root = createPersonalRoot(profile, "certificate")
    registerWorkspaceInRoot(root, "owned", "owned", "genesis")
    registerWorkspaceInRoot(root, "invited-visitor", "invited-visitor", "import")
    stateRuntime.currentProfile = profile
    const storage = {
      listWorkspaceCatalog: vi.fn().mockResolvedValue({
        available: [
          { id: "owned", title: "Mine", updatedAt: "now" },
          { id: "invited-visitor", title: "Guest board", updatedAt: "now" },
          { id: "old-identity", title: "Untitled", updatedAt: "now" },
        ],
        archived: [{ id: "old-archived", title: "Old", updatedAt: "now" }],
      }),
      loadPersonalRoot: vi.fn().mockResolvedValue(root),
    } as unknown as WorkspaceStorage

    await refreshAvailableWorkspaces(storage)

    expect(stateRuntime.availableWorkspaces.value.map(item => item.id)).toEqual(["owned", "invited-visitor"])
    expect(stateRuntime.archivedWorkspaces.value).toEqual([])
  })

  it("fails closed when legacy root omits its workspace map", async () => {
    const profile = await bootstrapIdentity("New identity")
    const root = { ...createPersonalRoot(profile, "certificate"), workspaces: undefined } as unknown as ReturnType<typeof createPersonalRoot>
    stateRuntime.currentProfile = profile
    stateRuntime.activeWorkspaceMeta.id = "old-local"
    const storage = {
      listWorkspaceCatalog: vi.fn().mockResolvedValue({
        available: [{ id: "old-local", title: "Untitled", updatedAt: "now" }], archived: [],
      }),
      loadPersonalRoot: vi.fn().mockResolvedValue(root),
    } as unknown as WorkspaceStorage

    await expect(refreshAvailableWorkspaces(storage)).resolves.toBeUndefined()
    expect(stateRuntime.availableWorkspaces.value).toEqual([])
  })

  it("repairs polluted genesis refs without dropping invited or unavailable refs", async () => {
    const profile = await bootstrapIdentity("Current identity")
    const root = createPersonalRoot(profile, "certificate")
    registerWorkspaceInRoot(root, "owned", "owned", "genesis")
    registerWorkspaceInRoot(root, "stale-old-owner", "stale-old-owner", "genesis")
    registerWorkspaceInRoot(root, "visitor-invite", "visitor-invite", "import")
    registerWorkspaceInRoot(root, "not-yet-downloaded", "not-yet-downloaded", "genesis")

    expect(pruneForeignGenesisWorkspaceRefs(root, new Map([
      ["owned", profile.identity.personId],
      ["stale-old-owner", "old-identity"],
    ]))).toEqual(["stale-old-owner"])
    expect(Object.keys(root.workspaces).sort()).toEqual(["not-yet-downloaded", "owned", "visitor-invite"])
  })
})
