<script setup lang="ts">
import { computed, ref, useSlots } from "vue";
import "./SchemaEditorDialog.css";
import ModalLayer from "./ModalLayer.vue";
import SchemaEntitySection from "./schema-editor/SchemaEntitySection.vue";
import SchemaPreviewDialog from "./schema-editor/SchemaPreviewDialog.vue";
import SchemaPrioritySection from "./schema-editor/SchemaPrioritySection.vue";
import SchemaTemplateSection from "./schema-editor/SchemaTemplateSection.vue";
import SchemaWorkspaceJsonSection from "./schema-editor/SchemaWorkspaceJsonSection.vue";
import { compareRanks } from "../domain/ancestry";
import type {
  Board,
  Column,
  FieldDefinition,
  Heads,
  WorkspaceDocumentV2,
} from "../domain/model";
import { createDefaultPriorityPolicy } from "../domain/priority";
import {
  diffBoardSchema,
  projectBoardSchema,
  validateBoardSchemaDraft,
  type BoardSchemaDraft,
  type SchemaDiff,
  type SchemaValidationError,
} from "../domain/schema";
import {
  projectWorkspaceSettings,
  validateWorkspaceSettingsDraft,
  type WorkspaceSettingsDraft,
} from "../domain/workspaceSettings";
import type { Template } from "../types";

const props = defineProps<{
  readOnly?: boolean;
  doc: WorkspaceDocumentV2;
  board: Board;
  columns: Column[];
  fields: FieldDefinition[];
  templates: Template[];
  heads?: Heads;
  mode: "entity" | "templates";
}>();

const emit = defineEmits<{
  (event: "close"): void;
  (
    event: "apply",
    payload: { schema: BoardSchemaDraft; expectedHeads?: Heads },
  ): void;
  (
    event: "saveTemplate",
    payload: { id?: string; name: string; markdown: string },
  ): void;
  (
    event: "applyWorkspaceSettings",
    payload: { settings: WorkspaceSettingsDraft; expectedHeads?: Heads },
  ): void;
}>();

const slots = useSlots();
const activeTab = ref<"identity" | "templates" | "priority" | "json" | "participants" | "data">(
  slots.identity ? "identity" : "templates",
);
const draft = ref<BoardSchemaDraft>(
  projectBoardSchema(props.doc, props.board.id),
);
const validationErrors = ref<SchemaValidationError[]>([]);
const showPreview = ref(false);
const schemaDiff = ref<SchemaDiff | null>(null);
const workspaceSettings = ref<WorkspaceSettingsDraft>(
  projectWorkspaceSettings(props.doc, props.board.id),
);
const workspaceJson = ref(JSON.stringify(workspaceSettings.value, null, 2));
const workspaceErrors = ref<SchemaValidationError[]>([]);
const priorityErrors = ref<string[]>([]);

const editorEntityName = computed(
  () => draft.value.entityName || props.board.entityName || "item",
);
const supportsAutomaticPriority = computed(() =>
  Boolean(
    props.board.preset?.bindings["field.priority"] &&
      props.board.preset?.bindings["field.fitScore"],
  ),
);
const priorityPolicy = computed(
  () => workspaceSettings.value.board.priorityPolicy ?? null,
);
const criterionFields = computed(() =>
  props.fields.filter(
    (field) =>
      !field.deleted &&
      field.id !== priorityPolicy.value?.priorityFieldId &&
      field.id !== priorityPolicy.value?.fitFieldId,
  ),
);
const priorityOptions = computed(() => {
  const field = props.fields.find(
    (item) => item.id === priorityPolicy.value?.priorityFieldId,
  );
  if (!field || field.valueType !== "select") return [];
  return Object.values(field.options)
    .filter((option) => !option.deleted)
    .sort((left, right) => compareRanks(left.rank, right.rank))
    .map((option) => ({ id: option.id, title: option.title }));
});

function updateEntityDraft(nextDraft: BoardSchemaDraft) {
  draft.value = nextDraft;
  validateCurrentDraft();
}

function validateCurrentDraft() {
  validationErrors.value = validateBoardSchemaDraft(draft.value).errors;
}

