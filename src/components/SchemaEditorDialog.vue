<script setup lang="ts">
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

const props = defineProps<{
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

const activeTab = ref<"templates" | "json">("templates")
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

// Tree view add field form state
const showAddField = ref(false)
const newFieldTitle = ref("")
const newFieldValueType = ref<"text" | "number" | "boolean" | "select" | "url" | "date">("text")
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
    displayHint: "normal",
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
  <div class="overlay overlay-level-100" role="presentation" @click.self="emit('close')">
    <section class="dialog schema-editor-dialog" role="dialog" aria-modal="true" :aria-label="mode === 'entity' ? `Edit ${editorEntityName}` : 'Workspace settings'">
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
                  <strong>{{ fld.title }} ({{ fld.valueType }})</strong>
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
          <button class="schema-tab-btn" :class="{ active: activeTab === 'templates' }" type="button" role="tab" :aria-selected="activeTab === 'templates'" @click="activeTab = 'templates'">Document templates</button>
          <button class="schema-tab-btn" :class="{ active: activeTab === 'json' }" type="button" role="tab" :aria-selected="activeTab === 'json'" @click="activeTab = 'json'">JSON</button>
        </div>

        <div v-if="activeTab === 'templates'" class="schema-tab-content">
          <div class="templates-layout">
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
          </div>
        </div>

        <div v-else class="schema-tab-content workspace-json-editor">
          <p>Advanced workspace configuration. One apply updates workspace title, board, columns, fields, and document templates.</p>
          <div v-if="workspaceErrors.length" class="schema-error-banner" role="alert">
            <strong>Validation errors:</strong>
            <ul><li v-for="(error, index) in workspaceErrors" :key="index"><code v-if="error.path">{{ error.path }}</code>: {{ error.message }}</li></ul>
          </div>
          <label class="workspace-json-label">
            <span>Workspace settings JSON</span>
            <textarea :value="workspaceJson" class="schema-json-textarea" rows="22" aria-label="Workspace settings JSON" spellcheck="false" @input="handleWorkspaceJsonInput"></textarea>
          </label>
          <div class="dialog-actions"><button class="button button-primary" type="button" :disabled="workspaceErrors.length > 0" @click="applyWorkspaceJson">Apply JSON</button></div>
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
      <div v-if="showPreview && schemaDiff" class="overlay overlay-level-150" @click.self="showPreview = false">
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
      </div>
    </section>
  </div>
</template>

<style scoped>
.schema-editor-dialog {
  width: min(1120px, calc(100vw - 64px));
  max-width: none;
  max-height: calc(100vh - 40px);
  display: flex;
  flex-direction: column;
  padding: clamp(24px, 3vw, 38px);
}
.schema-tabs {
  display: flex;
  gap: 6px;
  border-bottom: 2px solid var(--line, #171717);
  margin-top: 1rem;
}
.schema-tab-btn {
  padding: 8px 16px;
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
  padding: 24px 2px;
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
.field-item-header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.required-badge {
  font-size: 0.7rem;
  background: #ff4757;
  color: white;
  padding: 1px 4px;
  border-radius: 0;
  margin-left: 0.5rem;
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
  color: #c0392b;
  border-color: #c0392b;
}
.schema-dialog-actions { flex: 0 0 auto; gap: 8px; margin-top: 0; padding-top: 18px; border-top: 2px solid var(--line); }

@media (max-width: 720px) {
  .schema-editor-dialog { width: calc(100vw - 32px); max-height: calc(100vh - 32px); padding: 20px; }
  .schema-column-item { grid-template-columns: 38px minmax(0, 1fr) auto; }
  .schema-column-item .schema-select { grid-column: 2 / 3; }
  .schema-column-item .button-danger { grid-column: 3 / 4; grid-row: 1 / 3; align-self: stretch; }
  .schema-add-field-form { grid-template-columns: 1fr; }
  .schema-add-field-form label:has(.schema-input), .schema-add-field-form label:has(.schema-input):nth-child(3) { grid-column: auto; }
}

@media (max-width: 480px) {
  .schema-tab-btn { flex: 1; padding: 8px 6px; font-size: .72rem; }
  .schema-add-row { grid-template-columns: 1fr; }
  .schema-field-item-head { align-items: flex-start; flex-direction: column; }
  .schema-field-item-head .button { width: 100%; }
  .schema-add-field-actions { display: grid; grid-template-columns: 1fr 1fr; }
  .schema-add-field-actions .button { width: 100%; }
}
</style>
