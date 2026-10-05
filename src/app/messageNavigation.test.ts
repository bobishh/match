import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { effectScope, nextTick, ref, type EffectScope } from "vue"
import { messageReferenceUrl } from "../chat/messageReference"
const mocks = vi.hoisted(() => ({ scope: vi.fn(), blocked: vi.fn(), focus: vi.fn() }))
vi.mock("../chat/service", () => ({ getChatScope: mocks.scope }))
vi.mock("../sync/changeAuthorization", () => ({ workspaceWritesBlocked: mocks.blocked }))
vi.mock("../ui/windowManager", () => ({ focusSpatialWindow: mocks.focus }))
import { createMessageNavigation, type Discussion } from "./messageNavigation"
const originalWindow = globalThis.window
let lifecycle: EffectScope
function setup() {
  lifecycle = effectScope()
  const revoked = new Set<string>()
  const app = {
    workspace: { ready: ref(true), activeWorkspace: { id: "active" }, availableWorkspaces: ref([{ id: "active" }]), getWorkspaceRole: vi.fn().mockResolvedValue("visitor"), switchWorkspace: vi.fn(async (id: string) => { app.workspace.activeWorkspace.id = id }) },
    collaboration: {
      permissions: { workspaceRoleStatus: ref("verified"), confirmedRole: ref("visitor"), workspaceAccessErrors: ref(["Unrelated workspace failed verification"]) },
      device: { sync: { ownershipRevision: ref(0), isWorkspaceAccessRevoked: (id: string) => revoked.has(id) }, chat: { open: ref(false), error: ref(""), refresh: vi.fn().mockResolvedValue(true), messages: ref([{ id: "device:target", workspaceId: "scope", personId: "person", body: "Cached body", createdAt: "2026-10-05T00:00:00.000Z", record: {} }]) } },
    },
  }
  const state = ref("")
  const linked = ref("")
  const discussions = ref<Discussion[]>([])
  const navigate = lifecycle.run(() => createMessageNavigation(app as never, discussions, state, linked))!
  return { app, revoked, state, linked, navigate, discussions }
}
beforeEach(() => {
  mocks.scope.mockResolvedValue("scope")
  mocks.blocked.mockResolvedValue(false)
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { hash: new URL(messageReferenceUrl("https://example.com/app/", { workspaceScope: "scope", messageId: "device:target" })).hash } } })
})
afterEach(() => { lifecycle?.stop(); vi.clearAllMocks(); Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow }) })
describe("authorized local message navigation", () => {
  it("ignores unrelated permission errors while revealing an authorized target", async () => {
    const { app, state, linked, navigate } = setup()
    await navigate()
    expect(state.value).toBe("")
    expect(linked.value).toBe("device:target")
    expect(app.collaboration.device.chat.open.value).toBe(true)
    expect(mocks.focus).toHaveBeenCalledWith("active", "chat")
  })
  it("never reveals revoked cached messages", async () => {
    const { app, revoked, state, linked, navigate } = setup()
    revoked.add("active")
    await navigate()
    expect(state.value).toBe("Workspace access unavailable")
    expect(linked.value).toBe("")
    expect(app.collaboration.device.chat.refresh).not.toHaveBeenCalled()
    expect(mocks.focus).not.toHaveBeenCalled()
  })
  it("chooses an authorized local copy rather than blocked matching active copy", async () => {
    const { app, state, linked, navigate } = setup()
    app.workspace.availableWorkspaces.value = [{ id: "active" }, { id: "authorized-copy" }]
    app.workspace.getWorkspaceRole.mockImplementation(async id => { if (id === "active") throw new Error("Invalid authority"); return "visitor" })
    await nextTick()
    await navigate()
    expect(app.workspace.switchWorkspace).toHaveBeenCalledWith("authorized-copy")
    expect(state.value).toBe("")
    expect(linked.value).toBe("device:target")
  })
  it("rechecks revocation after asynchronous chat loading", async () => {
    const { app, revoked, state, linked, navigate } = setup()
    app.collaboration.device.chat.refresh.mockImplementation(async () => { revoked.add("active"); return true })
    await navigate()
    expect(state.value).toBe("Workspace access unavailable")
    expect(linked.value).toBe("")
    expect(mocks.focus).not.toHaveBeenCalled()
  })
  it("reports journal failure instead of claiming a cached target unavailable", async () => {
    const { app, state, linked, navigate } = setup()
    app.collaboration.device.chat.refresh.mockImplementation(async () => { app.collaboration.device.chat.error.value = "IndexedDB blocked"; return false })
    await navigate()
    expect(state.value).toBe("Could not load chat · IndexedDB blocked")
    expect(linked.value).toBe("")
    expect(mocks.focus).not.toHaveBeenCalled()
    app.collaboration.device.chat.refresh.mockImplementation(async () => true)
    await navigate()
    expect(linked.value).toBe("device:target")
    expect(app.collaboration.device.chat.error.value).toBe("IndexedDB blocked")
  })
  it("keeps loading when current permission verification remains pending", async () => {
    const { app, state, linked, navigate } = setup()
    app.collaboration.permissions.workspaceRoleStatus.value = "loading"
    await nextTick()
    await navigate()
    expect(state.value).toBe("Loading messages…")
    expect(linked.value).toBe("")
    expect(app.collaboration.device.chat.refresh).not.toHaveBeenCalled()
  })
})
