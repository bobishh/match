<script setup lang="ts">
import { defineAsyncComponent, type Component } from "vue"
const WorkspaceChat = defineAsyncComponent<Component>(() => import("./WorkspaceChat.vue"))
import type { useWorkspaceChat } from "../chat/useWorkspaceChat"
import type { useObjectConversations } from "../app/useObjectConversations"

defineProps<{
  workspaceId: string; workspaceTitle: string; readOnly: boolean; canView: boolean; connected: boolean
  chat: ReturnType<typeof useWorkspaceChat>; conversations: ReturnType<typeof useObjectConversations>
}>()
const emit = defineEmits<{ workspaces: []; chatClose: []; sourceDismiss: [] }>()
</script>

<template>
    <WorkspaceChat v-if="chat.open.value" :key="workspaceId" :workspace-title="workspaceTitle"
      :read-only="readOnly" :workspace-id="workspaceId" :workspace-scope="conversations.scope.value"
      :members="chat.members.value" :reference-choices="conversations.referenceChoices.value" :send-message="chat.send" :target-id="conversations.linkedMessageId.value" :navigation-state="conversations.navigationState.value"
      :messages="canView ? chat.messages.value : []" :current-person-id="chat.personId.value" :sending="chat.sending.value"
      :error="chat.error.value" :loading="chat.loading.value" :connected="connected"
      :typing-people="chat.typingPeople.value"
      @close="emit('chatClose')" @send="chat.send" @typing="chat.setTyping" @reference="conversations.openReference" @read="chat.markVisible" />
    <WorkspaceChat v-for="view in conversations.currentDiscussions.value" :key="`${view.workspaceId}:${view.id}`" :workspace-id="view.workspaceId" :window-id="view.id" :title="view.title"
      :workspace-title="workspaceTitle" :workspace-scope="conversations.scope.value" :initial-context="view.context" :reference-choices="conversations.referenceChoices.value" :members="chat.members.value"
      :messages="canView ? conversations.messages(view) : []" :all-messages="canView ? chat.messages.value : []" :current-person-id="chat.personId.value" :sending="chat.sending.value" :error="chat.error.value" :loading="chat.loading.value"
      :connected="connected" :typing-people="chat.typingPeople.value" :read-only="readOnly" :send-message="chat.send" :target-id="view.targetId"
      @close="conversations.close(view)" @reference="conversations.openReference" @read="chat.markVisible" @typing="chat.setTyping" />
    <button v-if="conversations.selection.value && !readOnly" class="button button-small selection-discuss" type="button" aria-label="Discuss selection"
      :style="{ left: `${conversations.selection.value.x}px`, top: `${conversations.selection.value.y}px` }" @pointerdown.prevent @click="conversations.selectedDiscuss">Discuss</button>
    <aside v-if="conversations.sourceState.value" class="source-feedback" role="status">{{ conversations.sourceState.value }}<button type="button" aria-label="Dismiss source feedback" @click="emit('sourceDismiss')">×</button></aside>
    <aside v-if="conversations.navigationState.value" class="source-feedback" role="status">{{ conversations.navigationState.value }}
      <button class="button button-small" type="button" @click="emit('workspaces')">Open workspaces</button>
      <button class="button button-small" type="button" @click="conversations.navigate">Retry message link</button>
    </aside>
</template>

<style scoped>
.selection-discuss { position: fixed; z-index: 28; touch-action: manipulation; }
.source-feedback { position: fixed; bottom: 12px; left: 12px; z-index: 29; max-width: calc(100vw - 24px); padding: 8px 12px; background: var(--panel); border: 2px solid var(--ink); overflow-wrap: anywhere; }
</style>
