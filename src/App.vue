<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue"
import { downloadWorkspaceBundle, readWorkspaceBundle } from "./storage"
import { hydrate, useMatch } from "./state"
import type { DocumentKind, Lead, LeadInput, LeadPriority, LeadStatus } from "./types"
import { documentKindLabels, priorityLabels, statusLabels } from "./types"
import { registerWebMcp } from "./webmcp"
import SyncDialog from "./components/SyncDialog.vue"
import LeadFilters from "./components/LeadFilters.vue"
import { defaultLeadFilters, matchesLeadFilters, type LeadFilters as LeadFilterState } from "./filters"
import { useDeviceSync } from "./sync/useDeviceSync"

const { workspace, ready, columns, createLead, updateLead, moveLead, createDocument, documentsFor, persist, getAutomergeBytes, mergeRemoteBytes, mergeWorkspaceRecord, subscribeLocalChanges } = useMatch()

const selectedLeadId = ref<string | null>(null)
const detailDialog = ref<HTMLElement | null>(null)
const importInput = ref<HTMLInputElement | null>(null)
const showLeadForm = ref(false)
const showDocumentForm = ref(false)
const search = ref("")
const filters = ref<LeadFilterState>({ ...defaultLeadFilters })
const notice = ref("")
const draggingLeadId = ref<string | null>(null)
const dragOverStatus = ref<LeadStatus | null>(null)
const sync = useDeviceSync({
  workspace: { getBytes: getAutomergeBytes, mergeBytes: mergeRemoteBytes, subscribe: subscribeLocalChanges },
  origin: () => window.location.origin,
})

const newLead = ref<LeadInput>({
  company: "",
  role: "",
  url: "",
  location: "Berlin / remote",
  workMode: "remote",
  status: "lead",
  priority: "p2",
  fitScore: undefined,
  description: "",
  notes: "",
  sourceText: "",
})

const newDocument = ref({
  kind: "cv" as DocumentKind,
  title: "",
  format: "markdown" as "markdown" | "html" | "pdf" | "path",
  content: "",
  localPath: "",
})

const selectedLead = computed(() => workspace.leads.find((lead) => lead.id === selectedLeadId.value) ?? null)
const selectedDocuments = computed(() => selectedLead.value ? documentsFor(selectedLead.value.id) : [])
const totalDocuments = computed(() => workspace.documents.length)

watch(selectedLeadId, async (leadId) => {
  if (!leadId) return
  await nextTick()
  detailDialog.value?.focus()
})

const visibleColumns = computed(() => columns.value.map((column) => ({
  ...column,
  leads: column.leads.filter((lead) => {
    const query = search.value.trim().toLowerCase()
    const matchesQuery = !query || `${lead.company} ${lead.role} ${lead.notes ?? ""}`.toLowerCase().includes(query)
    return matchesQuery && matchesLeadFilters(lead, filters.value)
  }),
})))

onMounted(async () => {
  await hydrate()
  sync.joinFromLocation(window.location.href)
  await registerWebMcp({
    workspace,
    createLead,
    updateLead,
    moveLead,
    createDocument,
    persist,
  })
})

function submitLead() {
  if (!newLead.value.company.trim() || !newLead.value.role.trim()) {
    notice.value = "Company and role required"
    return
  }

  const duplicate = workspace.leads.find((lead) =>
    (newLead.value.url && lead.url === newLead.value.url) ||
    (lead.company.toLowerCase() === newLead.value.company.trim().toLowerCase() &&
      lead.role.toLowerCase() === newLead.value.role.trim().toLowerCase()),
  )

  if (duplicate) {
    notice.value = `Possible duplicate: ${duplicate.company} — ${duplicate.role}`
    selectedLeadId.value = duplicate.id
    showLeadForm.value = false
    return
  }

  const lead = createLead({
    ...newLead.value,
    company: newLead.value.company.trim(),
    role: newLead.value.role.trim(),
    url: newLead.value.url?.trim() || undefined,
    fitScore: newLead.value.fitScore || undefined,
  })
  selectedLeadId.value = lead.id
  showLeadForm.value = false
  notice.value = "Lead added"
  resetLeadForm()
}