function reviewEntityChanges() {
  validateCurrentDraft();
  if (validationErrors.value.length) return;

  schemaDiff.value = diffBoardSchema(props.doc, props.board.id, draft.value);
  showPreview.value = true;
}

function confirmEntityChanges() {
  emit("apply", { schema: draft.value, expectedHeads: props.heads });
  showPreview.value = false;
}

function updateWorkspaceJson(value: string) {
  workspaceJson.value = value;
  try {
    const parsed = JSON.parse(value);
    workspaceSettings.value = parsed;
    workspaceErrors.value = validateWorkspaceSettingsDraft(
      parsed,
      props.doc,
    ).errors;
  } catch (error) {
    workspaceErrors.value = [invalidJsonError(error)];
  }
}

function applyWorkspaceJson() {
  updateWorkspaceJson(workspaceJson.value);
  if (workspaceErrors.value.length) return;
  emit("applyWorkspaceSettings", {
    settings: workspaceSettings.value,
    expectedHeads: props.heads,
  });
}

function enableAutomaticPriority() {
  workspaceSettings.value.board.priorityPolicy = createDefaultPriorityPolicy(
    props.board,
    props.fields,
  );
  priorityErrors.value = priorityPolicy.value
    ? []
    : ["Priority and fit fields are unavailable"];
}

function disableAutomaticPriority() {
  workspaceSettings.value.board.priorityPolicy = null;
}

function addPriorityRule() {
  const policy = priorityPolicy.value;
  const field = criterionFields.value[0];
  if (!policy || !field) return;

  policy.rules.push({
    id: crypto.randomUUID(),
    fieldId: field.id,
    operator: defaultRuleOperator(field),
    value: defaultRuleValue(field),
    weight: 1,
  });
}

function removePriorityRule(index: number) {
  priorityPolicy.value?.rules.splice(index, 1);
}

function savePriorityRules() {
  priorityErrors.value = [];
  if (priorityPolicy.value && !priorityPolicy.value.rules.length) {
    priorityErrors.value = ["Add at least one priority rule"];
    return;
  }

  const errors = validateWorkspaceSettingsDraft(
    workspaceSettings.value,
    props.doc,
  ).errors.filter((error) => error.path.startsWith("/board/priorityPolicy"));
  if (errors.length) {
    priorityErrors.value = errors.map((error) => error.message);
    return;
  }
  emit("applyWorkspaceSettings", {
    settings: workspaceSettings.value,
    expectedHeads: props.heads,
  });
}

function defaultRuleOperator(field: FieldDefinition) {
  return field.valueType === "number" ||
    field.valueType === "select" ||
    field.valueType === "boolean"
    ? "equals"
    : "contains";
}

function defaultRuleValue(field: FieldDefinition): boolean | number | string {
  if (field.valueType === "select")
    return (
      Object.values(field.options).find((option) => !option.deleted)?.id ?? ""
    );
  if (field.valueType === "boolean") return true;
  if (field.valueType === "number") return field.min ?? 0;
  return "";
}

function invalidJsonError(error: unknown): SchemaValidationError {
  return {
    path: "",
    message: `Invalid JSON syntax: ${error instanceof Error ? error.message : "unknown error"}`,
  };
}
</script>

