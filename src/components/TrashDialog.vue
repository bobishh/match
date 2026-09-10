<script setup lang="ts">
import type { WorkspaceEntity } from "../domain/model"

const props = defineProps<{
  items: WorkspaceEntity[]
  allEntities: Record<string, WorkspaceEntity>
}>()

const emit = defineEmits<{
  (e: "close"): void
  (e: "restore", entityId: string): void
}>()

function isParentDeleted(item: WorkspaceEntity): boolean {
  if (!item.placement.parentId) return false
  const parent = props.allEntities[item.placement.parentId]
  return Boolean(parent?.deleted)
}
</script>

<template>
  <div class="overlay" role="presentation" @click.self="emit('close')">
    <section class="dialog" role="dialog" aria-modal="true" aria-label="Trash">
      <div class="dialog-head">
        <div>
          <span class="eyebrow">Recovery</span>
          <h2>Trash</h2>
        </div>
        <button class="icon-button" type="button" aria-label="Dismiss" @click="emit('close')">×</button>
      </div>

      <div class="component-list-scroll">
        <p v-if="!items.length" class="component-empty">Trash is empty.</p>

        <div
          v-for="item in items"
          :key="item.id"
          class="component-stack component-row"
        >
          <div class="dialog-actions dialog-actions-split">
            <div>
              <span v-if="item.kind === 'column'"><strong>{{ item.title }} (Column)</strong></span>
              <span v-else><strong>{{ item.title }}</strong></span>
            </div>
            <button
              class="button button-small"
              type="button"
              :aria-label="`Restore ${item.title}`"
              @click="emit('restore', item.id)"
            >
              Restore
            </button>
          </div>
          <small v-if="isParentDeleted(item)" class="component-warning">
            Parent container is also in Trash. Restoring this item without its parent will leave it needing placement.
          </small>
        </div>
      </div>

      <div class="dialog-actions">
        <button class="button button-quiet" type="button" aria-label="Close trash" @click="emit('close')">Close trash</button>
      </div>
    </section>
  </div>
</template>
