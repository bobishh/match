<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { messageReferenceUrl } from "../chat/messageReference"

const props = defineProps<{ workspaceScope: string; messageId: string; disabled?: boolean }>()
const notice = ref("")
const fallback = ref(false)
const copying = ref(false)
const linkInput = ref<HTMLInputElement>()
const url = computed(() => messageReferenceUrl(window.location.href, {
  workspaceScope: props.workspaceScope, messageId: props.messageId,
}))
watch(() => [props.workspaceScope, props.messageId], () => { notice.value = ""; fallback.value = false })

async function copyLink() {
  if (props.disabled || copying.value) return
  copying.value = true
  notice.value = ""
  fallback.value = false
  try {
    await navigator.clipboard.writeText(url.value)
    notice.value = "Message link copied"
  } catch {
    fallback.value = true
    notice.value = "Clipboard unavailable. Select and copy this link."
  } finally {
    copying.value = false
  }
}
</script>

<template>
  <div class="message-link-action">
    <button class="button button-quiet" type="button" :disabled="disabled || copying" title="Workspace must already be available on the receiving device." @click="copyLink">Copy message link</button>
    <span v-if="notice" role="status">{{ notice }}</span>
    <template v-if="fallback">
      <label>Message link<input ref="linkInput" aria-label="Message link" :value="url" readonly @focus="linkInput?.select()" @click="linkInput?.select()"></label>
      <small>Workspace must already be available on the receiving device.</small>
    </template>
  </div>
</template>

<style scoped>
.message-link-action { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
.message-link-action button { padding: 4px 8px; font-size: .8rem; }
.message-link-action span, .message-link-action small { color: var(--muted); font-size: .8rem; }
.message-link-action label { display: grid; gap: 4px; width: 100%; min-width: 0; font-size: .8rem; }
.message-link-action input { width: 100%; min-width: 0; box-sizing: border-box; }
</style>
