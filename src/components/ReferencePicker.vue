<script setup lang="ts">
import { computed, nextTick, ref } from "vue"
import { MAX_REFERENCES, type Anchor } from "../chat/context"
import type { ReferenceChoice, ReferenceKind } from "../chat/referenceChoices"

const props = defineProps<{ choices: readonly ReferenceChoice[]; selected: readonly Anchor[] }>()
const emit = defineEmits<{ select: [anchor: Anchor] }>()
const query = ref("")
const kind = ref<ReferenceKind | "All">("All")
const input = ref<HTMLInputElement | null>(null)
const results = ref<HTMLElement | null>(null)
const kinds = computed(() => (["Card", "Description", "Field"] as const).filter(type => props.choices.some(choice => (choice.type ?? "Card") === type)))
const labels = { Card: "Cards", Description: "Descriptions", Field: "Fields" } as const
const terms = computed(() => query.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean))
const matches = computed(() => props.choices.filter(choice => {
  if (kind.value !== "All" && (choice.type ?? "Card") !== kind.value) return false
  const text = `${choice.title} ${choice.type ?? "Card"} ${choice.searchText ?? ""}`.toLocaleLowerCase()
  return terms.value.every(term => text.includes(term))
}))
const visible = computed(() => {
  if (terms.value.length || kind.value !== "All") return matches.value.slice(0, 8)
  return kinds.value.flatMap(type => matches.value.filter(choice => (choice.type ?? "Card") === type).slice(0, 2))
})
const isSelected = (anchor: Anchor) => props.selected.some(value => value.itemId === anchor.itemId && value.fieldId === anchor.fieldId)
function attach(choice: ReferenceChoice) {
  if (isSelected(choice.anchor) || props.selected.length >= MAX_REFERENCES) return
  emit("select", choice.anchor)
}
async function opened(event: Event) {
  if ((event.target as HTMLDetailsElement).open) { await nextTick(); input.value?.focus() }
}
function focusResult() { results.value?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus() }
</script>

<template>
  <details class="reference-picker" @toggle="opened">
    <summary>Attach item reference</summary>
    <label class="reference-search">Find reference<input ref="input" v-model="query" type="search" aria-label="Find reference" placeholder="Search by title, field or text" @keydown.down.prevent="focusResult" /></label>
    <div class="reference-types" role="group" aria-label="Reference types">
      <button class="button button-small" :class="kind === 'All' ? 'button-primary' : 'button-quiet'" type="button" :aria-pressed="kind === 'All'" @click="kind = 'All'">All</button>
      <button v-for="type in kinds" :key="type" class="button button-small" :class="kind === type ? 'button-primary' : 'button-quiet'" type="button" :aria-pressed="kind === type" @click="kind = type">{{ labels[type] }}</button>
    </div>
    <p class="section-copy reference-search-hint">{{ terms.length || kind !== 'All' ? `${visible.length} of ${matches.length} matches` : `Examples · type to search ${choices.length} references` }}</p>
    <div ref="results" class="reference-results" role="list" aria-label="Reference matches">
      <div v-for="choice in visible" :key="`${choice.anchor.itemId}:${choice.anchor.fieldId ?? ''}`" role="listitem">
        <button class="button button-small button-quiet reference-result" type="button" :aria-label="choice.title" :disabled="selected.length >= MAX_REFERENCES || isSelected(choice.anchor)" @click="attach(choice)">
          <small>{{ choice.type ?? 'Card' }}</small><span>{{ choice.title }}</span>
        </button>
      </div>
    </div>
    <p v-if="!matches.length" class="section-copy" role="status">No references match this search.</p>
    <p v-if="selected.length >= MAX_REFERENCES" class="section-copy" role="status">8 references attached. Remove one to attach another.</p>
  </details>
</template>
