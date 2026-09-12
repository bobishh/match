<script setup lang="ts">
import ModalLayer from "./ModalLayer.vue"
import { computed, ref } from "vue"
import type { Board, Column, FieldDefinition, WorkspaceDocumentV2, Heads } from "../domain/model"
import type { Template } from "../types"
import {
  projectBoardSchema,
  validateBoardSchemaDraft,
  diffBoardSchema,
  type BoardSchemaDraft,
  type SchemaValidationError,
  type SchemaDiff,
} from "../domain/schema"
import {
  projectWorkspaceSettings,
  validateWorkspaceSettingsDraft,
  type WorkspaceSettingsDraft,
} from "../domain/workspaceSettings"
import { compareRanks } from "../domain/ancestry"
import { createDefaultPriorityPolicy } from "../domain/priority"

const props = defineProps<{
  readOnly?: boolean
  doc: WorkspaceDocumentV2
  board: Board
  columns: Column[]
  fields: FieldDefinition[]
  templates: Template[]
  heads?: Heads
  mode: "entity" | "templates"
}>()

const emit = defineEmits<{
  (e: "close"): void
  (e: "apply", payload: { schema: BoardSchemaDraft; expectedHeads?: Heads }): void
  (e: "saveTemplate", payload: { id?: string; name: string; markdown: string }): void
  (e: "applyWorkspaceSettings", payload: { settings: WorkspaceSettingsDraft; expectedHeads?: Heads }): void
}>()

const activeTab = ref<"templates" | "priority" | "json" | "profile">("templates")
const draft = ref<BoardSchemaDraft>(projectBoardSchema(props.doc, props.board.id))
const editorEntityName = computed(() => draft.value.entityName || props.board.entityName || "item")
const jsonText = ref<string>(JSON.stringify(draft.value, null, 2))
const validationErrors = ref<SchemaValidationError[]>([])
const showPreview = ref(false)
const schemaDiff = ref<SchemaDiff | null>(null)
const conflictNotice = ref("")
const workspaceSettings = ref<WorkspaceSettingsDraft>(projectWorkspaceSettings(props.doc, props.board.id))
const workspaceJson = ref(JSON.stringify(workspaceSettings.value, null, 2))
const workspaceErrors = ref<SchemaValidationError[]>([])
const priorityErrors = ref<string[]>([])
const supportsAutomaticPriority = computed(() => Boolean(
  props.board.preset?.bindings["field.priority"] && props.board.preset?.bindings["field.fitScore"]
))
const priorityPolicy = computed(() => workspaceSettings.value.board.priorityPolicy ?? null)
const criterionFields = computed(() => props.fields.filter(field =>
  !field.deleted && field.id !== priorityPolicy.value?.priorityFieldId && field.id !== priorityPolicy.value?.fitFieldId
))
const priorityOptions = computed(() => {
  const field = props.fields.find(item => item.id === priorityPolicy.value?.priorityFieldId)
  if (!field || field.valueType !== "select") return []
  return Object.values(field.options).filter(option => !option.deleted).sort((a, b) => compareRanks(a.rank, b.rank))
})

// Tree view add field form state
const showAddField = ref(false)
const newFieldTitle = ref("")
const newFieldValueType = ref<"text" | "number" | "boolean" | "select" | "url" | "date" | "datetime">("text")
const newFieldRequired = ref(false)
const newFieldOptions = ref("")

// New column title state
const newColumnTitle = ref("")
const editingTemplateId = ref<string | null>(null)
const templateDraft = ref({ name: "", markdown: "" })

function startTemplate() {
  editingTemplateId.value = null
  templateDraft.value = { name: "", markdown: "" }
}

function editTemplate(template: Template) {
  editingTemplateId.value = template.id
  templateDraft.value = { name: template.name, markdown: template.markdown }
}

function saveTemplate() {
  if (!templateDraft.value.name.trim() || !templateDraft.value.markdown.trim()) return
  emit("saveTemplate", {
    ...(editingTemplateId.value ? { id: editingTemplateId.value } : {}),
    name: templateDraft.value.name.trim(),
    markdown: templateDraft.value.markdown.trim(),
  })
}

function syncToJson() {
  jsonText.value = JSON.stringify(draft.value, null, 2)
  validateCurrent()
}