function resetLeadForm() {
  newLead.value = {
    company: "",
    role: "",
    url: "",
    location: "Berlin / remote",
    workMode: "remote",
    status: "lead",
    priority: "p2",
    fitScore: undefined,
    description: "",
    notes: "",
    sourceText: "",
  }
}

function submitDocument() {
  if (!selectedLead.value || !newDocument.value.title.trim()) return
  createDocument({
    leadId: selectedLead.value.id,
    kind: newDocument.value.kind,
    title: newDocument.value.title.trim(),
    format: newDocument.value.format,
    content: newDocument.value.content || undefined,
    localPath: newDocument.value.localPath || undefined,
  })
  showDocumentForm.value = false
  newDocument.value = { kind: "cv", title: "", format: "markdown", content: "", localPath: "" }
  notice.value = "Document attached"
}

function setStatus(status: LeadStatus) {
  if (selectedLead.value) moveLead(selectedLead.value.id, status)
}

function startLeadDrag(event: DragEvent, lead: Lead) {
  if (!event.dataTransfer) return
  draggingLeadId.value = lead.id
  event.dataTransfer.effectAllowed = "move"
  event.dataTransfer.setData("text/plain", lead.id)
}

function dragOverColumn(event: DragEvent, status: LeadStatus) {
  if (!draggingLeadId.value && !event.dataTransfer?.types.includes("text/plain")) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
  dragOverStatus.value = status
}

function dragLeaveColumn(event: DragEvent, status: LeadStatus) {
  const currentTarget = event.currentTarget as HTMLElement | null
  const relatedTarget = event.relatedTarget as Node | null
  if (currentTarget?.contains(relatedTarget)) return
  if (dragOverStatus.value === status) dragOverStatus.value = null
}

function clearLeadDrag() {
  draggingLeadId.value = null
  dragOverStatus.value = null
}

function dropLead(event: DragEvent, status: LeadStatus) {
  event.preventDefault()
  const leadId = event.dataTransfer?.getData("text/plain") || draggingLeadId.value
  const lead = leadId ? workspace.leads.find((item) => item.id === leadId) : undefined

  if (!lead) {
    notice.value = "Drop failed: card data missing"
    clearLeadDrag()
    return
  }

  if (lead.status === status) {
    notice.value = `${lead.company} already in ${statusLabels[status]}`
  } else {
    moveLead(lead.id, status)
    notice.value = `${lead.company} moved to ${statusLabels[status]}`
  }
  clearLeadDrag()
}

function cardDocuments(lead: Lead) {
  return documentsFor(lead.id)
}

function exportWorkspace() {
  downloadWorkspaceBundle({ leads: workspace.leads, documents: workspace.documents }, getAutomergeBytes())
  notice.value = "Match bundle exported"
}

function openImport() {
  importInput.value?.click()
}

async function importWorkspace(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ""
  if (!file) return
  try {
    await mergeWorkspaceRecord(await readWorkspaceBundle(file))
    notice.value = "Match bundle merged"
  } catch (error) {
    notice.value = error instanceof Error ? error.message : "Match bundle import failed"
  }
}

function closeDetail() {
  selectedLeadId.value = null
  showDocumentForm.value = false
}
</script>

