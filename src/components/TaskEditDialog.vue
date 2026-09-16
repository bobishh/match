<script setup lang="ts">
import ModalLayer from "./ModalLayer.vue"
import { reactive, ref } from "vue"
import { useDelayedFlag } from "../ui/useDelayedFlag"
import type { FieldDefinition, FieldValue, Task } from "../domain/model"
import { validateFieldValue } from "../domain/fields"

const props = defineProps<{
  task: Task
  fields: FieldDefinition[]
  errorMessage?: string
  saving?: boolean
}>()

const emit = defineEmits<{
  (e: "cancel"): void
  (e: "save", payload: { title: string; body: string; values: Record<string, FieldValue> }): void
}>()

const title = ref(props.task.title)
const body = ref(props.task.body ?? "")
// Initialise local values from task.values, preserving ALL existing keys
const values = reactive<Record<string, any>>({ ...props.task.values })
const localError = ref("")
const showSaving = useDelayedFlag(() => Boolean(props.saving))

function handleSave() {
  if (props.saving) return
  localError.value = ""
  if (!title.value.trim()) {
    localError.value = "Title is required"
    return
  }

  // Validate only the schema-defined fields visible in the form
  for (const field of props.fields) {
    if (field.deleted) continue
    const res = validateFieldValue(field, values[field.id])
    if (!res.valid) {
      localError.value = res.issue || `${field.title} is required`
      return
    }
  }

  // Merge: start from existing task values to preserve unknown/unrendered fields,
  // then overlay with the edited values so nothing is dropped on save.
  const mergedValues: Record<string, FieldValue> = {
    ...props.task.values,
    ...values,
  }

  emit("save", {
    title: title.value.trim(),
    body: body.value,
    values: mergedValues,
  })
}
</script>

<template>
  <ModalLayer :busy="saving" protect-draft class="overlay overlay-level-120" @close="emit('cancel')">
    <section class="dialog" role="dialog" aria-modal="true" aria-label="Edit item">
      <form novalidate :aria-busy="saving" @submit.prevent="handleSave">
        <div class="dialog-head">
          <div>
            <span class="eyebrow">Item</span>
            <h2>Edit item</h2>
          </div>
          <button class="icon-button" type="button" aria-label="Dismiss" :disabled="saving" @click="emit('cancel')">×</button>
        </div>

        <fieldset class="form-grid form-grid-spaced" :disabled="saving">
          <label class="wide">
            <span>Title *</span>
            <input v-model="title" autofocus required placeholder="Item title" />
          </label>

          <label class="wide">
            <span>Body</span>
            <textarea v-model="body" rows="3" placeholder="Description or notes..."></textarea>
          </label>

          <template v-for="field in fields" :key="field.id">
            <label v-if="!field.deleted">
              <span>{{ field.title }}{{ field.required ? " *" : "" }}</span>
              <input
                v-if="field.valueType === 'text' || field.valueType === 'url'"
                v-model="values[field.id]"
                :type="field.valueType === 'url' ? 'url' : 'text'"
                :required="field.required"
              />
              <input
                v-else-if="field.valueType === 'number'"
                v-model.number="values[field.id]"
                type="number"
                :required="field.required"
                :min="field.min ?? undefined"
                :max="field.max ?? undefined"
              />
              <input
                v-else-if="field.valueType === 'date'"
                v-model="values[field.id]"
                type="date"
                :required="field.required"
              />
              <input
                v-else-if="field.valueType === 'datetime'"
                v-model="values[field.id]"
                type="datetime-local"
                :required="field.required"
              />
              <input
                v-else-if="field.valueType === 'boolean'"
                v-model="values[field.id]"
                type="checkbox"
              />
              <select
                v-else-if="field.valueType === 'select'"
                v-model="values[field.id]"
                :required="field.required"
              >
                <option value="">Select option</option>
                <option
                  v-for="opt in Object.values(field.options || {}).filter(o => !o.deleted)"
                  :key="opt.id"
                  :value="opt.id"
                >
                  {{ opt.title }}
                </option>
              </select>
            </label>
          </template>
        </fieldset>

        <p v-if="localError || errorMessage" role="alert" class="form-error form-error-spaced">
          {{ localError || errorMessage }}
        </p>

        <div class="dialog-actions">
          <button class="button button-quiet" type="button" :disabled="saving" @click="emit('cancel')">Cancel</button>
          <button class="button button-primary" type="submit" :disabled="saving">{{ showSaving ? 'Saving…' : errorMessage ? 'Retry save' : 'Save changes' }}</button>
        </div>
      </form>
    </section>
  </ModalLayer>
</template>