function syncFromJson() {
  try {
    const parsed = JSON.parse(jsonText.value)
    draft.value = parsed
    validateCurrent()
  } catch (err: any) {
    validationErrors.value = [
      { path: "", message: `Invalid JSON syntax: ${err.message}` },
    ]
  }
}

function validateCurrent() {
  const result = validateBoardSchemaDraft(draft.value)
  validationErrors.value = result.errors
}

function handleWorkspaceJsonInput(e: Event) {
  workspaceJson.value = (e.target as HTMLTextAreaElement).value
  try {
    const parsed = JSON.parse(workspaceJson.value)
    workspaceSettings.value = parsed
    workspaceErrors.value = validateWorkspaceSettingsDraft(parsed, props.doc).errors
  } catch (err: any) {
    workspaceErrors.value = [
      { path: "", message: `Invalid JSON syntax: ${err.message}` },
    ]
  }
}

function applyWorkspaceJson() {
  handleWorkspaceJsonInput({ target: { value: workspaceJson.value } } as unknown as Event)
  if (workspaceErrors.value.length) return
  emit("applyWorkspaceSettings", { settings: workspaceSettings.value, expectedHeads: props.heads })
}

function fieldForRule(fieldId: string) {
  return props.fields.find(field => field.id === fieldId)
}

function optionsForRule(fieldId: string) {
  const field = fieldForRule(fieldId)
  if (!field || field.valueType !== "select") return []
  return Object.values(field.options).filter(option => !option.deleted).sort((a, b) => compareRanks(a.rank, b.rank))
}

function operatorsFor(fieldId: string) {
  const field = fieldForRule(fieldId)
  if (field?.valueType === "number") return [
    { value: "equals", label: "equals" },
    { value: "at_least", label: "at least" },
    { value: "at_most", label: "at most" },
    { value: "is_set", label: "is set" },
  ]
  if (field && ["text", "url"].includes(field.valueType)) return [
    { value: "contains", label: "contains" },
    { value: "equals", label: "equals" },
    { value: "is_set", label: "is set" },
  ]
  return [{ value: "equals", label: "equals" }, { value: "is_set", label: "is set" }]
}

function defaultRuleValue(field: FieldDefinition) {
  if (field.valueType === "select") return Object.values(field.options).find(option => !option.deleted)?.id ?? ""
  if (field.valueType === "boolean") return true
  if (field.valueType === "number") return field.min ?? 0
  return ""
}

function resetRule(index: number) {
  const policy = priorityPolicy.value
  if (!policy) return
  const rule = policy.rules[index]
  const field = fieldForRule(rule.fieldId)
  if (!field) return
  rule.operator = field.valueType === "number" || field.valueType === "select" || field.valueType === "boolean" ? "equals" : "contains"
  rule.value = defaultRuleValue(field)
}

function enableAutomaticPriority() {
  workspaceSettings.value.board.priorityPolicy = createDefaultPriorityPolicy(props.board, props.fields)
  priorityErrors.value = workspaceSettings.value.board.priorityPolicy ? [] : ["Priority and fit fields are unavailable"]
}

function addPriorityRule() {
  const policy = priorityPolicy.value
  const field = criterionFields.value[0]
  if (!policy || !field) return
  policy.rules.push({
    id: crypto.randomUUID(),
    fieldId: field.id,
    operator: field.valueType === "number" || field.valueType === "select" || field.valueType === "boolean" ? "equals" : "contains",
    value: defaultRuleValue(field),
    weight: 1,
  })
}

function removePriorityRule(index: number) {
  priorityPolicy.value?.rules.splice(index, 1)
}

function savePriorityRules() {
  priorityErrors.value = []
  if (priorityPolicy.value && !priorityPolicy.value.rules.length) {
    priorityErrors.value = ["Add at least one priority rule"]
    return
  }
  const errors = validateWorkspaceSettingsDraft(workspaceSettings.value, props.doc).errors
    .filter(error => error.path.startsWith("/board/priorityPolicy"))
  if (errors.length) {
    priorityErrors.value = errors.map(error => error.message)
    return
  }
  emit("applyWorkspaceSettings", { settings: workspaceSettings.value, expectedHeads: props.heads })
}

