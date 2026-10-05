import { nextTick, onScopeDispose, watch, type Ref } from "vue"
import type { useAppController } from "./useAppController"
import type { Anchor, MessageContext } from "../chat/context"
import { conversationRoot } from "../chat/context"
import { getChatScope } from "../chat/service"
import { parseMessageReference } from "../chat/messageReference"
import { focusSpatialWindow } from "../ui/windowManager"
import { workspaceWritesBlocked } from "../sync/changeAuthorization"

export type Discussion = { workspaceId: string; id: string; title: string; anchor?: Anchor; rootId?: string; context: MessageContext; targetId?: string }
type App = ReturnType<typeof useAppController>

async function matchingWorkspaces(app: App, scope: string) {
  const matches: string[] = []
  for (const candidate of app.workspace.availableWorkspaces.value) {
    try { if (await getChatScope(candidate.id) === scope) matches.push(candidate.id) } catch { /* unavailable local entry */ }
  }
  return matches.sort((left, right) => left.localeCompare(right))
}
async function authorizedWorkspace(app: App, matches: string[]): Promise<string | undefined> {
  const active = app.workspace.activeWorkspace.id
  const candidates = [active, ...matches.filter(id => id !== active)].filter(id => matches.includes(id))
  for (const id of candidates) {
    if (app.collaboration.device.sync.isWorkspaceAccessRevoked(id)) continue
    try {
      await app.workspace.getWorkspaceRole(id)
      if (!await workspaceWritesBlocked(id)) return id
    } catch { /* try another authorized local copy */ }
  }
}
function currentAccess(app: App): "loading" | "blocked" | "verified" {
  const permissions = app.collaboration.permissions
  if (permissions.workspaceRoleStatus.value === "loading") return "loading"
  if (!permissions.confirmedRole.value || app.collaboration.device.sync.isWorkspaceAccessRevoked(app.workspace.activeWorkspace.id)) return "blocked"
  return "verified"
}
async function revealMessage(app: App, discussions: Ref<Discussion[]>, linkedMessageId: Ref<string>, messageId: string) {
  const messages = app.collaboration.device.chat.messages.value.filter(message => "record" in message)
  const target = messages.find(message => message.id === messageId)
  if (!target) return false
  const root = conversationRoot(target, messages)
  const hasConversation = root.state !== "invalid" && (!!target.context?.replyTo || messages.some(candidate => candidate.context?.conversationRootId === target.id))
  if (!hasConversation) {
    linkedMessageId.value = target.id
    app.collaboration.device.chat.open.value = true
    await nextTick(); focusSpatialWindow(app.workspace.activeWorkspace.id, "chat")
    return true
  }
  const workspaceId = app.workspace.activeWorkspace.id
  const id = `conversation:${root.rootId}`
  const existing = discussions.value.find(view => view.workspaceId === workspaceId && view.id === id)
  if (existing) existing.targetId = target.id
  else discussions.value.push({ workspaceId, id, title: "Discussion · replies", rootId: root.rootId, targetId: target.id,
    context: { references: target.context?.references ?? [], mentions: [] } })
  await nextTick(); focusSpatialWindow(workspaceId, id)
  return true
}
export function createMessageNavigation(app: App, discussions: Ref<Discussion[]>, navigationState: Ref<string>, linkedMessageId: Ref<string>) {
  let generation = 0
  onScopeDispose(() => { generation++ })
  const showState = (state: string) => { navigationState.value = state; app.collaboration.device.chat.open.value = true }
  async function selectWorkspace(scope: string, current: number): Promise<string | undefined> {
    const matches = await matchingWorkspaces(app, scope)
    if (current !== generation) return
    if (!matches.length) { showState("Workspace unavailable"); return }
    const candidate = await authorizedWorkspace(app, matches)
    if (current !== generation) return
    if (!candidate) { showState("Workspace access unavailable"); return }
    if (candidate !== app.workspace.activeWorkspace.id) await app.workspace.switchWorkspace(candidate)
    await nextTick()
    return current === generation ? candidate : undefined
  }
  async function loadAuthorizedChat(candidate: string, current: number) {
    const access = currentAccess(app)
    if (access !== "verified") return access
    const loaded = await app.collaboration.device.chat.refresh()
    if (current !== generation || candidate !== app.workspace.activeWorkspace.id) return "cancelled"
    if (loaded === false) return "failed"
    if (loaded === undefined) return "cancelled"
    const blocked = await workspaceWritesBlocked(candidate)
    if (current !== generation || candidate !== app.workspace.activeWorkspace.id) return "cancelled"
    const refreshed = currentAccess(app)
    return blocked ? "blocked" : refreshed
  }
  async function navigate() {
    if (!app.workspace.ready.value) return
    const current = ++generation
    const parsed = parseMessageReference(window.location.hash)
    if (parsed.status === "none") return
    linkedMessageId.value = ""
    if (parsed.status === "invalid") { showState("Invalid message link"); return }
    navigationState.value = "Loading messages…"
    const candidate = await selectWorkspace(parsed.reference.workspaceScope, current)
    if (!candidate) return
    const access = await loadAuthorizedChat(candidate, current)
    if (access === "cancelled") return
    if (access === "loading") { showState("Loading messages…"); return }
    if (access === "failed") { showState(`Could not load chat · ${app.collaboration.device.chat.error.value}`); return }
    if (access === "blocked") { showState("Workspace access unavailable"); return }
    navigationState.value = ""
    if (!await revealMessage(app, discussions, linkedMessageId, parsed.reference.messageId)) showState("Message unavailable")
  }

  watch(() => [app.workspace.ready.value, app.collaboration.permissions.workspaceRoleStatus.value,
    app.workspace.availableWorkspaces.value.map(item => item.id).join("|"), app.collaboration.device.sync.ownershipRevision.value,
    app.collaboration.device.sync.isWorkspaceAccessRevoked(app.workspace.activeWorkspace.id)], () => { void navigate() })
  return navigate
}
