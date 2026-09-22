<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue"
import {
  attachmentMediaType,
  attachmentName,
  attachmentSize,
  readAttachment,
  storeAttachment,
} from "../attachments"
import type { Document, DocumentInput, DocumentKind } from "../types"
import ModalLayer from "./ModalLayer.vue"

type DocumentDraft = Omit<DocumentInput, "leadId">

const props = defineProps<{
  documents: Document[]
  readOnly?: boolean
  save: (document: DocumentDraft) => Promise<void>
}>()

const formOpen = ref(false)
const kind = ref<DocumentKind>("note")
const title = ref("")
const format = ref<"markdown" | "html">("markdown")
const content = ref("")
const file = ref<File | null>(null)
const saving = ref(false)
const error = ref("")
const preview = ref<Document | null>(null)
const previewText = ref("")
const previewUrl = ref("")
const previewError = ref("")

async function attach() {
  const trimmedTitle = title.value.trim()
  if (!trimmedTitle || saving.value) return
  saving.value = true
  error.value = ""
  try {
    if (kind.value === "attachment") {
      if (!file.value) {
        error.value = "Choose a file"
        return
      }
      const reference = await storeAttachment(file.value)
      await props.save({
        kind: "attachment",
        title: trimmedTitle,
        format: attachmentMediaType(reference) === "application/pdf" ? "pdf" : "file",
        file: reference,
      })
    } else {
      await props.save({
        kind: kind.value,
        title: trimmedTitle,
        format: format.value,
        content: content.value,
      })
    }
    resetForm()
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    saving.value = false
  }
}

function selectFile(event: Event) {
  file.value = (event.target as HTMLInputElement).files?.[0] ?? null
}

function resetForm() {
  formOpen.value = false
  kind.value = "note"
  title.value = ""
  format.value = "markdown"
  content.value = ""
  file.value = null
  error.value = ""
}

async function openPreview(document: Document) {
  closePreview()
  preview.value = document
  previewError.value = ""
  if (document.content !== undefined) {
    previewText.value = document.content
    return
  }
  if (!document.file) {
    previewError.value = document.localPath
      ? "This legacy local path cannot be opened by the browser. Attach the file again."
      : "No preview content is attached."
    return
  }
  try {
    const bytes = await readAttachment(document.file)
    if (!bytes) {
      previewError.value = "File is not available on this device."
      return
    }
    const mediaType = attachmentMediaType(document.file)
    if (isText(mediaType)) {
      previewText.value = new TextDecoder().decode(bytes)
    } else if (isEmbeddable(mediaType)) {
      previewUrl.value = URL.createObjectURL(blobFrom(bytes, mediaType))
    } else {
      previewError.value = "This file type has no inline preview. Download it to open it."
    }
  } catch (caught) {
    previewError.value = caught instanceof Error ? caught.message : String(caught)
  }
}

function closePreview() {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  preview.value = null
  previewText.value = ""
  previewUrl.value = ""
  previewError.value = ""
}

async function download(document: Document) {
  if (!document.file) return
  error.value = ""
  try {
    const bytes = await readAttachment(document.file)
    if (!bytes) {
      error.value = "File is not available on this device."
      return
    }
    const url = URL.createObjectURL(blobFrom(bytes, attachmentMediaType(document.file)))
    const link = window.document.createElement("a")
    link.href = url
    link.download = attachmentName(document.file)
    window.document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
}

function fileDescription(document: Document): string {
  if (!document.file) return document.format
  const size = attachmentSize(document.file)
  return `${attachmentName(document.file)}${size === undefined ? "" : ` · ${formatBytes(size)}`}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function isText(mediaType: string): boolean {
  return mediaType.startsWith("text/") || mediaType === "application/json"
}

function isEmbeddable(mediaType: string): boolean {
  return mediaType.startsWith("image/") || mediaType === "application/pdf"
}

function blobFrom(bytes: Uint8Array, type: string): Blob {
  const data = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  return new Blob([data], { type })
}

onBeforeUnmount(closePreview)
</script>

<template>
  <section class="detail-section documents-section">
    <div class="section-heading">
      <div>
        <span class="detail-label">Notes & files</span>
        <h3>{{ documents.length ? `${documents.length} attached` : "Nothing attached" }}</h3>
      </div>
      <button class="button button-small" type="button" :disabled="readOnly" @click="formOpen = !formOpen">
        + Document
      </button>
    </div>

    <form v-if="formOpen" class="document-form" aria-label="Attach document" @submit.prevent="attach">
      <label>
        <span>Kind</span>
        <select v-model="kind">
          <option value="note">Note</option>
          <option value="attachment">Attachment</option>
        </select>
      </label>
      <label>
        <span>Title</span>
        <input v-model="title" required />
      </label>
      <template v-if="kind === 'attachment'">
        <label>
          <span>File</span>
          <input type="file" aria-label="File" required @change="selectFile" />
        </label>
      </template>
      <template v-else>
        <label>
          <span>Format</span>
          <select v-model="format">
            <option value="markdown">Markdown</option>
            <option value="html">HTML</option>
          </select>
        </label>
        <label>
          <span>Content</span>
          <textarea v-model="content" rows="5" placeholder="Write note…"></textarea>
        </label>
      </template>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <button class="button button-primary" type="submit" :disabled="saving">
        {{ saving ? "Attaching…" : "Attach" }}
      </button>
    </form>

    <p v-else-if="error" class="form-error" role="alert">{{ error }}</p>
    <div
      v-for="document in documents"
      :key="document.id"
      class="document-row"
      role="group"
      :aria-label="document.title"
    >
      <span class="document-icon">{{ document.kind === "cv" ? "CV" : document.kind === "cover_letter" ? "CL" : document.file ? "FILE" : "NOTE" }}</span>
      <div>
        <strong>{{ document.title }}</strong>
        <span>{{ fileDescription(document) }}</span>
      </div>
      <div class="document-actions">
        <button class="button button-small button-quiet" type="button" @click="openPreview(document)">Preview</button>
        <button v-if="document.file?.type === 'blob'" class="button button-small" type="button" @click="download(document)">Download</button>
      </div>
    </div>

    <ModalLayer v-if="preview" @close="closePreview">
      <section class="dialog document-preview-dialog" role="dialog" aria-modal="true" aria-label="Document preview">
        <div class="detail-head">
          <div>
            <span class="eyebrow">Preview</span>
            <h2>{{ preview.title }}</h2>
          </div>
          <button class="icon-button" type="button" aria-label="Close" @click="closePreview">×</button>
        </div>
        <p v-if="previewError" class="document-preview-message">{{ previewError }}</p>
        <iframe
          v-else-if="preview.content !== undefined && preview.format === 'html'"
          class="document-preview-frame"
          title="HTML document preview"
          sandbox=""
          :srcdoc="previewText"
        ></iframe>
        <pre v-else-if="previewText" class="document-preview-text">{{ previewText }}</pre>
        <img
          v-else-if="previewUrl && preview.file && attachmentMediaType(preview.file).startsWith('image/')"
          class="document-preview-image"
          :src="previewUrl"
          :alt="preview.title"
        />
        <iframe v-else-if="previewUrl" class="document-preview-frame" title="File preview" :src="previewUrl"></iframe>
      </section>
    </ModalLayer>
  </section>
</template>