// Tree view column operations
function moveColumn(idx: number, direction: "up" | "down") {
  const targetIdx = direction === "up" ? idx - 1 : idx + 1
  if (targetIdx < 0 || targetIdx >= draft.value.columns.length) return
  const item = draft.value.columns.splice(idx, 1)[0]
  draft.value.columns.splice(targetIdx, 0, item)
  syncToJson()
}

function removeColumn(idx: number) {
  draft.value.columns.splice(idx, 1)
  syncToJson()
}

function addColumn() {
  if (!newColumnTitle.value.trim()) return
  draft.value.columns.push({
    title: newColumnTitle.value.trim(),
  })
  newColumnTitle.value = ""
  syncToJson()
}

// Tree view field operations
function removeField(idx: number) {
  draft.value.fields.splice(idx, 1)
  syncToJson()
}

function addField() {
  if (!newFieldTitle.value.trim()) return
  const title = newFieldTitle.value.trim()
  const valueType = newFieldValueType.value
  const required = newFieldRequired.value

  let optionsArray: Array<{ id: string; title: string }> | undefined

  if (valueType === "select") {
    const raw = newFieldOptions.value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    optionsArray = []
    for (const optTitle of raw) {
      const optId = `opt_${crypto.randomUUID().slice(0, 8)}`
      optionsArray.push({ id: optId, title: optTitle })
    }
  }

  draft.value.fields.push({
    id: `fld_${crypto.randomUUID().slice(0, 8)}`,
    title,
    valueType,
    required,
    options: optionsArray,
  })

  newFieldTitle.value = ""
  newFieldValueType.value = "text"
  newFieldRequired.value = false
  newFieldOptions.value = ""
  showAddField.value = false
  syncToJson()
}

function handleReviewChanges() {
  if (activeTab.value === "json") {
    syncFromJson()
  }
  validateCurrent()
  if (validationErrors.value.length > 0) return

  schemaDiff.value = diffBoardSchema(props.doc, props.board.id, draft.value)
  showPreview.value = true
}

function handleConfirmApply() {
  emit("apply", {
    schema: draft.value,
    expectedHeads: props.heads,
  })
  showPreview.value = false
}
</script>

