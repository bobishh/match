import { computed, onBeforeUnmount, ref, watch, type Ref } from "vue"
import { bootstrapIdentity } from "../domain/identity"
import { messageOrderKey, type ChatSnapshot } from "./store"
import { resolveDisplayNames, randomDisplayName } from "./names"
import {
  ensureChatProfile,
  renameChatProfile,
  sendChatMessage,
  sendChatTyping,
  subscribeChat,
  loadChat,
  loadChatTyping,
  readChatCursor,
  markChatRead,
  type ChatTyping,
} from "./service"

type SubscriptionOptions = {
  workspaceId: Ref<string>
  open: Ref<boolean>
  personId: Ref<string>
  snapshot: Ref<ChatSnapshot>
  names: Ref<Record<string, string>>
  toast: Ref<{ workspaceId: string; text: string } | null>
  nameError: Ref<string>
  refresh: () => Promise<void>
  refreshTyping: () => void
}

function createChatViews(
  snapshot: Ref<ChatSnapshot>,
  suggestedName: Ref<string | null>,
  personId: Ref<string>,
  ownerId: Ref<string>,
  cursor: Ref<string | null>,
  typing: Ref<ChatTyping[]>
) {
  const names = computed(() => resolveDisplayNames(snapshot.value.profiles.map((profile) => ({ personId: profile.personId, name: profile.name }))))
  const ownName = computed(() => suggestedName.value ?? snapshot.value.profiles.find((profile) => profile.personId === personId.value)?.name ?? "")
  const displayName = computed(() => names.value[personId.value] ?? ownName.value)
  const members = computed(() => snapshot.value.profiles.map((profile) => ({
    personId: profile.personId,
    name: names.value[profile.personId] ?? profile.name,
    role: profile.personId === ownerId.value ? "Owner" : "Member",
  })).sort((left, right) => left.personId < right.personId ? -1 : left.personId > right.personId ? 1 : 0))
  const messages = computed(() => snapshot.value.messages.map((message) => ({
    ...message,
    name: names.value[message.personId] ?? `Participant · ${message.personId.slice(0, 6)}`,
  })))
  const unread = computed(() => snapshot.value.messages.filter((message) =>
    message.personId !== personId.value && (!cursor.value || messageOrderKey(message) > cursor.value)).length)
  const typingPeople = computed(() => [...new Set(typing.value.filter((item) => item.personId !== personId.value)
    .map((item) => item.personId))].map((id) => names.value[id] ?? `Participant · ${id.slice(0, 6)}`))
  return { names, ownName, displayName, members, messages, unread, typingPeople }
}

function subscribeWorkspaceChat(options: SubscriptionOptions): () => void {
  let toastTimer: ReturnType<typeof setTimeout> | undefined
  const unsubscribe = subscribeChat((event) => {
    if (event.workspaceId !== options.workspaceId.value) return
    void options.refresh()
    if (event.typing?.length) options.refreshTyping()
    if (event.remote && !options.snapshot.value.profiles.some((profile) => profile.personId === options.personId.value)) {
      void ensureChatProfile(event.workspaceId)
        .then(() => {
          if (event.workspaceId === options.workspaceId.value) {
            options.nameError.value = ""
            void options.refresh()
          }
        })
        .catch(() => undefined)
    }
    if (!event.remote || event.history || options.open.value || document.visibilityState !== "visible" || !document.hasFocus()) return
    const last = event.added.filter((message) => message.personId !== options.personId.value).at(-1)
    if (!last) return
    void navigator.locks.request(`match-chat-notification:${last.workspaceId}`, async () => {
      const key = `match.chat.notified:${last.workspaceId}`
      const order = messageOrderKey(last)
      if ((localStorage.getItem(key) ?? "") >= order) return
      localStorage.setItem(key, order)
      if (options.workspaceId.value !== event.workspaceId || options.open.value) return
      const sender = options.names.value[last.personId] ?? "New message"
      options.toast.value = { workspaceId: event.workspaceId, text: `${sender}: ${last.body.slice(0, 120)}` }
      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => {
        options.toast.value = null
      }, 6000)
    }).catch(() => undefined)
  })
  return () => {
    unsubscribe()
    clearTimeout(toastTimer)
  }
}

export function useWorkspaceChat(workspaceId: Ref<string>, ownerId: Ref<string>) {
  const open = ref(false), loading = ref(false), sending = ref(false), savingName = ref(false)
  const error = ref("")
  const nameError = ref("")
  const personId = ref("")
  const cursor = ref<string | null>(null)
  const snapshot = ref<ChatSnapshot>({ messages: [], profiles: [] })
  const suggestedName = ref<string | null>(null)
  const toast = ref<{ workspaceId: string; text: string } | null>(null)
  const typing = ref<ChatTyping[]>([])
  let typingExpiryTimer: ReturnType<typeof setTimeout> | undefined
  let typingIdleTimer: ReturnType<typeof setTimeout> | undefined
  let typingAnnounced = false
  let lastTypingPublished = 0
  let generation = 0
  const { names, ownName, displayName, members, messages, unread, typingPeople } = createChatViews(
    snapshot, suggestedName, personId, ownerId, cursor, typing
  )

  function refreshTyping() {
    typing.value = loadChatTyping(workspaceId.value)
    clearTimeout(typingExpiryTimer)
    if (typing.value.length) typingExpiryTimer = setTimeout(refreshTyping, 6_100)
  }

  function publishTyping(active: boolean) {
    if (!workspaceId.value || !personId.value) return
    void sendChatTyping(workspaceId.value, active).catch(() => {})
  }

  function setTyping(active: boolean) {
    clearTimeout(typingIdleTimer)
    if (!active) {
      if (typingAnnounced) publishTyping(false)
      typingAnnounced = false
      return
    }
    const now = Date.now()
    if (!typingAnnounced || now - lastTypingPublished >= 2_500) {
      typingAnnounced = true
      lastTypingPublished = now
      publishTyping(true)
    }
    typingIdleTimer = setTimeout(() => setTyping(false), 1_500)
  }

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
    setTyping(false)
    generation++
    suggestedName.value = null
    snapshot.value = { messages: [], profiles: [] }
    error.value = ""
    nameError.value = ""
    toast.value = null
    typing.value = []
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

  watch(open, () => {
    if (open.value) { toast.value = null; void refresh(); refreshTyping() }
    else setTyping(false)
  })
  const visibility = () => { if (document.visibilityState === "visible") void refresh() }
  document.addEventListener("visibilitychange", visibility)
  const unsubscribe = subscribeWorkspaceChat({
    workspaceId, open, personId, snapshot, names, toast, nameError, refresh, refreshTyping,
  })
  onBeforeUnmount(() => {
    setTyping(false)
    unsubscribe()
    clearTimeout(typingExpiryTimer)
    clearTimeout(typingIdleTimer)
    document.removeEventListener("visibilitychange", visibility)
  })

  async function send(body: string) {
    if (sending.value) return
    setTyping(false)
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
    typingPeople, setTyping, send, rename, randomize: () => { suggestedName.value = randomDisplayName() } }
}
