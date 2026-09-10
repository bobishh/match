<script setup lang="ts">
import ModalLayer from "./ModalLayer.vue"
import { computed, ref } from "vue"
import type { ProjectionIssue, WorkspaceEntity, Column } from "../domain/model"

const props = defineProps<{
  issues: ProjectionIssue[]
  entities: Record<string, WorkspaceEntity>
  columns: Column[]
}>()

const emit = defineEmits<{
  (e: "close"): void
  (e: "place", payload: { entityId: string; columnId: string }): void
}>()

const placingEntityId = ref<string | null>(null)
const targetColumnId = ref<string>(props.columns[0]?.id ?? "")

const displayIssues = computed(() => {
  const seenCycles = new Set<string>()
  const res: ProjectionIssue[] = []
  for (const issue of props.issues) {
    if (issue.type === "cycle") {
      const cycleKey = [...issue.cycleIds].sort().join(",")
      if (seenCycles.has(cycleKey)) continue
      seenCycles.add(cycleKey)
    }
    res.push(issue)
  }
  return res
})

function getTitle(id: string): string {
  return props.entities[id]?.title ?? id
}

function startPlacement(id: string) {
  placingEntityId.value = id
  if (props.columns.length > 0 && !targetColumnId.value) {
    targetColumnId.value = props.columns[0].id
  }
}

function handleConfirmPlacement() {
  if (!placingEntityId.value || !targetColumnId.value) return
  emit("place", { entityId: placingEntityId.value, columnId: targetColumnId.value })
  placingEntityId.value = null
}
</script>

<template>
  <ModalLayer class="overlay" @close="emit('close')">
    <section class="dialog" role="dialog" aria-modal="true" aria-label="Needs placement">
      <div class="dialog-head">
        <div>
          <span class="eyebrow">Integrity Recovery</span>
          <h2>Needs placement</h2>
        </div>
        <button class="icon-button" type="button" aria-label="Dismiss" @click="emit('close')">×</button>
      </div>

      <div class="component-list-scroll">
        <p v-if="!displayIssues.length" class="component-empty">No placement issues found. All items have valid parentage.</p>

        <div
          v-for="issue in displayIssues"
          :key="issue.entityId"
          class="component-row"
        >
          <div>
            <strong>{{ getTitle(issue.entityId) }}</strong>
            <div class="component-warning">
              <span v-if="issue.type === 'cycle'">Cycle detected in ancestry</span>
              <span v-else-if="issue.type === 'missing-parent'">Missing parent</span>
              <span v-else-if="issue.type === 'invalid-parent-kind'">Invalid parent kind</span>
            </div>
          </div>

          <button
            class="button button-small"
            type="button"
            :aria-label="`Place ${getTitle(issue.entityId)}`"
            @click="startPlacement(issue.entityId)"
          >
            Place
          </button>
        </div>
      </div>

      <div class="dialog-actions">
        <button class="button button-quiet" type="button" aria-label="Close recovery" @click="emit('close')">Close recovery</button>
      </div>
    </section>
  </ModalLayer>

  <!-- Placement selector dialog layered on top -->
  <ModalLayer v-if="placingEntityId" class="overlay overlay-level-120" @close="placingEntityId = null">
    <section class="dialog" role="dialog" aria-modal="true" aria-label="Select placement">
      <div class="dialog-head">
        <div>
          <span class="eyebrow">Assign Container</span>
          <h2>Select placement</h2>
        </div>
        <button class="icon-button" type="button" aria-label="Cancel" @click="placingEntityId = null">×</button>
      </div>

      <div class="dialog-body">
        <p>Assigning a valid parent container for <strong>{{ getTitle(placingEntityId) }}</strong>.</p>
        <label>
          <span>Target column</span>
          <select v-model="targetColumnId">
            <option v-for="col in columns" :key="col.id" :value="col.id">
              {{ col.title }}
            </option>
          </select>
        </label>
      </div>

      <div class="dialog-actions">
        <button class="button button-quiet" type="button" @click="placingEntityId = null">Cancel</button>
        <button class="button button-primary" type="button" @click="handleConfirmPlacement">Confirm placement</button>
      </div>
    </section>
  </ModalLayer>
</template>