<template>
  <ModalLayer protect-draft class="overlay overlay-level-100" @close="emit('close')">
    <section class="dialog schema-editor-dialog" :class="{ 'schema-entity-dialog': mode === 'entity' }" role="dialog" aria-modal="true" :aria-label="mode === 'entity' ? `Edit ${editorEntityName}` : 'Workspace settings'">
      <div class="dialog-head">
        <div>
          <span class="eyebrow">{{ mode === "entity" ? "Entity schema" : "Workspace settings" }}</span>
          <h2>{{ mode === "entity" ? `Edit ${editorEntityName}` : "Workspace settings" }}</h2>
        </div>
        <button class="icon-button" type="button" aria-label="Dismiss" @click="emit('close')">×</button>
      </div>

      <!-- Validation Error Banner -->
      <div v-if="validationErrors.length" class="schema-error-banner" role="alert">
        <strong>Validation errors:</strong>
        <ul>
          <li v-for="(err, i) in validationErrors" :key="i">
            <code v-if="err.path">{{ err.path }}</code>: {{ err.message }}
          </li>
        </ul>
      </div>

      <div v-if="conflictNotice" class="schema-error-banner" role="alert">
        {{ conflictNotice }}
      </div>

      <!-- Tab 1: Visual Structural Tree View -->
      <div v-if="mode === 'entity'" class="schema-tab-content">
        <!-- Board Section -->
        <div class="schema-section">
          <label class="schema-field-label">
            <span>Entity name</span>
            <input v-model="draft.entityName" class="schema-input" placeholder="Item" @input="syncToJson" />
          </label>
        </div>

        <!-- Custom Fields Section -->
        <div class="schema-section">
          <div class="schema-section-head">
            <h3>Custom Fields</h3>
            <button
              v-if="!showAddField"
              class="button button-small"
              type="button"
              @click="showAddField = true"
            >
              + Add field
            </button>
          </div>

          <div v-if="showAddField" class="schema-add-field-form">
            <label>
              <span>Field name</span>
              <input v-model="newFieldTitle" class="schema-input" placeholder="e.g. Severity" />
            </label>
            <label>
              <span>Type</span>
              <select v-model="newFieldValueType" class="schema-select">
                <option value="text">text</option>
                <option value="number">number</option>
                <option value="boolean">boolean</option>
                <option value="select">select</option>
                <option value="url">url</option>
                <option value="date">date</option>
                <option value="datetime">datetime</option>
              </select>
            </label>
            <label v-if="newFieldValueType === 'select'">
              <span>Options (comma-separated)</span>
              <input v-model="newFieldOptions" class="schema-input" placeholder="e.g. Low, Medium, High" />
            </label>
            <label class="schema-checkbox-label">
              <input v-model="newFieldRequired" type="checkbox" />
              <span>Required</span>
            </label>
            <div class="schema-add-field-actions">
              <button class="button button-quiet" type="button" @click="showAddField = false">Cancel</button>
              <button class="button button-primary" type="button" @click="addField">Save field</button>
            </div>
          </div>

          <div class="schema-fields-list">
            <div
              v-for="(fld, idx) in draft.fields"
              :key="fld.id || idx"
              class="schema-field-item"
            >
              <div class="schema-field-item-head">
                <span class="field-item-header">
                  <strong>{{ fld.title }}</strong>
                  <span class="field-type">{{ fld.valueType }}</span>
                  <span v-if="fld.required" class="required-badge">Required</span>
                </span>
                <button
                  class="button button-small button-danger"
                  type="button"
                  :aria-label="`Remove ${fld.title} field`"
                  @click="removeField(idx)"
                >
                  Remove
                </button>
              </div>

              <!-- Select options view / edit in tree -->
              <div v-if="fld.valueType === 'select'" class="schema-options-box">
                <div class="options-pills">
                  <span v-for="opt in fld.options || []" :key="opt.id || opt.title" class="option-pill">
                    {{ opt.title }}
                  </span>
                  <span v-if="!(fld.options && fld.options.length)" class="no-options">No options yet</span>
                </div>
              </div>
            </div>
            <p v-if="!draft.fields.length && !showAddField" class="schema-empty-state">
              No custom fields defined on this board.
            </p>
          </div>
        </div>
      </div>

      <template v-else>
        <div class="schema-tabs" role="tablist" aria-label="Workspace settings views">
          <button v-if="$slots.profile" class="schema-tab-btn" :class="{ active: activeTab === 'profile' }" type="button" role="tab" :aria-selected="activeTab === 'profile'" @click="activeTab = 'profile'">Your profile</button>
          <button v-if="supportsAutomaticPriority" class="schema-tab-btn" :class="{ active: activeTab === 'priority' }" type="button" role="tab" :aria-selected="activeTab === 'priority'" @click="activeTab = 'priority'">Priority rules</button>
          <button class="schema-tab-btn" :class="{ active: activeTab === 'templates' }" type="button" role="tab" :aria-selected="activeTab === 'templates'" @click="activeTab = 'templates'">Document templates</button>
          <button class="schema-tab-btn" :class="{ active: activeTab === 'json' }" type="button" role="tab" :aria-selected="activeTab === 'json'" @click="activeTab = 'json'">JSON</button>
        </div>

        <div v-if="activeTab === 'templates'" class="schema-tab-content">
          <fieldset :disabled="readOnly" class="templates-layout">
          <aside class="template-list" aria-label="Saved templates">
            <button class="button button-small" type="button" @click="startTemplate">+ Template</button>
            <button v-for="template in templates" :key="template.id" class="template-item" :class="{ active: editingTemplateId === template.id }" type="button" @click="editTemplate(template)"><strong>{{ template.name }}</strong></button>
            <p v-if="!templates.length" class="empty-template-list">No templates yet.</p>
          </aside>
          <form class="template-editor" novalidate @submit.prevent="saveTemplate">
            <label><span>Name</span><input v-model="templateDraft.name" required placeholder="General software CV" /></label>
            <label><span>Markdown</span><textarea v-model="templateDraft.markdown" rows="16" required placeholder="# Your name"></textarea></label>
            <div class="dialog-actions"><button class="button button-primary" type="submit">Save template</button></div>
          </form>
          </fieldset>
        </div>

        <div v-else-if="activeTab === 'profile'" class="schema-tab-content"><slot name="profile" /></div>
        <div v-else-if="activeTab === 'priority'" class="schema-tab-content priority-settings">
          <div v-if="priorityErrors.length" class="schema-error-banner" role="alert">{{ priorityErrors[0] }}</div>
          <template v-if="priorityPolicy">
            <div class="priority-settings-head">
              <div>
                <h3>Automatic priority</h3>
                <p>Matching rules add points. Fit is clamped to 0–10; priority follows the thresholds.</p>
              </div>
              <button class="button button-danger" type="button" :disabled="readOnly" @click="workspaceSettings.board.priorityPolicy = null">Disable automatic priority</button>
            </div>

            <fieldset :disabled="readOnly" class="priority-rules" aria-label="Weighted criteria">
              <div v-for="(rule, index) in priorityPolicy.rules" :key="rule.id" class="priority-rule-row">
                <label>
                  <span>Criterion</span>
                  <select v-model="rule.fieldId" :aria-label="`Criterion field ${index + 1}`" @change="resetRule(index)">
                    <option v-for="field in criterionFields" :key="field.id" :value="field.id">{{ field.title }}</option>
                  </select>
                </label>
                <label>
                  <span>Match</span>
                  <select v-model="rule.operator" :aria-label="`Rule operator ${index + 1}`">
                    <option v-for="operator in operatorsFor(rule.fieldId)" :key="operator.value" :value="operator.value">{{ operator.label }}</option>
                  </select>
                </label>
                <label v-if="rule.operator !== 'is_set'">
                  <span>Value</span>
                  <select v-if="fieldForRule(rule.fieldId)?.valueType === 'select'" v-model="rule.value" :aria-label="`Preferred value ${index + 1}`">
                    <option v-for="option in optionsForRule(rule.fieldId)" :key="option.id" :value="option.id">{{ option.title }}</option>
                  </select>
                  <select v-else-if="fieldForRule(rule.fieldId)?.valueType === 'boolean'" v-model="rule.value" :aria-label="`Preferred value ${index + 1}`">
                    <option :value="true">Yes</option><option :value="false">No</option>
                  </select>
                  <input v-else-if="fieldForRule(rule.fieldId)?.valueType === 'number'" v-model.number="rule.value" type="number" :aria-label="`Preferred value ${index + 1}`" />
                  <input v-else v-model="rule.value" :aria-label="`Preferred value ${index + 1}`" />
                </label>
                <label>
                  <span>Points</span>
                  <input v-model.number="rule.weight" type="number" min="-10" max="10" :aria-label="`Points ${index + 1}`" />
                </label>
                <button class="button button-small button-danger priority-rule-remove" type="button" :aria-label="`Remove ${fieldForRule(rule.fieldId)?.title ?? 'criterion'} rule`" @click="removePriorityRule(index)">Remove</button>
              </div>
              <button class="button button-small" type="button" :disabled="!criterionFields.length" @click="addPriorityRule">+ Add criterion</button>
            </fieldset>

            <fieldset :disabled="readOnly" class="priority-thresholds" aria-label="Priority thresholds">
              <legend>Priority thresholds</legend>
              <label v-for="band in priorityPolicy.bands" :key="band.optionId">
                <span>{{ priorityOptions.find(option => option.id === band.optionId)?.title ?? 'Priority' }} minimum</span>
                <input v-model.number="band.minScore" type="number" min="0" max="10" />
              </label>
            </fieldset>
          </template>
          <div v-else class="priority-empty">
            <h3>Manual priority</h3>
            <p>Enable rules to calculate fit and priority from card fields. Add fields such as Culture or Reputation in Edit board, then score their values here.</p>
            <button class="button button-primary" type="button" :disabled="readOnly" @click="enableAutomaticPriority">Enable automatic priority</button>
          </div>
          <div class="dialog-actions"><button class="button button-primary" type="button" :disabled="readOnly" @click="savePriorityRules">Save priority rules</button></div>
        </div>
        <div v-else class="schema-tab-content workspace-json-editor">
          <p>Advanced workspace configuration. One apply updates workspace title, board, columns, fields, and document templates.</p>
          <div v-if="workspaceErrors.length" class="schema-error-banner" role="alert">
            <strong>Validation errors:</strong>
            <ul><li v-for="(error, index) in workspaceErrors" :key="index"><code v-if="error.path">{{ error.path }}</code>: {{ error.message }}</li></ul>
          </div>
          <label class="workspace-json-label">
            <span>Workspace settings JSON</span>
            <textarea :readonly="readOnly" :value="workspaceJson" class="schema-json-textarea" rows="22" aria-label="Workspace settings JSON" spellcheck="false" @input="handleWorkspaceJsonInput"></textarea>
          </label>
          <div class="dialog-actions"><button class="button button-primary" type="button" :disabled="readOnly || workspaceErrors.length > 0" @click="applyWorkspaceJson">Apply JSON</button></div>
        </div>
      </template>

      <!-- Dialog Footer Actions -->
      <div v-if="mode === 'entity'" class="dialog-actions schema-dialog-actions">
        <button class="button button-quiet" type="button" @click="emit('close')">Cancel</button>
        <button
          class="button button-primary"
          type="button"
          :disabled="validationErrors.length > 0"
          @click="handleReviewChanges"
        >
          Review changes
        </button>
      </div>

      <!-- Preview Modal Before Apply -->
      <ModalLayer protect-draft v-if="showPreview && schemaDiff" class="overlay overlay-level-150" @close="showPreview = false">
        <section class="dialog schema-preview-dialog" role="dialog" aria-modal="true" aria-label="Preview schema changes">
          <div class="dialog-head">
            <div>
              <span class="eyebrow">Confirm Schema Update</span>
              <h2>Preview schema changes</h2>
            </div>
            <button class="icon-button" type="button" aria-label="Dismiss" @click="showPreview = false">×</button>
          </div>

          <div class="preview-body">
            <!-- Renamed columns -->
            <div v-if="schemaDiff.columnsRenamed.length">
              <h4>Renamed Columns</h4>
              <ul>
                <li v-for="c in schemaDiff.columnsRenamed" :key="c.id">
                  Rename column: "{{ c.oldTitle }}" → "{{ c.newTitle }}"
                </li>
              </ul>
            </div>

            <!-- Added columns -->
            <div v-if="schemaDiff.columnsAdded.length">
              <h4>New Columns</h4>
              <ul>
                <li v-for="(c, i) in schemaDiff.columnsAdded" :key="i">
                  Add column: "{{ c.title }}"
                </li>
              </ul>
            </div>

            <!-- Soft-deleted columns -->
            <div v-if="schemaDiff.columnsSoftDeleted.length">
              <h4 class="preview-danger">Soft-Deleted Columns</h4>
              <ul>
                <li v-for="c in schemaDiff.columnsSoftDeleted" :key="c.id">
                  Soft delete: Column "{{ c.title }}" ({{ c.retainedTaskCount }} card{{ c.retainedTaskCount === 1 ? '' : 's' }} will be retained in trash)
                </li>
              </ul>
            </div>

            <!-- Added fields -->
            <div v-if="schemaDiff.fieldsAdded.length">
              <h4>New Fields</h4>
              <ul>
                <li v-for="(f, i) in schemaDiff.fieldsAdded" :key="i">
                  Add field: "{{ f.title }}" ({{ f.valueType }})
                </li>
              </ul>
            </div>

            <!-- Modified fields -->
            <div v-if="schemaDiff.fieldsModified.length">
              <h4>Modified Fields</h4>
              <ul>
                <li v-for="f in schemaDiff.fieldsModified" :key="f.id">
                  Field "{{ f.title }}": {{ f.changes.join(", ") }}
                </li>
              </ul>
            </div>

            <!-- Soft-deleted fields -->
            <div v-if="schemaDiff.fieldsSoftDeleted.length">
              <h4 class="preview-danger">Soft-Deleted Fields</h4>
              <ul>
                <li v-for="f in schemaDiff.fieldsSoftDeleted" :key="f.id">
                  Soft delete: Field "{{ f.title }}" (values will be retained)
                </li>
              </ul>
            </div>

            <p v-if="!schemaDiff.columnsRenamed.length && !schemaDiff.columnsAdded.length && !schemaDiff.columnsSoftDeleted.length && !schemaDiff.fieldsAdded.length && !schemaDiff.fieldsModified.length && !schemaDiff.fieldsSoftDeleted.length">
              No structural differences detected.
            </p>
          </div>

          <div class="dialog-actions">
            <button class="button button-quiet" type="button" @click="showPreview = false">Back to editing</button>
            <button class="button button-primary" type="button" @click="handleConfirmApply">Confirm apply</button>
          </div>
        </section>
      </ModalLayer>
    </section>
  </ModalLayer>
