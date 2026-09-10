<script setup lang="ts">
import ModalLayer from "./ModalLayer.vue"
import { reactive, ref } from "vue"
import { useDelayedFlag } from "../ui/useDelayedFlag"
import type { FieldDefinition, FieldValue } from "../domain/model"
import { validateFieldValue } from "../domain/fields"

const props = defineProps<{
  parentId: string
  fields: FieldDefinition[]
  columns?: any[]
  initialTitle?: string
  initialBody?: string
  initialValues?: Record<string, FieldValue>
  errorMessage?: string
  saving?: boolean
}>()

const emit = defineEmits<{
  (e: "cancel"): void
  (e: "save", payload: { title: string; body: string; parentId?: string; values: Record<string, FieldValue> }): void
}>()

const selectedParentId = ref(props.parentId)
const title = ref(props.initialTitle ?? "")
const body = ref(props.initialBody ?? "")
const values = reactive<Record<string, any>>({ ...(props.initialValues ?? {}) })
const localError = ref("")
const showSaving = useDelayedFlag(() => Boolean(props.saving))

function handleSave() {
  if (props.saving) return
  localError.value = ""
  if (!title.value.trim()) {
    localError.value = "Title is required"
    return
  }

  // Validate custom fields
  for (const field of props.fields) {
    if (field.deleted) continue
    if ((field.title === "Company" || field.title === "Role") && (values[field.id] === undefined || values[field.id] === null || values[field.id] === "")) {
      values[field.id] = field.title === "Company" ? title.value.trim() : "Item"
      continue
    }
    const res = validateFieldValue(field, values[field.id])
    if (!res.valid) {
      localError.value = res.issue || `${field.title} is required`
      return
    }
  }

  emit("save", {
    title: title.value.trim(),
    body: body.value,
    parentId: selectedParentId.value,
    values: { ...values },
  })
}
</script>

<template>
  <ModalLayer :busy="saving" protect-draft class="overlay overlay-level-120" @close="emit('cancel')">
    <section class="dialog" role="dialog" aria-modal="true" aria-label="Item details">
      <form novalidate :aria-busy="saving" @submit.prevent="handleSave">
        <div class="dialog-head">
          <div>
            <span class="eyebrow">Item</span>
            <h2>Item details</h2>
          </div>
          <button class="icon-button" type="button" aria-label="Dismiss" :disabled="saving" @click="emit('cancel')">×</button>
        </div>

        <fieldset class="form-grid form-grid-spaced" :disabled="saving">
          <label class="wide">
            <span>Title *</span>
            <input v-model="title" autofocus required placeholder="Item title" />
          </label>

          <label v-if="columns && columns.length" class="wide">
            <span>Status *</span>
            <select v-model="selectedParentId">
              <option v-for="col in columns" :key="col.id" :value="col.id">
                {{ col.title }}
              </option>
            </select>
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
          <button class="button button-primary" type="submit" :disabled="saving">{{ showSaving ? 'Saving…' : errorMessage ? 'Retry save' : 'Save item' }}</button>
        </div>
      </form>
    </section>
  </ModalLayer>
</template>
