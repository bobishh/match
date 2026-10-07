<script setup lang="ts">
import { ref } from "vue"

type ReviewChange = {
  hash: string
  status: { type: "quarantined" | "pending"; reason: string }
  preview: string[]
  actor: string
  time: number
  action: string
  personId?: string
  deviceId?: string
}

const props = defineProps<{
  changes: ReviewChange[]
  error: string
  canReview: boolean
  reviewChange: (hash: string) => Promise<void>
}>()

const busyHash = ref("")
const actionError = ref("")

function reviewTime(seconds: number): string {
  const date = new Date(seconds * 1000)
  return Number.isFinite(date.getTime()) && Math.abs(date.getFullYear()) < 100_000
    ? date.toLocaleString()
    : "Time unavailable"
}

async function review(hash: string) {
  busyHash.value = hash
  actionError.value = ""
  try { await props.reviewChange(hash) }
  catch (error) { actionError.value = error instanceof Error ? error.message : String(error) }
  finally { busyHash.value = "" }
}
</script>

<template>
  <section v-if="changes.length || error" class="causal-review-banner" aria-label="Workspace change review">
    <p v-if="error" class="causal-review-error" role="alert">{{ error }}</p>
    <details :open="Boolean(error)">
      <summary>{{ changes.length ? `${changes.length} workspace changes need review` : 'Workspace access update needs retry' }}</summary>
      <ul class="causal-review-list">
        <li v-for="change in changes" :key="change.hash">
          <div><strong>{{ change.action }}</strong><span>{{ change.status.type === 'pending' ? 'Waiting for dependency' : 'Quarantined' }}</span></div>
          <small>{{ change.personId ?? change.actor }} · {{ change.deviceId ?? 'Unknown device' }} · {{ reviewTime(change.time) }}</small>
          <code>{{ change.hash }}</code>
          <p>{{ change.status.reason }}</p>
          <ul v-if="change.preview.length" class="causal-review-preview" aria-label="Draft field changes">
            <li v-for="(line, index) in change.preview" :key="index">{{ line }}</li>
          </ul>
          <p v-else-if="change.status.type === 'pending'">Waiting for dependencies to be available and authorized.</p>
          <button v-if="canReview && change.status.type === 'quarantined'" class="button button-small" type="button"
            :disabled="Boolean(busyHash) || Boolean(error)" @click="review(change.hash)">
            {{ busyHash === change.hash ? 'Creating authorized change…' : 'Create authorized change from this review' }}
          </button>
        </li>
      </ul>
      <p v-if="actionError" role="alert" class="causal-review-error">{{ actionError }}</p>
    </details>
  </section>
</template>

<style scoped>
.causal-review-banner { margin: 0 18px 12px; padding: 12px 16px; border: 1px solid var(--warning, #9a6b12); border-radius: 10px; background: var(--surface, white); }
.causal-review-banner summary { cursor: pointer; font-weight: 700; }
.causal-review-list { display: grid; gap: 12px; padding-left: 20px; }
.causal-review-list li { display: grid; gap: 5px; }
.causal-review-list li > div { display: flex; gap: 12px; align-items: baseline; }
.causal-review-list small, .causal-review-list code { color: var(--muted); overflow-wrap: anywhere; }
.causal-review-list p, .causal-review-error { margin: 0; }
.causal-review-error { color: var(--danger, #9b2c2c); }
</style>