</template>

<style scoped>
.schema-editor-dialog {
  width: min(960px, 100%);
  max-width: none;
  max-height: calc(100dvh - 48px);
  display: flex;
  flex-direction: column;
  padding: 28px;
  overflow: hidden;
}
.schema-entity-dialog { width: min(720px, 100%); }
.schema-editor-dialog > .dialog-head, .schema-editor-dialog > .schema-tabs, .schema-editor-dialog > .schema-error-banner { flex-shrink: 0; }
.schema-tabs {
  display: flex;
  gap: 6px;
  border-bottom: 2px solid var(--line, #171717);
  margin-top: 0;
}
.schema-tab-btn {
  min-height: 44px;
  padding: 10px 16px;
  background: var(--soft, #e9e5db);
  border: 1px solid var(--line, #171717);
  border-bottom: none;
  font-weight: 700;
  font-size: 0.85rem;
  cursor: pointer;
}
.schema-tab-btn.active {
  background: var(--yellow, #ffd43b);
  border-top: 2px solid var(--line, #171717);
}
.schema-tab-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 6px 24px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.schema-section {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 0;
  background: transparent;
  border-radius: 0;
}
.schema-section-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.schema-section-head h3 { margin: 0; font-size: 1.2rem; }
.schema-field-label {
  display: grid;
  gap: 10px;
  color: var(--muted);
  font: 800 .68rem/1.4 ui-monospace, monospace;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.schema-field-label .schema-input { width: 100%; }
.schema-columns-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.schema-column-item {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) 152px auto;
  align-items: center;
  gap: 10px;
}
.column-order-controls {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.icon-button-small {
  background: transparent;
  border: 1px solid var(--line, #171717);
  border-radius: 0;
  font-size: 0.65rem;
  padding: 1px 4px;
  cursor: pointer;
}
.schema-input {
  min-width: 0;
  min-height: 42px;
  padding: 8px 10px;
  border: 2px solid var(--line, #171717);
  border-radius: 0;
  font-size: 0.9rem;
  background: white;
}
.column-title-input {
  flex: 1;
}
.schema-select {
  min-height: 42px;
  padding: 8px 10px;
  border: 2px solid var(--line, #171717);
  border-radius: 0;
  font-size: 0.85rem;
  background: white;
}
.schema-add-row {
  display: grid;
  grid-template-columns: minmax(0, 280px) auto;
  gap: 10px;
  margin-top: 4px;
}
.schema-fields-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.schema-field-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  background: white;
  border: 2px solid var(--soft);
  border-radius: 0;
}
.schema-field-item-head { display: flex; justify-content: space-between; align-items: center; gap: 14px; }
.schema-field-item-head > .button { flex-shrink: 0; }
.field-item-header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.field-item-header strong { overflow-wrap: anywhere; }
.field-type { color: var(--muted); font: .75rem/1.4 ui-monospace, monospace; }
.required-badge {
  font-size: 0.7rem;
  background: var(--soft);
  color: var(--ink);
  padding: 3px 6px;
}
.schema-options-box {
  margin-top: 0.25rem;
}
.options-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.option-pill {
  font-size: 0.75rem;
  background: rgba(0, 0, 0, 0.08);
  padding: 2px 6px;
  border-radius: 0;
}
.schema-add-field-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 160px auto;
  align-items: end;
  gap: 14px;
  border: 2px solid var(--line, #171717);
  padding: 16px;
  border-radius: 0;
  margin-bottom: 4px;
  background: var(--paper);
}
.schema-add-field-form label { display: grid; gap: 7px; color: var(--muted); font: 800 .68rem/1 ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; }
.schema-add-field-form label:has(.schema-input) { grid-column: span 1; }
.schema-add-field-form label:has(.schema-input):nth-child(3) { grid-column: 1 / -1; }
.schema-checkbox-label { display: flex !important; align-items: center; gap: 8px !important; min-height: 42px; color: var(--ink) !important; letter-spacing: 0 !important; text-transform: none !important; font: 700 .95rem/1 Inter, ui-sans-serif, sans-serif !important; }
.schema-checkbox-label input { width: 22px; height: 22px; margin: 0; }
.schema-add-field-actions { display: flex; justify-content: flex-end; gap: 8px; grid-column: 1 / -1; }
.schema-empty-state { margin: 0; color: var(--muted); font-size: .9rem; }
.schema-json-textarea {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.85rem;
  line-height: 1.4;
  padding: 0.75rem;
  border: 2px solid var(--line, #171717);
  border-radius: 0;
  width: 100%;
  box-sizing: border-box;
}
.workspace-json-editor > p { margin: 0; color: var(--muted); line-height: 1.5; }
.workspace-json-label { display: grid; gap: 8px; min-height: 0; color: var(--muted); font: 800 .68rem/1 ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; }
.workspace-json-label textarea { min-height: min(52vh, 560px); resize: vertical; color: var(--ink); letter-spacing: 0; text-transform: none; }
.priority-settings { gap: 18px; }
.priority-settings h3, .priority-settings p { margin: 0; }
.priority-settings p { color: var(--muted); line-height: 1.45; }
.priority-settings-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.priority-settings-head > div, .priority-empty { display: grid; gap: 8px; }
.priority-rules, .priority-thresholds { display: grid; gap: 12px; margin: 0; padding: 16px; border: 2px solid var(--line); }
.priority-rule-row { display: grid; grid-template-columns: 1.2fr 1fr 1.2fr 92px auto; align-items: end; gap: 10px; }
.priority-rule-row label, .priority-thresholds label { display: grid; gap: 6px; color: var(--muted); font: 800 .68rem/1 ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; }
.priority-rule-row input, .priority-rule-row select, .priority-thresholds input { min-width: 0; min-height: 42px; border: 2px solid var(--line); border-radius: 0; background: white; padding: 8px 10px; font: 700 .9rem/1.2 Inter, ui-sans-serif, sans-serif; }
.priority-rule-remove { min-height: 42px; }
.priority-thresholds { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.priority-thresholds legend { padding: 0 8px; font: 800 .75rem/1 ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; }
.preview-body { display: grid; gap: 16px; max-height: 50vh; margin: 20px 0; overflow-y: auto; }
.preview-body h4 { margin: 0 0 8px; font-size: .9rem; text-transform: uppercase; }
.preview-danger { color: var(--red); }
.schema-error-banner {
  background: #fff0f0;
  border: 1px solid #ff4757;
  color: #c0392b;
  padding: 0.75rem;
  border-radius: 0;
  font-size: 0.85rem;
}
.schema-error-banner ul {
  margin: 0.25rem 0 0 1.25rem;
  padding: 0;
}
.button-danger {
  color: #9d2f21;
  border-color: #9d2f21;
  background: white;
}
.schema-dialog-actions { flex: 0 0 auto; gap: 8px; margin-top: 0; padding-top: 18px; border-top: 2px solid var(--line); }

@media (max-width: 720px) {
  .schema-editor-dialog { width: 100%; max-height: calc(100dvh - 32px); padding: 20px; }
  .schema-column-item { grid-template-columns: 38px minmax(0, 1fr) auto; }
  .schema-column-item .schema-select { grid-column: 2 / 3; }
  .schema-column-item .button-danger { grid-column: 3 / 4; grid-row: 1 / 3; align-self: stretch; }
  .schema-add-field-form { grid-template-columns: 1fr; }
  .priority-settings-head { display: grid; }
  .priority-rule-row { grid-template-columns: 1fr 1fr; }
  .priority-rule-remove { grid-column: 1 / -1; }
  .priority-thresholds { grid-template-columns: 1fr 1fr; }
  .schema-add-field-form label:has(.schema-input), .schema-add-field-form label:has(.schema-input):nth-child(3) { grid-column: auto; }
}

@media (max-width: 480px) {
  .schema-tab-btn { flex: 1; padding: 8px 6px; font-size: .72rem; }
  .schema-add-row { grid-template-columns: 1fr; }
  .schema-field-item { padding: 12px; }
  .schema-field-item-head { align-items: flex-start; }
  .schema-add-field-actions { display: flex; flex-wrap: wrap; }
  .schema-add-field-actions .button { flex: 1; }
}
</style>
