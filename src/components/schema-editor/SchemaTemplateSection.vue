<script setup lang="ts">
import { ref } from "vue";
import type { Template } from "../../types";

defineProps<{
  readOnly?: boolean;
  templates: Template[];
}>();

const emit = defineEmits<{
  (
    event: "save",
    payload: { id?: string; name: string; markdown: string },
  ): void;
}>();

const editingTemplateId = ref<string | null>(null);
const templateDraft = ref({ name: "", markdown: "" });

function startTemplate() {
  editingTemplateId.value = null;
  templateDraft.value = { name: "", markdown: "" };
}

function editTemplate(template: Template) {
  editingTemplateId.value = template.id;
  templateDraft.value = { name: template.name, markdown: template.markdown };
}

function saveTemplate() {
  const name = templateDraft.value.name.trim();
  const markdown = templateDraft.value.markdown.trim();
  if (!name || !markdown) return;

  emit("save", {
    ...(editingTemplateId.value ? { id: editingTemplateId.value } : {}),
    name,
    markdown,
  });
}
</script>

<template>
  <div class="schema-tab-content">
    <fieldset :disabled="readOnly" class="templates-layout">
      <aside class="template-list" aria-label="Saved templates">
        <button
          class="button button-small"
          type="button"
          @click="startTemplate"
        >
          + Template
        </button>
        <button
          v-for="template in templates"
          :key="template.id"
          class="template-item"
          :class="{ active: editingTemplateId === template.id }"
          type="button"
          @click="editTemplate(template)"
        >
          <strong>{{ template.name }}</strong>
        </button>
        <p v-if="!templates.length" class="empty-template-list">
          No templates yet.
        </p>
      </aside>

      <form class="template-editor" novalidate @submit.prevent="saveTemplate">
        <label>
          <span>Name</span>
          <input
            v-model="templateDraft.name"
            required
            placeholder="General software CV"
          />
        </label>
        <label>
          <span>Markdown</span>
          <textarea
            v-model="templateDraft.markdown"
            rows="16"
            required
            placeholder="# Your name"
          ></textarea>
        </label>
        <div class="dialog-actions">
          <button class="button button-primary" type="submit">
            Save template
          </button>
        </div>
      </form>
    </fieldset>
  </div>
</template>
