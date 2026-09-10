<script setup lang="ts">
import { ref } from "vue"
import type { Task } from "../domain/model"

const props = defineProps<{
  task: Task
  candidateParents: { id: string; title: string }[]
}>()

const emit = defineEmits<{
  (e: "close"): void
  (e: "confirm", newParentId: string): void
}>()

const selectedParentId = ref(props.candidateParents[0]?.id ?? "")

function handleConfirm() {
  if (!selectedParentId.value) return
  emit("confirm", selectedParentId.value)
}
</script>

<template>
  <div class="overlay overlay-level-130" role="presentation" @click.self="emit('close')">
    <section class="dialog" role="dialog" aria-modal="true" aria-label="Move task">
      <div class="dialog-head">
        <div>
          <span class="eyebrow">Hierarchy</span>
          <h2>Move task</h2>
        </div>
        <button class="icon-button" type="button" aria-label="Close" @click="emit('close')">×</button>
      </div>

      <div class="dialog-body">
        <p>Moving <strong>{{ task.title }}</strong> to a new parent.</p>
        <label>
          <span>New parent</span>
          <select v-model="selectedParentId">
            <option v-for="p in candidateParents" :key="p.id" :value="p.id">
              {{ p.title }}
            </option>
          </select>
        </label>
      </div>

      <div class="dialog-actions">
        <button class="button button-quiet" type="button" @click="emit('close')">Cancel</button>
        <button class="button button-primary" type="button" @click="handleConfirm">Confirm move</button>
      </div>
    </section>
  </div>
</template>
