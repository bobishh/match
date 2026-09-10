import { computed, onBeforeUnmount, ref, watch, type Ref } from "vue"
import { bootstrapIdentity } from "../domain/identity"
import { messageOrderKey, type ChatSnapshot } from "./store"
import { resolveDisplayNames, randomDisplayName } from "./names"
import { ensureChatProfile, renameChatProfile, sendChatMessage, subscribeChat, loadChat, readChatCursor, markChatRead } from "./service"

export function useWorkspaceChat(workspaceId: Ref<string>, ownerId: Ref<string>) {
  const open = ref(false)
  const loading = ref(false)
  const sending = ref(false)
  const savingName = ref(false)
  const error = ref("")
  const nameError = ref("")
  const personId = ref("")
  const cursor = ref<string | null>(null)
  const snapshot = ref<ChatSnapshot>({ messages: [], profiles: [] })
  const suggestedName = ref<string | null>(null)
  const toast = ref<{ workspaceId: string; text: string } | null>(null)
  let toastTimer: ReturnType<typeof setTimeout> | undefined
  let generation = 0
  const names = computed(() => resolveDisplayNames(snapshot.value.profiles.map(p => ({ personId: p.personId, name: p.name }))))
  const ownName = computed(() => suggestedName.value ?? snapshot.value.profiles.find(p => p.personId === personId.value)?.name ?? "")
  const displayName = computed(() => names.value[personId.value] ?? ownName.value)
  const members = computed(() => snapshot.value.profiles.map(p => ({
    personId: p.personId, name: names.value[p.personId] ?? p.name,
    role: p.personId === ownerId.value ? "Owner" : "Member",
  })).sort((a, b) => a.personId < b.personId ? -1 : a.personId > b.personId ? 1 : 0))
  const messages = computed(() => snapshot.value.messages.map(m => ({ ...m, name: names.value[m.personId] ?? `Participant · ${m.personId.slice(0, 6)}` })))
  const unread = computed(() => snapshot.value.messages.filter(m => m.personId !== personId.value && (!cursor.value || messageOrderKey(m) > cursor.value)).length)

  async function markRead() {
    if (!open.value || document.visibilityState !== "visible") return
    const id = workspaceId.value
    const last = snapshot.value.messages.at(-1)
    if (!last) return
    const key = messageOrderKey(last)
    await markChatRead(id, key)
    if (id === workspaceId.value) cursor.value = key
  }

  async function refresh() {
    const id = workspaceId.value
    if (!id) return
    const current = ++generation
    try {
      const [next, read] = await Promise.all([loadChat(id), readChatCursor(id)])
      if (current !== generation || id !== workspaceId.value) return
      snapshot.value = next
      cursor.value = read
      await markRead()
    } catch (err) { if (id === workspaceId.value) error.value = err instanceof Error ? err.message : "Could not load chat" }
  }

  watch([workspaceId, ownerId], async () => {
    generation++
    suggestedName.value = null
    snapshot.value = { messages: [], profiles: [] }
    error.value = ""
    nameError.value = ""
    toast.value = null
    if (!workspaceId.value || !ownerId.value) return
    const id = workspaceId.value
    loading.value = true
    try {
      personId.value = (await bootstrapIdentity()).identity.personId
      await refresh()
      await ensureChatProfile(id)
      await refresh()
    } catch (err) { if (id === workspaceId.value) nameError.value = err instanceof Error ? err.message : "Could not load profile" }
    finally { if (id === workspaceId.value) loading.value = false }
  }, { immediate: true })

  watch(open, () => { if (open.value) { toast.value = null; void refresh() } })
  const visibility = () => { if (document.visibilityState === "visible") void refresh() }
  document.addEventListener("visibilitychange", visibility)
  const unsubscribe = subscribeChat(event => {
    if (event.workspaceId !== workspaceId.value) return
    void refresh()
    if (event.remote && !snapshot.value.profiles.some(p => p.personId === personId.value)) {
      void ensureChatProfile(event.workspaceId).then(() => {
        if (event.workspaceId === workspaceId.value) { nameError.value = ""; void refresh() }
      }).catch(() => {})
    }
    if (!event.remote || event.history || open.value || document.visibilityState !== "visible" || !document.hasFocus()) return
    const last = event.added.filter(m => m.personId !== personId.value).at(-1)
    if (!last) return
    // One browser profile, one notification claim. Durable claim also suppresses replay after reopening.
    void navigator.locks.request(`match-chat-notification:${last.workspaceId}`, async () => {
      const key = `match.chat.notified:${last.workspaceId}`
      const order = messageOrderKey(last)
      if ((localStorage.getItem(key) ?? "") >= order) return
      localStorage.setItem(key, order)
      if (workspaceId.value !== event.workspaceId || open.value) return
      toast.value = { workspaceId: event.workspaceId, text: `${names.value[last.personId] ?? "New message"}: ${last.body.slice(0, 120)}` }
      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => { toast.value = null }, 6000)
    }).catch(() => {})
  })
  onBeforeUnmount(() => { unsubscribe(); clearTimeout(toastTimer); document.removeEventListener("visibilitychange", visibility) })

  async function send(body: string) {
    if (sending.value) return
    sending.value = true
    error.value = ""
    const id = workspaceId.value
    try { await sendChatMessage(id, body); await refresh() }
    catch (err) { error.value = err instanceof Error ? err.message : "Could not save message. Try again." }
    finally { sending.value = false }
  }
  async function rename(name: string) {
    if (savingName.value) return
    savingName.value = true
    nameError.value = ""
    try { await renameChatProfile(workspaceId.value, name); suggestedName.value = null; await refresh() }
    catch (err) { nameError.value = err instanceof Error ? err.message : "Could not save name" }
    finally { savingName.value = false }
  }
  return { open, loading, sending, savingName, error, nameError, personId, ownName, displayName, members, messages, unread, toast,
    send, rename, randomize: () => { suggestedName.value = randomDisplayName() } }
}
