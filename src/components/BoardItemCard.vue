<script setup lang="ts">
import { computed } from "vue"
import { MarkdownContent } from "../ui/markdownContent"
import type { Item } from "../domain/model"
import type { Lead } from "../types"

type CardField = { id: string; title: string; value: string }
const CARD_NOTE_PREVIEW_LIMIT = 320

const props = defineProps<{
  item: Item
  lead?: Lead
  notes: string
  searchQuery?: string
  searchMatchIndex?: number
  fields: CardField[]
  bindings?: Record<string, string>
  hasFilters: boolean
  canEditItems: boolean
  moved: boolean
  ageLevel?: string
  ageLabel?: string
}>()

const notePreview = computed(() => previewCardNote(props.notes, props.searchQuery ?? "", props.searchMatchIndex ?? -1))

function previewCardNote(source: string, searchQuery: string, match: number) {
  const query = searchQuery.trim()
  const limit = Math.min(Math.max(CARD_NOTE_PREVIEW_LIMIT, query.length + 80), 2_000)
  if (source.length <= limit) return source
  let start = match >= limit || match + query.length > limit ? Math.max(0, match - 120) : 0
  if (start > 0) {
    const wordStart = source.lastIndexOf(" ", start)
    if (wordStart >= start - 40) start = wordStart + 1
  }
  const excerpt = source.slice(start, start + limit)
  const paragraphEnd = excerpt.lastIndexOf("\n\n")
  const wordEnd = excerpt.lastIndexOf(" ")
  let end = paragraphEnd >= limit / 2 ? paragraphEnd : wordEnd
  if (match >= start && match < start + limit) {
    end = Math.max(end, Math.min(limit, match - start + query.length + 48))
  }
  const prefix = start > 0 ? "…\n\n" : ""
  const suffix = start + end < source.length ? "\n\n…" : ""
  return `${prefix}${excerpt.slice(0, end > 0 ? end : limit).trimEnd()}${suffix}`
}

const emit = defineEmits<{
  open: [item: Item, event: MouseEvent]
  select: [item: Item]
  discuss: [itemId: string]
  taskToggle: [item: Item, markdown: string]
}>()
</script>

<template>
  <article
    class="lead-card item-card"
    :class="[{ 'card-moved': moved, 'lead-card-expanded': hasFilters }, ageLevel ? `card-aging-${ageLevel}` : '']"
    :data-item-id="item.id"
    :data-discussion-item="item.id"
    @click="emit('open', item, $event)"
  >
    <button class="card-open-button" type="button" :aria-label="`Open ${item.title}${ageLevel && ageLevel !== 'fresh' ? `. ${ageLabel}` : ''}`" @click="emit('select', item)"></button>
    <div class="card-layout">
      <div class="card-main">
        <template v-if="lead">
          <div class="card-head">
            <span class="company" data-discussion-text :data-discussion-field="bindings?.['field.company']">{{ lead.company }}</span>
            <span v-if="lead.priority" data-discussion-text :data-discussion-field="bindings?.['field.priority']" class="priority" :class="lead.priority">{{ lead.priority.toUpperCase() }}</span>
          </div>
          <strong data-discussion-text :data-discussion-field="bindings?.['field.role']">{{ lead.role }}</strong>
          <div class="card-meta">
            <span v-if="lead.location" data-discussion-text :data-discussion-field="bindings?.['field.location']">{{ lead.location }}</span>
            <span v-if="lead.fitScore !== undefined" class="fit"><span data-discussion-text :data-discussion-field="bindings?.['field.fitScore']">{{ lead.fitScore }}</span>/10 fit</span>
          </div>
        </template>
        <template v-else>
          <strong data-discussion-text data-discussion-field="title">{{ item.title }}</strong>
          <MarkdownContent v-if="item.body" v-show="!hasFilters" class="item-card-body" data-discussion-text data-discussion-field="narrative" :source="item.body" compact :editable-tasks="canEditItems" @task-toggle="emit('taskToggle', item, $event)" />
        </template>
      </div>
      <div v-if="hasFilters && (notes || fields.length)" class="card-context">
        <MarkdownContent v-if="notes" class="card-notes" data-discussion-text data-discussion-field="narrative" :source="notePreview" compact :editable-tasks="canEditItems" @task-toggle="emit('taskToggle', item, $event)" />
        <dl v-if="fields.length" class="card-fields">
          <div v-for="field in fields" :key="field.id"><dt>{{ field.title }}</dt><dd data-discussion-text :data-discussion-field="field.id">{{ field.value }}</dd></div>
        </dl>
      </div>
    </div>
    <button v-if="canEditItems" class="card-chat-action" type="button" :aria-label="`Discuss ${item.title}`" title="Discuss card" @click.stop="emit('discuss', item.id)">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8l-6 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" /><path d="M7 9h10M7 13h7" /></svg>
    </button>
    <span v-if="ageLevel && ageLevel !== 'fresh'" class="card-activity-age">{{ ageLabel }}</span>
  </article>
</template>
