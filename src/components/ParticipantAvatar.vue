<script setup lang="ts">
import { computed } from "vue"
import { participantAvatar } from "../chat/avatar"

const props = defineProps<{ personId?: string | null; avatarData?: string }>()
const avatar = computed(() => participantAvatar(props.personId))
</script>

<template>
  <img v-if="avatarData" class="participant-avatar participant-avatar-photo" :src="avatarData" alt="" aria-hidden="true" />
  <svg v-else class="participant-avatar" viewBox="0 0 48 48" aria-hidden="true" focusable="false" :data-avatar-version="avatar.version" :data-avatar-neutral="avatar.neutral">
    <rect x="1" y="1" width="46" height="46" rx="13" :fill="avatar.background" />
    <g stroke="#332f2b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path v-if="avatar.crown" :d="avatar.crown" :fill="avatar.faceColor" />
      <path :d="avatar.face" :fill="avatar.faceColor" />
      <path :d="avatar.eyes" fill="none" stroke-width="2.5" />
      <path :d="avatar.mouth" fill="none" />
    </g>
  </svg>
</template>

<style scoped>
.participant-avatar {
  display: block;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
}
.participant-avatar-photo { object-fit: cover; border-radius: 50%; }
</style>
