<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from "vue"
import ModalLayer from "./ModalLayer.vue"

interface ChatMessage {
  id: string
  personId: string
  name: string
  body: string
  createdAt: string
}

const props = withDefaults(
  defineProps<{
  readOnly?: boolean
    workspaceTitle: string
    messages: readonly ChatMessage[]
    currentPersonId: string
    sending: boolean
    error: string
    loading: boolean
    connected: boolean
    typingPeople: readonly string[]
  }>(),
  {
    workspaceTitle: "",
    messages: () => [],
    currentPersonId: "",
    sending: false,
    error: "",
    loading: false,
    connected: false,
    typingPeople: () => [],
  }
)

const emit = defineEmits<{
  close: []
  send: [body: string]
  typing: [active: boolean]
}>()

const draft = ref("")
const isSubmitting = ref(false)
const isComposing = ref(false)
const userJustSent = ref(false)
const messageListRef = ref<HTMLElement | null>(null)
const chatDialogRef = ref<HTMLElement | null>(null)
const isAtBottom = ref(true)
const visibleCount = ref(100)
const chatSize = ref<{ width: number; height: number } | null>(null)
const chatDialogStyle = computed<Record<string, string> | undefined>(() => chatSize.value
  ? { "--chat-width": `${chatSize.value.width}px`, "--chat-height": `${chatSize.value.height}px` }
  : undefined)

function boundedChatSize(width: number, height: number) {
  const gutter = 48
  return {
    width: Math.min(Math.max(width, Math.min(360, window.innerWidth - gutter)), window.innerWidth - gutter),
    height: Math.min(Math.max(height, Math.min(360, window.innerHeight - gutter)), window.innerHeight - gutter),
  }
}

function startResize(event: PointerEvent) {
  if (window.matchMedia("(max-width: 600px)").matches) return
  const dialog = chatDialogRef.value
  const handle = event.currentTarget as HTMLElement
  if (!dialog) return
  const rect = dialog.getBoundingClientRect()
  const origin = { x: event.clientX, y: event.clientY, width: rect.width, height: rect.height }
  handle.setPointerCapture(event.pointerId)
  const move = (next: PointerEvent) => {
    chatSize.value = boundedChatSize(origin.width + next.clientX - origin.x, origin.height + next.clientY - origin.y)
  }
  const stop = () => {
    handle.removeEventListener("pointermove", move)
    handle.removeEventListener("pointerup", stop)
    handle.removeEventListener("pointercancel", stop)
  }
  handle.addEventListener("pointermove", move)
  handle.addEventListener("pointerup", stop)
  handle.addEventListener("pointercancel", stop)
  event.preventDefault()
}

function resizeWithKeyboard(event: KeyboardEvent) {
  const delta = { ArrowLeft: [-24, 0], ArrowRight: [24, 0], ArrowUp: [0, -24], ArrowDown: [0, 24] }[event.key]
  const dialog = chatDialogRef.value
  if (!delta || !dialog) return
  const rect = dialog.getBoundingClientRect()
  chatSize.value = boundedChatSize(rect.width + delta[0], rect.height + delta[1])
  event.preventDefault()
}

const availableMessages = computed<readonly ChatMessage[]>(() => {
  if (!props.messages) return []
  if (props.messages.length > 2000) {
    return props.messages.slice(-2000)
  }
  return props.messages
})

const hasEarlier = computed(() => {
  return availableMessages.value.length > visibleCount.value
})

const displayedMessages = computed(() => {
  const all = availableMessages.value
  if (all.length <= visibleCount.value) {
    return all
  }
  return all.slice(-visibleCount.value)
})
const typingLabel = computed(() => props.typingPeople.length === 1
  ? `${props.typingPeople[0]} is typing…`
  : props.typingPeople.length > 1 ? `${props.typingPeople[0]} and ${props.typingPeople.length - 1} others are typing…` : "")

function isScrolledToBottom(el: HTMLElement, threshold = 40): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold
}

function handleScroll() {
  const el = messageListRef.value
  if (!el) return
  isAtBottom.value = isScrolledToBottom(el)
}

async function scrollToBottom(smooth = false) {
  await nextTick()
  const el = messageListRef.value
  if (!el) return
  el.scrollTo({
    top: el.scrollHeight,
    behavior: smooth ? "smooth" : "auto",
  })
}

async function loadEarlier() {
  const el = messageListRef.value
  if (!el) return
  const prevHeight = el.scrollHeight
  const prevTop = el.scrollTop

  visibleCount.value = Math.min(
    visibleCount.value + 100,
    2000,
    availableMessages.value.length
  )

  await nextTick()
  const newHeight = el.scrollHeight
  el.scrollTop = prevTop + (newHeight - prevHeight)
}

function handleSubmit() {
  const text = draft.value.trim()
  if (!text || props.sending || isSubmitting.value) {
    return
  }
  isSubmitting.value = true
  userJustSent.value = true
  emit("typing", false)
  emit("send", text)
  void scrollToBottom(true)
}

function closeChat() {
  emit("typing", false)
  emit("close")
}

watch(draft, value => emit("typing", Boolean(value.trim())))

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === "Enter") {
    if (e.shiftKey || e.isComposing || isComposing.value) {
      return
    }
    e.preventDefault()
    handleSubmit()
  }
}

watch(
  [() => props.sending, () => props.error] as const,
  ([sending, error], [prevSending]) => {
    if (prevSending && !sending) {
      isSubmitting.value = false
      if (!error) {
        draft.value = ""
      }
    } else if (sending) {
      isSubmitting.value = true
    }
    if (error) {
      isSubmitting.value = false
    }
  }
)

