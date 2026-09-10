<script setup lang="ts">
import ModalLayer from "./ModalLayer.vue"
import type { Task, FieldDefinition } from "../domain/model"
import type { HistoryEntry } from "../domain/history"

const props = defineProps<{
  task: Task
  subtasks: Task[]
  fields: FieldDefinition[]
  history?: HistoryEntry[]
  archiveError?: string
}>()

const emit = defineEmits<{
  (e: "close"): void
  (e: "addSubtask", parentTaskId: string): void
  (e: "startMove", task: Task): void
  (e: "deleteTask", taskId: string): void
}>()
</script>

<template>
  <ModalLayer class="overlay detail-overlay" @close="emit('close')">
    <section class="dialog detail-dialog" role="dialog" aria-modal="true" aria-label="Task overview" tabindex="-1">
      <div class="detail-head">
        <div>
          <span class="eyebrow">Task</span>
          <h2>{{ task.title }}</h2>
        </div>
        <button class="icon-button" type="button" aria-label="Dismiss" @click="emit('close')">×</button>
      </div>

      <div class="detail-scroll detail-content">
        <div v-if="task.body" class="detail-section">
          <span class="detail-label">Notes</span>
          <p class="detail-copy">{{ task.body }}</p>
        </div>

        <div v-if="fields.length" class="detail-grid">
          <template v-for="field in fields" :key="field.id">
            <div v-if="task.values[field.id] !== undefined && task.values[field.id] !== null && task.values[field.id] !== ''">
              <span class="detail-label">{{ field.title }}</span>
              <strong v-if="field.valueType === 'select'">
                {{ field.options[String(task.values[field.id])]?.title ?? task.values[field.id] }}
              </strong>
              <strong v-else>{{ String(task.values[field.id]) }}</strong>
            </div>
          </template>
        </div>

        <section class="detail-section detail-subsection">
          <div class="section-heading detail-section-head">
            <div>
              <span class="detail-label">Subtasks</span>
              <h3>{{ subtasks.length ? `${subtasks.length} subtasks` : "No subtasks" }}</h3>
            </div>
            <button class="button button-small" type="button" @click="emit('addSubtask', task.id)">+ Add subtask</button>
          </div>

          <div v-if="subtasks.length" class="subtask-list">
            <div
              v-for="sub in subtasks"
              :key="sub.id"
              class="subtask-row"
            >
              <span>{{ sub.title }}</span>
              <button
                class="button button-small button-quiet"
                type="button"
                :aria-label="`Move ${sub.title}`"
                @click="emit('startMove', sub)"
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
          <div v-if="history?.length" class="task-history-list">
            <div
              v-for="entry in history"
              :key="entry.hash"
              class="task-history-entry"
            >
              <div class="task-history-head">
                <strong>{{ entry.action }}</strong>
                <span class="task-history-time">{{ new Date(entry.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}</span>
              </div>
              <div class="task-history-author">
                Author: <span>{{ entry.authorLabel }}</span>
              </div>
            </div>
          </div>
        </section>
      </div>

      <div class="dialog-actions dialog-actions-split">
        <button class="button button-danger" type="button" @click="emit('deleteTask', task.id)">Archive task</button>
        <button class="button button-quiet" type="button" aria-label="Close detail" @click="emit('close')">Close detail</button>
      </div>
      <p v-if="archiveError" class="form-error" role="alert">{{ archiveError }}</p>
    </section>
  </ModalLayer>
</template>
