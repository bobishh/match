<script setup lang="ts">
import ModalLayer from "./ModalLayer.vue"
import { ref } from "vue"

const props = defineProps<{
  columnId: string
  initialTitle: string
}>()

const emit = defineEmits<{
  (e: "close"): void
  (e: "save", title: string): void
  (e: "delete"): void
}>()

const title = ref(props.initialTitle)

function handleSave() {
  if (!title.value.trim()) return
  emit("save", title.value.trim())
}
</script>

<template>
  <ModalLayer protect-draft class="overlay" @close="emit('close')">
    <section class="dialog" role="dialog" aria-modal="true" aria-label="Edit column">
      <form novalidate @submit.prevent="handleSave">
        <div class="dialog-head">
          <div>
            <span class="eyebrow">Column settings</span>
            <h2>Edit column</h2>
          </div>
          <button class="icon-button" type="button" aria-label="Close" @click="emit('close')">×</button>
        </div>

        <div class="dialog-body">
          <label>
            <span>Column title</span>
            <input v-model="title" autofocus required />
          </label>

        </div>

        <div class="dialog-actions dialog-actions-split">
          <button class="button button-danger" type="button" @click="emit('delete')">Delete column</button>
          <div class="dialog-action-group">
            <button class="button button-quiet" type="button" @click="emit('close')">Cancel</button>
            <button class="button button-primary" type="submit">Save</button>
          </div>
        </div>
      </form>
    </section>
  </ModalLayer>
</template>