<template>
  <ModalLayer
    protect-draft
    class="overlay overlay-level-100"
    @close="emit('close')"
  >
    <section
      class="dialog schema-editor-dialog"
      :class="{ 'schema-entity-dialog': mode === 'entity' }"
      role="dialog"
      aria-modal="true"
      :aria-label="
        mode === 'entity' ? `Edit ${editorEntityName}` : 'Settings'
      "
    >
      <header class="dialog-head">
        <div>
          <span class="eyebrow">{{
            mode === "entity" ? "Entity schema" : "Settings"
          }}</span>
          <h2>
            {{
              mode === "entity"
                ? `Edit ${editorEntityName}`
                : "Settings"
            }}
          </h2>
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

      <div
        v-if="validationErrors.length"
        class="schema-error-banner"
        role="alert"
      >
        <strong>Validation errors:</strong>
        <ul>
          <li v-for="(error, index) in validationErrors" :key="index">
            <code v-if="error.path">{{ error.path }}</code
            >: {{ error.message }}
          </li>
        </ul>
      </div>

      <SchemaEntitySection
        v-if="mode === 'entity'"
        :model-value="draft"
        @update:model-value="updateEntityDraft"
      />

      <template v-else>
        <nav
          class="schema-tabs"
          role="tablist"
          aria-label="Settings views"
        >
          <button
            v-if="$slots.identity"
            class="schema-tab-btn"
            :class="{ active: activeTab === 'identity' }"
            type="button"
            role="tab"
            :aria-selected="activeTab === 'identity'"
            @click="activeTab = 'identity'"
          >
            Identity
          </button>
          <button
            v-if="$slots.participants"
            class="schema-tab-btn"
            :class="{ active: activeTab === 'participants' }"
            type="button"
            role="tab"
            :aria-selected="activeTab === 'participants'"
            @click="activeTab = 'participants'"
          >
            Participants
          </button>
          <button
            v-if="$slots.data"
            class="schema-tab-btn"
            :class="{ active: activeTab === 'data' }"
            type="button"
            role="tab"
            :aria-selected="activeTab === 'data'"
            @click="activeTab = 'data'"
          >
            Data
          </button>
          <button
            v-if="supportsAutomaticPriority"
            class="schema-tab-btn"
            :class="{ active: activeTab === 'priority' }"
            type="button"
            role="tab"
            :aria-selected="activeTab === 'priority'"
            @click="activeTab = 'priority'"
          >
            Priority rules
          </button>
          <button
            class="schema-tab-btn"
            :class="{ active: activeTab === 'templates' }"
            type="button"
            role="tab"
            :aria-selected="activeTab === 'templates'"
            @click="activeTab = 'templates'"
          >
            Document templates
          </button>
          <button
            class="schema-tab-btn"
            :class="{ active: activeTab === 'json' }"
            type="button"
            role="tab"
            :aria-selected="activeTab === 'json'"
            @click="activeTab = 'json'"
          >
            JSON
          </button>
        </nav>

        <div v-if="activeTab === 'identity'" class="schema-tab-content">
          <slot name="identity" />
        </div>
        <SchemaTemplateSection
          v-else-if="activeTab === 'templates'"
          :read-only="readOnly"
          :templates="templates"
          @save="emit('saveTemplate', $event)"
        />
        <div v-else-if="activeTab === 'participants'" class="schema-tab-content">
          <slot name="participants" />
        </div>
        <div v-else-if="activeTab === 'data'" class="schema-tab-content">
          <slot name="data" />
        </div>
        <SchemaPrioritySection
          v-else-if="activeTab === 'priority'"
          :criterion-fields="criterionFields"
          :errors="priorityErrors"
          :policy="priorityPolicy"
          :priority-options="priorityOptions"
          :read-only="readOnly"
          @add-rule="addPriorityRule"
          @disable="disableAutomaticPriority"
          @enable="enableAutomaticPriority"
          @remove-rule="removePriorityRule"
          @save="savePriorityRules"
        />
        <SchemaWorkspaceJsonSection
          v-else
          :errors="workspaceErrors"
          :read-only="readOnly"
          :value="workspaceJson"
          @apply="applyWorkspaceJson"
          @update:value="updateWorkspaceJson"
        />
      </template>

      <footer
        v-if="mode === 'entity'"
        class="dialog-actions schema-dialog-actions"
      >
        <button
          class="button button-quiet"
          type="button"
          @click="emit('close')"
        >
          Cancel
        </button>
        <button
          class="button button-primary"
          type="button"
          :disabled="validationErrors.length > 0"
          @click="reviewEntityChanges"
        >
          Review changes
        </button>
      </footer>

      <SchemaPreviewDialog
        v-if="showPreview && schemaDiff"
        :diff="schemaDiff"
        @close="showPreview = false"
        @confirm="confirmEntityChanges"
      />
    </section>
  </ModalLayer>
</template>
