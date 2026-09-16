<script setup lang="ts">
import ModalLayer from "./ModalLayer.vue"
import { reactive, ref } from "vue"
import { useDelayedFlag } from "../ui/useDelayedFlag"
import type { FieldDefinition, FieldValue, Item } from "../domain/model"
import { validateFieldValue } from "../domain/fields"

const props = defineProps<{
  parentId: string
  fields: FieldDefinition[]
  columns?: any[]
  item?: Item | null
  showCoreFields?: boolean
  hiddenFieldIds?: string[]
  computedFieldsMessage?: string
  optionValues?: Record<string, string>
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
const title = ref(props.item?.title ?? props.initialTitle ?? "")
const body = ref(props.item?.body ?? props.initialBody ?? "")
const values = reactive<Record<string, any>>({ ...(props.initialValues ?? props.item?.values ?? {}) })
for (const field of props.fields) {
  if (field.valueType === "select" && typeof values[field.id] === "string") {
    values[field.id] = props.optionValues?.[values[field.id]] ?? values[field.id]
  }
}
const localError = ref("")
const showSaving = useDelayedFlag(() => Boolean(props.saving))

function handleSave() {
  if (props.saving) return
  localError.value = ""
  if (props.showCoreFields !== false && !title.value.trim()) {
    localError.value = "Title is required"
    return
  }

  // Validate custom fields
  for (const field of props.fields) {
    if (field.deleted || props.hiddenFieldIds?.includes(field.id)) continue
    const selected = field.valueType === "select"
      ? Object.values(field.options).find(option => props.optionValues?.[option.id] === values[field.id])
      : undefined
    const res = validateFieldValue(field, selected?.id ?? values[field.id])
    if (!res.valid) {
      localError.value = res.issue || `${field.title} is required`
      return
    }
  }

  const savedValues: Record<string, FieldValue> = { ...(props.item?.values ?? {}), ...values }
  for (const field of props.fields) {
    if (field.valueType !== "select") continue
    const selected = Object.values(field.options).find(option => props.optionValues?.[option.id] === savedValues[field.id])
    if (selected) savedValues[field.id] = selected.id
  }

  emit("save", {
    title: title.value.trim(),
    body: body.value,
    parentId: selectedParentId.value,
    values: savedValues,
  })
}
</script>

<template>
  <ModalLayer :busy="saving" protect-draft class="overlay overlay-level-120" @close="emit('cancel')">
    <section class="dialog" role="dialog" aria-modal="true" :aria-label="item ? 'Edit item' : showCoreFields !== false ? 'Item details' : 'Add item'">
      <form novalidate :aria-busy="saving" @submit.prevent="handleSave">
        <div class="dialog-head">
          <div>
            <span class="eyebrow">{{ item ? 'Edit item' : 'New item' }}</span>
            <h2>{{ item ? 'Edit item' : showCoreFields !== false ? 'Item details' : 'Add item' }}</h2>
          </div>
          <button class="icon-button" type="button" aria-label="Dismiss" :disabled="saving" @click="emit('cancel')">×</button>
        </div>

        <fieldset class="form-grid form-grid-spaced" :disabled="saving">
          <label v-if="showCoreFields !== false" class="wide">
            <span>Title *</span>
            <input v-model="title" autofocus required placeholder="Item title" />
          </label>

          <label v-if="columns && columns.length" class="wide">
            <span>Status *</span>
            <select v-model="selectedParentId">
              <option v-for="col in columns" :key="col.id" :value="col.formValue ?? col.id">
                {{ col.title }}
              </option>
            </select>
          </label>

          <label class="wide">
            <span>{{ showCoreFields !== false ? 'Body' : 'Description' }}</span>
            <textarea v-model="body" rows="3" placeholder="Description or notes..."></textarea>
          </label>

          <p v-if="computedFieldsMessage" class="wide computed-priority-note">{{ computedFieldsMessage }}</p>

          <template v-for="field in fields" :key="field.id">
            <label v-if="!field.deleted && !hiddenFieldIds?.includes(field.id)">
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
                  :value="optionValues?.[opt.id] ?? opt.id"
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
          <button class="button button-primary" type="submit" :disabled="saving">{{ showSaving ? 'Saving…' : errorMessage ? 'Retry save' : item ? 'Save changes' : showCoreFields !== false ? 'Save item' : 'Create item' }}</button>
        </div>
      </form>
    </section>
  </ModalLayer>
</template>
