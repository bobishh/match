import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { useAppController } from "./useAppController"
import { conversationMessages, type Anchor } from "../chat/context"
import { getChatScope } from "../chat/service"
import type { StoredChatMessage } from "../chat/store"
import { captureSelectedSource, createSourceHighlighter, findSourceOwner, type SelectedSource } from "../chat/sourceSelection"
import { createMessageNavigation, type Discussion } from "./messageNavigation"
import { focusSpatialWindow } from "../ui/windowManager"
import { isItem, type Item } from "../domain/model"


export function useObjectConversations(app: ReturnType<typeof useAppController>) {
  const scope = ref("")
  const discussions = ref<Discussion[]>([])
  const selection = ref<SelectedSource | null>(null)
  const sourceState = ref("")
  const navigationState = ref("")
  const linkedMessageId = ref("")
  const highlighter = createSourceHighlighter(state => { sourceState.value = state })
  const navigate = createMessageNavigation(app, discussions, navigationState, linkedMessageId)
  const workspaceId = computed(() => app.workspace.activeWorkspace.id)
  const currentDiscussions = computed(() => discussions.value.filter(view => view.workspaceId === workspaceId.value))
  const referenceChoices = computed(() => Object.values(app.workspace.getActiveDoc()?.entities ?? {}).filter((entity): entity is Item => isItem(entity) && !entity.archivedAt).map(item => ({ title: item.title, anchor: { workspaceScope: scope.value, boardId: app.workspace.activeBoard.value?.id ?? "", itemId: item.id } })))

  async function discuss(itemId: string, fieldId?: string, selected?: Anchor["selection"]) {
    scope.value = await getChatScope(workspaceId.value)
    const item = app.workspace.getActiveDoc()?.entities[itemId]
    if (!item || !isItem(item)) { sourceState.value = "Source unavailable"; return }
    const anchor: Anchor = { workspaceScope: scope.value, boardId: app.workspace.activeBoard.value?.id ?? "", itemId, ...(fieldId ? { fieldId } : {}), ...(selected ? { selection: selected } : {}) }
    const id = `discussion:${itemId}`
    const existing = discussions.value.find(view => view.workspaceId === workspaceId.value && view.id === id)
    if (existing) { existing.context = { references: [anchor], mentions: [] }; existing.anchor = { ...anchor, fieldId: undefined, selection: undefined }; focusSpatialWindow(workspaceId.value, id) }
    else discussions.value.push({ workspaceId: workspaceId.value, id, title: `Discussion · ${item.title}`, anchor: { workspaceScope: anchor.workspaceScope, boardId: anchor.boardId, itemId }, context: { references: [anchor], mentions: [] } })
    selection.value = null
    await app.collaboration.device.chat.refresh()
  }
  function messages(view: Discussion) {
    return conversationMessages(app.collaboration.device.chat.messages.value as StoredChatMessage[], { anchor: view.anchor, rootId: view.rootId }) as typeof app.collaboration.device.chat.messages.value
  }
  function close(view: Discussion) { discussions.value = discussions.value.filter(candidate => candidate !== view) }
  function selectedDiscuss() { const value = selection.value; if (value) void discuss(value.itemId, value.fieldId, value.selection) }

  function captureSelection() { selection.value = captureSelectedSource() }
  function contextual(event: MouseEvent) { captureSelection(); if (selection.value) event.preventDefault() }

  async function openReference(anchor: Anchor) {
    highlighter.clear()
    sourceState.value = ""
    if (!app.collaboration.permissions.confirmedRole.value || app.collaboration.device.sync.isWorkspaceAccessRevoked(workspaceId.value)) { sourceState.value = "Workspace access unavailable"; return }
    if (anchor.workspaceScope !== scope.value) { sourceState.value = "Workspace unavailable"; return }
    const item = app.workspace.getActiveDoc()?.entities[anchor.itemId]
    if (anchor.boardId !== app.workspace.activeBoard.value?.id || !item || !isItem(item) || item.archivedAt) { sourceState.value = "Source unavailable"; return }
    app.actions.openBoardItem(item)
    await nextTick()
    const owner = findSourceOwner(anchor.itemId)
    const sourceWindow = owner?.closest<HTMLElement>("[data-window-id]")
    if (sourceWindow) focusSpatialWindow(workspaceId.value, sourceWindow.dataset.windowId!)
    if (anchor.fieldId && owner) highlighter.highlight(owner, anchor)
  }

  watch(() => [workspaceId.value, app.workspace.ready.value], async () => {
    highlighter.clear(); selection.value = null; sourceState.value = ""; linkedMessageId.value = ""; scope.value = ""
    if (!app.workspace.ready.value) return
    const id = workspaceId.value
    try { const next = await getChatScope(id); if (id === workspaceId.value) scope.value = next } catch { /* workspace not available yet */ }
  }, { immediate: true })
  onMounted(() => { document.addEventListener("selectionchange", captureSelection); document.addEventListener("contextmenu", contextual); window.addEventListener("hashchange", navigate); void navigate() })
  onBeforeUnmount(() => { highlighter.clear(); document.removeEventListener("selectionchange", captureSelection); document.removeEventListener("contextmenu", contextual); window.removeEventListener("hashchange", navigate) })
  return { scope, currentDiscussions, referenceChoices, selection, sourceState, navigationState, linkedMessageId, discuss, selectedDiscuss, messages, close, openReference, navigate }
}