watch(
  () => props.messages,
  async (newMsgs) => {
    const el = messageListRef.value
    if (!el) return

    const lastMsg = newMsgs && newMsgs.length > 0 ? newMsgs[newMsgs.length - 1] : null
    const isFromMe = Boolean(
      lastMsg &&
      props.currentPersonId &&
      lastMsg.personId === props.currentPersonId
    )

    const shouldScroll = userJustSent.value || isFromMe || isAtBottom.value
    if (shouldScroll) {
      userJustSent.value = false
      await nextTick()
      await scrollToBottom(true)
    }
  },
  { deep: true }
)

watch(
  () => props.loading,
  async (newLoading, oldLoading) => {
    if (oldLoading && !newLoading) {
      await nextTick()
      await scrollToBottom(false)
    }
  }
)

onMounted(async () => {
  await nextTick()
  await scrollToBottom(false)
})

function formatDisplayTime(createdAt: string): string {
  if (!createdAt) return ""
  try {
    const d = new Date(createdAt)
    if (isNaN(d.getTime())) return createdAt
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  } catch {
    return createdAt
  }
}
</script>

<template>
  <ModalLayer
    :protect-draft="true"
    :busy="sending"
    class="overlay chat-overlay"
    @close="closeChat"
  >
    <section
      ref="chatDialogRef"
      class="dialog chat-dialog"
      :style="chatDialogStyle"
      role="dialog"
      aria-modal="true"
      aria-label="Workspace chat"
    >
      <header class="dialog-head chat-head">
        <div class="chat-head-content">
          <span v-if="workspaceTitle" class="eyebrow">{{ workspaceTitle }}</span>
          <h2 class="chat-title">Chat{{ workspaceTitle ? ` · ${workspaceTitle}` : "" }}</h2>
          <div class="chat-connection" :class="{ 'is-connected': connected }">
            <span
              class="connection-dot"
              :class="connected ? 'dot-live' : 'dot-local'"
              aria-hidden="true"
            ></span>
            <span class="connection-status-text">
              {{ connected ? "Live" : "Saved locally · sync when connected" }}
            </span>
          </div>
        </div>
        <button
          class="icon-button chat-close-btn"
          type="button"
          aria-label="Close"
          :disabled="sending"
          @click="closeChat"
        >×</button>
      </header>

      <div
        ref="messageListRef"
        class="chat-messages-log"
        role="log"
        aria-label="Chat messages"
        tabindex="0"
        @scroll.passive="handleScroll"
      >
        <div v-if="hasEarlier" class="chat-load-earlier">
          <button
            class="button button-quiet button-small"
            type="button"
            @click="loadEarlier"
          >
            Load earlier messages
          </button>
        </div>

        <div v-if="loading" class="chat-status chat-loading" role="status">
          <div class="loading-indicator">
            <div class="loading-track"><span></span></div>
            <span>Loading messages...</span>
          </div>
        </div>

        <div v-else-if="displayedMessages.length === 0" class="chat-status chat-empty">
          <p class="chat-empty-text">No messages yet. Send a message to start chatting.</p>
        </div>

        <article
          v-for="msg in displayedMessages"
          :key="msg.id"
          class="chat-message-item"
          :class="{ 'is-own': msg.personId === currentPersonId }"
        >
          <div class="chat-message-meta">
            <strong class="chat-message-author">{{ msg.name || "Anonymous" }}</strong>
            <span v-if="msg.personId === currentPersonId" class="chat-author-tag">(You)</span>
            <time
              class="chat-message-time"
              :datetime="msg.createdAt"
              :title="msg.createdAt"
            >
              {{ formatDisplayTime(msg.createdAt) }}
            </time>
          </div>
          <div class="chat-message-body">{{ msg.body }}</div>
        </article>

        <div v-if="typingLabel" class="chat-typing" role="status" aria-label="Typing presence">{{ typingLabel }}</div>
      </div>

      <p v-if="error" class="form-error chat-error-banner" role="alert">
        {{ error }}
      </p>

      <p v-if="readOnly" class="chat-status">Visitor · view only</p>
      <footer v-else class="chat-footer">
        <form class="chat-composer-form" novalidate @submit.prevent="handleSubmit">
          <div class="chat-composer-field">
            <label for="chat-message-textarea" class="chat-composer-label">
              <span>Message</span>
            </label>
            <textarea
              id="chat-message-textarea"
              v-model="draft"
              class="chat-textarea"
              maxlength="8000"
              placeholder="Write a message... (Enter to send, Shift+Enter for newline)"
              :disabled="sending"
              rows="2"
              @keydown="handleKeyDown"
              @blur="emit('typing', false)"
              @compositionstart="isComposing = true"
              @compositionend="isComposing = false"
            ></textarea>
          </div>
          <div class="chat-composer-actions">
            <button
              class="button button-primary chat-submit-btn"
              type="submit"
              :disabled="sending || isSubmitting || !draft.trim()"
            >
              Send message
            </button>
          </div>
        </form>
      </footer>
      <button class="chat-resize-handle" type="button" aria-label="Resize chat"
        @pointerdown="startResize" @keydown="resizeWithKeyboard">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M14 5 5 14M14 10l-4 4" />
        </svg>
      </button>
    </section>
  </ModalLayer>
</template>

<style src="./WorkspaceChat.css" scoped></style>
