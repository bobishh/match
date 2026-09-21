<script setup lang="ts">
import ModalLayer from "../ModalLayer.vue";
import type { SchemaDiff } from "../../domain/schema";

defineProps<{
  diff: SchemaDiff;
}>();

const emit = defineEmits<{
  (event: "close"): void;
  (event: "confirm"): void;
}>();
</script>

<template>
  <ModalLayer
    protect-draft
    class="overlay overlay-level-150"
    @close="emit('close')"
  >
    <section
      class="dialog schema-preview-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Preview schema changes"
    >
      <header class="dialog-head">
        <div>
          <span class="eyebrow">Confirm Schema Update</span>
          <h2>Preview schema changes</h2>
        </div>
        <button
          class="icon-button"
          type="button"
          aria-label="Dismiss"
          @click="emit('close')"
        >
          ×
        </button>
      </header>

      <div class="preview-body">
        <section v-if="diff.columnsRenamed.length">
          <h4>Renamed Columns</h4>
          <ul>
            <li v-for="column in diff.columnsRenamed" :key="column.id">
              Rename column: "{{ column.oldTitle }}" → "{{ column.newTitle }}"
            </li>
          </ul>
        </section>
        <section v-if="diff.columnsAdded.length">
          <h4>New Columns</h4>
          <ul>
            <li v-for="(column, index) in diff.columnsAdded" :key="index">
              Add column: "{{ column.title }}"
            </li>
          </ul>
        </section>
        <section v-if="diff.columnsSoftDeleted.length">
          <h4 class="preview-danger">Soft-Deleted Columns</h4>
          <ul>
            <li v-for="column in diff.columnsSoftDeleted" :key="column.id">
              Soft delete: Column "{{ column.title }}" ({{
                column.retainedItemCount
              }}
              card{{ column.retainedItemCount === 1 ? "" : "s" }} will be
              retained in trash)
            </li>
          </ul>
        </section>
        <section v-if="diff.fieldsAdded.length">
          <h4>New Fields</h4>
          <ul>
            <li v-for="(field, index) in diff.fieldsAdded" :key="index">
              Add field: "{{ field.title }}" ({{ field.valueType }})
            </li>
          </ul>
        </section>
        <section v-if="diff.fieldsModified.length">
          <h4>Modified Fields</h4>
          <ul>
            <li v-for="field in diff.fieldsModified" :key="field.id">
              Field "{{ field.title }}": {{ field.changes.join(", ") }}
            </li>
          </ul>
        </section>
        <section v-if="diff.fieldsSoftDeleted.length">
          <h4 class="preview-danger">Soft-Deleted Fields</h4>
          <ul>
            <li v-for="field in diff.fieldsSoftDeleted" :key="field.id">
              Soft delete: Field "{{ field.title }}" (values will be retained)
            </li>
          </ul>
        </section>
        <p
          v-if="
            !diff.columnsRenamed.length &&
            !diff.columnsAdded.length &&
            !diff.columnsSoftDeleted.length &&
            !diff.fieldsAdded.length &&
            !diff.fieldsModified.length &&
            !diff.fieldsSoftDeleted.length
          "
        >
          No structural differences detected.
        </p>
      </div>

      <div class="dialog-actions">
        <button
          class="button button-quiet"
          type="button"
          @click="emit('close')"
        >
          Back to editing
        </button>
        <button
          class="button button-primary"
          type="button"
          @click="emit('confirm')"
        >
          Confirm apply
        </button>
      </div>
    </section>
  </ModalLayer>
</template>
