<script setup lang="ts">
import ModalLayer from "./ModalLayer.vue"
import QuickNoteForm from "./QuickNoteForm.vue"
import type { Item, FieldDefinition } from "../domain/model"
import type { HistoryEntry } from "../domain/history"

defineProps<{
  readOnly?: boolean
  item: Item
  subitems: Item[]
  fields: FieldDefinition[]
  history?: HistoryEntry[]
  archiveError?: string
  restoreSaving?: boolean
  restoreError?: string
  restoreNotice?: string
  quickNote: string
  noteSaving?: boolean
  noteError?: string
}>()

const emit = defineEmits<{
  (e: "close"): void
  (e: "addSubitem", parentItemId: string): void
  (e: "startMove", item: Item): void
  (e: "deleteItem", itemId: string): void
  (e: "restoreVersion", changeHash: string): void
  (e: "update:quickNote", value: string): void
  (e: "saveNote"): void
}>()
</script>

<template>
  <ModalLayer class="overlay detail-overlay" @close="emit('close')">
    <section class="dialog detail-dialog" role="dialog" aria-modal="true" aria-label="Item overview" tabindex="-1">
      <div class="detail-head">
        <div>
          <span class="eyebrow">Item</span>
          <h2>{{ item.title }}</h2>
        </div>
        <button class="icon-button" type="button" aria-label="Dismiss" @click="emit('close')">×</button>
      </div>

      <div class="detail-scroll detail-content">
        <div v-if="item.body" class="detail-section">
          <span class="detail-label">Notes</span>
          <p class="detail-copy">{{ item.body }}</p>
        </div>

        <QuickNoteForm
          :model-value="quickNote"
          :saving="noteSaving"
          :error="noteError"
          :read-only="readOnly"
          @update:model-value="emit('update:quickNote', $event)"
          @save="emit('saveNote')"
        />

        <div v-if="fields.length" class="detail-grid">
          <template v-for="field in fields" :key="field.id">
            <div v-if="item.values[field.id] !== undefined && item.values[field.id] !== null && item.values[field.id] !== ''">
              <span class="detail-label">{{ field.title }}</span>
              <strong v-if="field.valueType === 'select'">
                {{ field.options[String(item.values[field.id])]?.title ?? item.values[field.id] }}
              </strong>
              <strong v-else>{{ String(item.values[field.id]) }}</strong>
            </div>
          </template>
        </div>

        <section class="detail-section detail-subsection">
          <div class="section-heading detail-section-head">
            <div>
              <span class="detail-label">Subitems</span>
              <h3>{{ subitems.length ? `${subitems.length} subitems` : "No subitems" }}</h3>
            </div>
            <button class="button button-small" type="button" :disabled="readOnly" @click="emit('addSubitem', item.id)">+ Add subitem</button>
          </div>

          <div v-if="subitems.length" class="subitem-list">
            <div
              v-for="sub in subitems"
              :key="sub.id"
              class="subitem-row"
            >
              <span>{{ sub.title }}</span>
              <button
                class="button button-small button-quiet"
                type="button"
                :aria-label="`Move ${sub.title}`"
                :disabled="readOnly" @click="emit('startMove', sub)"
              >
                Move
              </button>
            </div>
          </div>
        </section>

        <section class="detail-section detail-subsection">
          <div class="section-heading detail-section-head">
            <span class="detail-label">History</span>
            <h3>{{ history?.length ? `${history.length} changes` : "No recorded history" }}</h3>
          </div>
          <div v-if="history?.length" class="item-history-list">
            <div
              v-for="(entry, index) in history"
              :key="entry.hash"
              class="item-history-entry"
            >
              <div class="item-history-head">
                <strong>{{ entry.action }}</strong>
                <span class="item-history-time">{{ new Date(entry.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}</span>
              </div>
              <div class="item-history-author">
                Author: <span>{{ entry.authorLabel }}</span>
              </div>
              <button v-if="index < history.length - 1" class="button button-small button-quiet" type="button"
                :disabled="readOnly || restoreSaving" @click="emit('restoreVersion', entry.hash)">Restore this version</button>
            </div>
          </div>
          <p v-if="restoreSaving" role="status" class="dialog-copy">Restoring version…</p>
          <p v-else-if="restoreNotice" role="status" class="dialog-copy">{{ restoreNotice }}</p>
          <p v-if="restoreError" role="alert" class="form-error">{{ restoreError }}</p>
        </section>
      </div>

      <div class="dialog-actions dialog-actions-split">
        <button class="button button-danger" type="button" :disabled="readOnly" @click="emit('deleteItem', item.id)">Archive item</button>
        <div class="dialog-action-group">
          <button class="button button-quiet" type="button" aria-label="Close detail" @click="emit('close')">Close detail</button>
        </div>
      </div>
      <p v-if="archiveError" class="form-error" role="alert">{{ archiveError }}</p>
    </section>
  </ModalLayer>
</template>