<template>
  <main class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">M</span>
        <div>
          <h1>MATCH</h1>
          <p>Cards, documents, next move.</p>
        </div>
      </div>
      <div class="top-actions">
        <span class="local-state"><span class="pulse"></span> {{ sync.isLive.value ? "Live" : "Local" }}</span>
        <a class="button button-quiet" href="/agent">Agent guide</a>
        <button class="button button-quiet" type="button" @click="sync.open">Sync</button>
        <button class="button button-quiet" type="button" @click="exportWorkspace">Export .match</button>
        <button class="button button-quiet" type="button" @click="openImport">Import .match</button>
        <button class="button button-primary" type="button" @click="showLeadForm = true">+ Add lead</button>
        <input ref="importInput" class="sr-only" type="file" accept=".match,application/vnd.match+zip" @change="importWorkspace" />
      </div>
    </header>

    <section class="toolbar" aria-label="Match controls">
      <label class="search-field">
        <span>⌕</span>
        <input v-model="search" type="search" placeholder="Search company, role, notes" />
      </label>
      <div class="toolbar-spacer"></div>
      <LeadFilters v-model="filters" />
      <span class="stats">{{ workspace.leads.length }} cards · {{ totalDocuments }} docs</span>
    </section>

    <div v-if="notice" class="notice" role="status" @click="notice = ''">{{ notice }}</div>

    <section v-if="ready" class="board" aria-label="Lead pipeline">
      <article v-for="column in visibleColumns" :key="column.status" class="column" :class="[`column-${column.status}`, { 'column-drop-target': dragOverStatus === column.status }]" @dragover="dragOverColumn($event, column.status)" @dragleave="dragLeaveColumn($event, column.status)" @drop="dropLead($event, column.status)">
        <header class="column-header">
          <div class="column-title"><span class="column-dot"></span><h2>{{ statusLabels[column.status] }}</h2></div>
          <span class="count">{{ column.leads.length }}</span>
        </header>

        <div class="card-stack">
          <button v-for="lead in column.leads" :key="lead.id" class="lead-card" type="button" draggable="true" :aria-label="`Drag ${lead.company} — ${lead.role}`" @click="selectedLeadId = lead.id" @dragstart="startLeadDrag($event, lead)" @dragend="clearLeadDrag">
            <div class="card-head">
              <span class="company">{{ lead.company }}</span>
              <span v-if="lead.priority" class="priority" :class="lead.priority">{{ lead.priority.toUpperCase() }}</span>
            </div>
            <strong>{{ lead.role }}</strong>
            <div class="card-meta">
              <span v-if="lead.location">{{ lead.location }}</span>
              <span v-if="lead.fitScore !== undefined" class="fit">{{ lead.fitScore }}/10 fit</span>
            </div>
            <div v-if="cardDocuments(lead).length" class="card-docs">
              <span v-for="document in cardDocuments(lead).slice(0, 3)" :key="document.id" class="doc-chip">{{ documentKindLabels[document.kind] }}</span>
              <span v-if="cardDocuments(lead).length > 3" class="doc-more">+{{ cardDocuments(lead).length - 3 }}</span>
            </div>
          </button>
          <div v-if="!column.leads.length" class="empty-column">No cards</div>
        </div>
      </article>
    </section>

    <section v-else class="loading-state">Loading local workspace…</section>

    <SyncDialog
      v-if="sync.isOpen.value"
      :phase="sync.phase.value"
      :title="sync.title.value"
      :qr-code="sync.qrCode.value"
      :invite-url="sync.inviteUrl.value"
      :copy-notice="sync.copyNotice.value"
      :error="sync.error.value"
      @copy="sync.copyInvite"
      @join="sync.prepareJoin"
      @connect="sync.connectToMesh"
      @dismiss="sync.dismiss"
      @stop="sync.close"
    />

    <div v-if="showLeadForm" class="overlay" @click.self="showLeadForm = false">
      <form class="dialog" @submit.prevent="submitLead">
        <div class="dialog-head"><div><span class="eyebrow">New card</span><h2>Add lead</h2></div><button class="icon-button" type="button" aria-label="Close" @click="showLeadForm = false">×</button></div>
        <div class="form-grid">
          <label><span>Company *</span><input v-model="newLead.company" autofocus required /></label>
          <label><span>Role *</span><input v-model="newLead.role" required /></label>
          <label class="wide"><span>Job URL</span><input v-model="newLead.url" type="url" placeholder="https://" /></label>
          <label><span>Location</span><input v-model="newLead.location" /></label>
          <label><span>Work mode</span><select v-model="newLead.workMode"><option value="remote">Remote</option><option value="hybrid">Hybrid</option><option value="onsite">On-site</option><option value="unknown">Unknown</option></select></label>
          <label><span>Status</span><select v-model="newLead.status"><option v-for="(label, status) in statusLabels" :key="status" :value="status">{{ label }}</option></select></label>
          <label><span>Priority</span><select v-model="newLead.priority"><option v-for="(label, priority) in priorityLabels" :key="priority" :value="priority">{{ label }}</option></select></label>
          <label><span>Fit score</span><input v-model.number="newLead.fitScore" type="number" min="0" max="10" placeholder="0–10" /></label>
          <label class="wide"><span>Notes</span><textarea v-model="newLead.notes" rows="3" placeholder="Why this matters, gaps, next move…"></textarea></label>
          <label class="wide"><span>Source snapshot</span><textarea v-model="newLead.sourceText" rows="4" placeholder="Paste description if useful for later tailoring…"></textarea></label>
        </div>
        <div class="dialog-actions"><button class="button button-quiet" type="button" @click="showLeadForm = false">Cancel</button><button class="button button-primary" type="submit">Create card</button></div>
      </form>
    </div>

    <div v-if="selectedLead" class="overlay detail-overlay" role="presentation" @click.self="closeDetail">
      <section ref="detailDialog" class="dialog detail-dialog" role="dialog" aria-modal="true" aria-label="Lead details" tabindex="-1" @keydown.esc="closeDetail">
        <div class="detail-head"><div><span class="eyebrow">Lead card</span><h2>{{ selectedLead.company }}</h2><p>{{ selectedLead.role }}</p></div><button class="icon-button" type="button" aria-label="Close detail" @click="closeDetail">×</button></div>
      <div class="status-strip"><button v-for="(label, status) in statusLabels" :key="status" type="button" :class="{ active: selectedLead.status === status }" @click="setStatus(status)">{{ label }}</button></div>
      <div class="detail-scroll">
        <div class="detail-grid">
          <div><span class="detail-label">Priority</span><strong>{{ selectedLead.priority ? priorityLabels[selectedLead.priority] : "—" }}</strong></div>
          <div><span class="detail-label">Fit</span><strong>{{ selectedLead.fitScore ?? "—" }}<small v-if="selectedLead.fitScore !== undefined">/10</small></strong></div>
          <div><span class="detail-label">Location</span><strong>{{ selectedLead.location || "—" }}</strong></div>
          <div><span class="detail-label">Work mode</span><strong>{{ selectedLead.workMode || "—" }}</strong></div>
        </div>
        <a v-if="selectedLead.url" class="source-link" :href="selectedLead.url" target="_blank" rel="noreferrer">Open job source ↗</a>
        <section v-if="selectedLead.notes" class="detail-section"><span class="detail-label">Notes</span><p class="detail-copy">{{ selectedLead.notes }}</p></section>
        <section v-if="selectedLead.sourceText" class="detail-section"><span class="detail-label">Source snapshot</span><p class="source-snapshot">{{ selectedLead.sourceText }}</p></section>
        <section class="detail-section documents-section"><div class="section-heading"><div><span class="detail-label">Documents</span><h3>{{ selectedDocuments.length ? `${selectedDocuments.length} attached` : "Nothing attached" }}</h3></div><button class="button button-small" type="button" @click="showDocumentForm = !showDocumentForm">+ Document</button></div>
          <form v-if="showDocumentForm" class="document-form" @submit.prevent="submitDocument"><label><span>Kind</span><select v-model="newDocument.kind"><option v-for="(label, kind) in documentKindLabels" :key="kind" :value="kind">{{ label }}</option></select></label><label><span>Title</span><input v-model="newDocument.title" required /></label><label><span>Format</span><select v-model="newDocument.format"><option value="markdown">Markdown</option><option value="html">HTML</option><option value="pdf">PDF</option><option value="path">Local path</option></select></label><label v-if="newDocument.format === 'path'"><span>Path</span><input v-model="newDocument.localPath" placeholder="/Users/…" /></label><label v-else><span>Content</span><textarea v-model="newDocument.content" rows="5" placeholder="Paste draft or note…"></textarea></label><button class="button button-primary" type="submit">Attach</button></form>
          <div v-for="document in selectedDocuments" :key="document.id" class="document-row"><span class="document-icon">{{ document.kind === "cv" ? "CV" : document.kind === "cover_letter" ? "CL" : "↗" }}</span><div><strong>{{ document.title }}</strong><span>{{ documentKindLabels[document.kind] }} · {{ document.format }}</span></div><a v-if="document.localPath" :href="`file://${document.localPath}`" class="open-path" title="Open local file">Open</a></div>
        </section>
      </div>
      </section>
    </div>
  </main>
</template>
