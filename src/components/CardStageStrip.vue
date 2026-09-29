<script setup lang="ts">
import { computed, ref } from "vue"
import { isArchiveColumn } from "../domain/archive"
import type { Column, Item } from "../domain/model"
import type { CardStageButton } from "../domain/cardStageButtons"

const props = defineProps<{
  item: Item
  columns: Column[]
  buttons: CardStageButton[]
  readOnly?: boolean
  move: (item: Item, columnId: string) => Promise<void>
}>()

const pendingColumnId = ref<string | null>(null)
const error = ref("")
const activeColumnId = computed(() => props.item.archivedAt
  ? props.columns.find(isArchiveColumn)?.id
  : props.item.placement.parentId)
const visibleButtons = computed(() => props.buttons.flatMap(button => {
  const column = props.columns.find(column => column.id === button.columnId)
  return column ? [{ ...button, title: button.label || column.title }] : []
}))

async function selectColumn(columnId: string) {
  if (props.readOnly || pendingColumnId.value || activeColumnId.value === columnId) return
  pendingColumnId.value = columnId
  error.value = ""
  try { await props.move(props.item, columnId) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { pendingColumnId.value = null }
}
</script>

<template>
  <div v-if="visibleButtons.length" class="status-strip" aria-label="Move card to column">
    <button v-for="button in visibleButtons" :key="button.columnId" type="button"
      :class="{ active: activeColumnId === button.columnId }"
      :aria-pressed="activeColumnId === button.columnId"
      :disabled="readOnly || pendingColumnId !== null"
      @click="selectColumn(button.columnId)">{{ button.title }}</button>
  </div>
  <p v-if="pendingColumnId" role="status" class="dialog-copy">Moving card…</p>
  <p v-if="error" role="alert" class="form-error">Move failed: {{ error }}</p>
</template>
