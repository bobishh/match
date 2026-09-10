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
    workspaceTitle: string
    messages: readonly ChatMessage[]
    currentPersonId: string
    sending: boolean
    error: string
    loading: boolean
    connected: boolean
  }>(),
  {
    workspaceTitle: "",
    messages: () => [],
    currentPersonId: "",
    sending: false,
    error: "",
    loading: false,
    connected: false,
  }
)

const emit = defineEmits<{
  close: []
  send: [body: string]
}>()

const draft = ref("")
const isSubmitting = ref(false)
const isComposing = ref(false)
const userJustSent = ref(false)
const messageListRef = ref<HTMLElement | null>(null)
const isAtBottom = ref(true)
const visibleCount = ref(100)

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
  emit("send", text)
  scrollToBottom(true)
}

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
      scrollToBottom(true)
    }
  },
  { deep: true }
)

watch(
  () => props.loading,
  async (newLoading, oldLoading) => {
    if (oldLoading && !newLoading) {
      await nextTick()
      scrollToBottom(false)
    }
  }
)

onMounted(async () => {
  await nextTick()
  scrollToBottom(false)
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
    @close="emit('close')"
  >
    <section
      class="dialog chat-dialog"
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
          @click="emit('close')"
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
      </div>

      <p v-if="error" class="form-error chat-error-banner" role="alert">
        {{ error }}
      </p>

      <footer class="chat-footer">
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
    </section>
  </ModalLayer>
</template>

<style scoped>
.chat-dialog {
  display: flex;
  flex-direction: column;
  width: min(680px, 100%);
  height: min(720px, calc(100dvh - 32px));
  max-height: 100dvh;
  padding: 24px;
  overflow: hidden;
  border: 2px solid var(--line);
  background: var(--panel);
  box-shadow: 6px 6px 0 var(--ink);
  box-sizing: border-box;
}

.chat-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  flex-shrink: 0;
  margin-bottom: 12px;
  padding-bottom: 12px;
  border-bottom: 2px solid var(--line);
}

.chat-head-content {
  min-width: 0;
  flex: 1;
}

.chat-title {
  margin: 4px 0 0;
  font-size: clamp(1.3rem, 3vw, 1.8rem);
  line-height: 1.15;
  letter-spacing: -0.04em;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.chat-connection {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-top: 8px;
  color: var(--muted);
  font: 800 0.68rem/1 ui-monospace, monospace;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.connection-dot {
  width: 8px;
  height: 8px;
  border: 1px solid var(--ink);
  border-radius: 50%;
  display: inline-block;
  flex-shrink: 0;
}

.dot-live {
  background: var(--green);
}

.dot-local {
  background: var(--muted);
}

.chat-close-btn {
  flex-shrink: 0;
  width: 44px;
  height: 44px;
}

.chat-messages-log {
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 4px;
  box-sizing: border-box;
}

.chat-load-earlier {
  display: flex;
  justify-content: center;
  margin-bottom: 6px;
  flex-shrink: 0;
}

.chat-status {
  padding: 32px 16px;
  text-align: center;
  color: var(--muted);
  font: 700 0.78rem/1.4 ui-monospace, monospace;
}

.chat-loading {
  display: flex;
  justify-content: center;
}

.chat-message-item {
  display: flex;
  flex-direction: column;
  gap: 5px;
  max-width: min(85%, 520px);
  padding: 10px 14px;
  border: 2px solid var(--line);
  background: white;
  align-self: flex-start;
  box-shadow: 2px 2px 0 var(--line);
  box-sizing: border-box;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.chat-message-item.is-own {
  align-self: flex-end;
  background: #fef9db;
}

.chat-message-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

.chat-message-author {
  font-size: 0.82rem;
  font-weight: 900;
  color: var(--ink);
}

.chat-author-tag {
  font: 800 0.62rem/1 ui-monospace, monospace;
  color: var(--blue);
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.chat-message-time {
  margin-left: auto;
  font: 700 0.68rem/1 ui-monospace, monospace;
  color: var(--muted);
}

.chat-message-body {
  font-size: 0.9rem;
  line-height: 1.45;
  white-space: pre-wrap;
  color: var(--ink);
}

.chat-error-banner {
  flex-shrink: 0;
  margin: 8px 0;
}

.chat-footer {
  flex-shrink: 0;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 2px solid var(--line);
}

.chat-composer-form {
  display: grid;
  gap: 8px;
}

.chat-composer-label {
  display: block;
  margin-bottom: 6px;
  color: var(--muted);
  font: 800 0.68rem/1 ui-monospace, monospace;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.chat-textarea {
  width: 100%;
  min-height: 52px;
  max-height: 120px;
  resize: vertical;
  padding: 10px 12px;
  border: 2px solid var(--line);
  border-radius: 0;
  background: white;
  font: 400 0.92rem/1.4 Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--ink);
  box-sizing: border-box;
}

.chat-composer-actions {
  display: flex;
  justify-content: flex-end;
}

.chat-submit-btn {
  min-height: 42px;
  padding: 8px 18px;
}

@media (max-width: 600px) {
  :global(.overlay.chat-overlay) {
    padding: 0 !important;
  }

  .chat-dialog {
    width: 100vw;
    height: 100dvh;
    max-height: 100dvh;
    padding: 14px 12px;
    border: none;
    box-shadow: none;
  }

  .chat-head {
    margin-bottom: 8px;
    padding-bottom: 8px;
  }

  .chat-message-item {
    max-width: 92%;
  }

  .chat-submit-btn {
    width: 100%;
  }
}
</style>
