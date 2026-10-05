<script setup lang="ts">
import { computed } from "vue"
import { MarkdownContent } from "../ui/markdownContent"
import type { DragPreview } from "../app/useBoardDrag"
type Marker = { targetId: string; beforeId: string | null; vertical?: boolean }
type Controller = { dragPreview: { value: DragPreview | null }; dropMarker: { value: Marker | null }; setDragPreviewElement(element: HTMLElement | null): void; setDropMarkerElement(element: HTMLElement | null): void }

const props = defineProps<{ controller: Controller; filtered: boolean }>()
const preview = computed(() => props.controller.dragPreview.value)
function setPreview(element: unknown) { props.controller.setDragPreviewElement(element instanceof HTMLElement ? element : null) }
function setMarker(element: unknown) { props.controller.setDropMarkerElement(element instanceof HTMLElement ? element : null) }
</script>

<template>
  <div v-if="preview" :ref="setPreview" class="board-drag-preview lead-card" :class="[{ 'lead-card-expanded': filtered }, preview.ageLevel]" :style="{ width: `${preview.width}px` }" aria-hidden="true">
    <template v-if="preview.kind === 'item'">
      <div class="card-layout"><div class="card-main">
        <template v-if="preview.lead">
          <div class="card-head"><span class="company">{{ preview.lead.company }}</span><span v-if="preview.lead.priority" class="priority" :class="preview.lead.priority">{{ preview.lead.priority.toUpperCase() }}</span></div>
          <strong>{{ preview.lead.role }}</strong>
          <div class="card-meta"><span v-if="preview.lead.location">{{ preview.lead.location }}</span><span v-if="preview.lead.fitScore !== undefined" class="fit">{{ preview.lead.fitScore }}/10 fit</span></div>
        </template>
        <template v-else><strong>{{ preview.title }}</strong><MarkdownContent v-if="!filtered && preview.body" class="item-card-body" :source="preview.body" compact /></template>
      </div><div v-if="filtered && (preview.notes || preview.context.length)" class="card-context">
        <MarkdownContent v-if="preview.notes" class="card-notes" :source="preview.notes" compact />
        <dl v-if="preview.context.length" class="card-fields"><div v-for="field in preview.context" :key="field.id"><dt>{{ field.title }}</dt><dd>{{ field.value }}</dd></div></dl>
      </div></div>
      <span v-if="preview.ageLabel" class="card-activity-age">{{ preview.ageLabel }}</span>
    </template>
    <strong v-else>{{ preview.title }}</strong>
  </div>
  <div v-if="controller.dropMarker.value" :ref="setMarker" class="board-drop-marker" :class="{ 'is-vertical': controller.dropMarker.value.vertical }" :data-target-id="controller.dropMarker.value.targetId" :data-before-id="controller.dropMarker.value.beforeId ?? undefined" aria-hidden="true"></div>
</template>
