<script setup lang="ts">
import { onMounted, ref, shallowRef } from "vue"
import TincanbanPageLayout from "./TincanbanPageLayout.vue"
import TincanbanHeading from "./TincanbanHeading.vue"
import BrandCan from "./BrandCan.vue"
import { prepareLighthouseLoginApproval, type LighthouseLoginApproval } from "../app/lighthouseLogin"

const request = shallowRef<LighthouseLoginApproval | null>(null)
const loading = ref(true)
const submitting = ref(false)
const error = ref("")

async function loadRequest() {
  loading.value = true
  error.value = ""
  try {
    const params = new URLSearchParams(window.location.search)
    const origin = params.get("keeper") ?? ""
    const challengeId = params.get("challenge") ?? ""
    if ([...params.keys()].some(key => !["keeper", "challenge"].includes(key))) throw new Error("Sign-in link contains unexpected parameters.")
    request.value = await prepareLighthouseLoginApproval(origin, challengeId)
  } catch (cause) {
    request.value = null
    error.value = cause instanceof Error ? cause.message : "Could not verify keeper sign-in request."
  } finally {
    loading.value = false
  }
}

async function approve() {
  if (!request.value || submitting.value) return
  submitting.value = true
  error.value = ""
  try {
    const redirect = await request.value.approve()
    window.location.assign(redirect)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Could not approve keeper sign-in."
  } finally {
    submitting.value = false
  }
}

function cancel() { window.location.replace("/") }
onMounted(() => { void loadRequest() })
</script>

<template>
  <TincanbanPageLayout class="lighthouse-login" aria-labelledby="login-title" :busy="loading || submitting">
    <template #header>
      <div class="brand">
        <BrandCan />
        <div><TincanbanHeading label="Identity approval" uppercase /></div>
      </div>
    </template>
    <section class="identity-login-content">
      <article v-if="loading" class="identity-login-card" role="status">Checking signed keeper request…</article>
      <article v-else-if="request" class="identity-login-card">
        <p class="eyebrow">Review before signing</p>
        <h2 id="login-title">Sign in with your tincanban identity?</h2>
        <dl class="identity-review">
          <div><dt>Lighthouse</dt><dd>{{ request.keeperName }}</dd></div>
          <div><dt>Keeper address</dt><dd>{{ request.keeperOrigin }}</dd></div>
          <div><dt>tincanban identity</dt><dd>{{ request.tincanbanName }}</dd></div>
          <div><dt>Person ID</dt><dd>{{ request.tincanbanPersonId }}</dd></div>
        </dl>
        <p class="section-copy">Approval signs this one-time sign-in request. It does not grant keeper access to your boards.</p>
        <div class="dialog-actions">
          <button class="button button-primary" type="button" :disabled="submitting" @click="approve">{{ submitting ? "Signing in…" : "Approve sign-in" }}</button>
          <button class="button button-quiet" type="button" :disabled="submitting" @click="cancel">Cancel</button>
        </div>
      </article>
      <article v-else class="identity-login-card">
        <h2 id="login-title">Could not verify sign-in request</h2>
        <p class="sync-error" role="alert">{{ error }}</p>
        <div class="dialog-actions"><button class="button button-primary" type="button" @click="loadRequest">Retry</button><button class="button button-quiet" type="button" @click="cancel">Cancel</button></div>
      </article>
      <p v-if="error && request" class="sync-error" role="alert">{{ error }}</p>
    </section>
  </TincanbanPageLayout>
</template>

<style scoped>
.identity-review { display: grid; gap: 10px; margin: 18px 0; }
.identity-review div { display: grid; grid-template-columns: minmax(120px, .7fr) minmax(0, 1fr); gap: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--soft); }
.identity-review dt { color: var(--muted); font-weight: 750; }
.identity-review dd { margin: 0; overflow-wrap: anywhere; font-weight: 700; }
.identity-login-content { width: min(620px, calc(100% - 40px)); margin: 32px auto; }
.identity-login-card { display: grid; gap: 12px; padding: 24px; border: 2px solid var(--line); background: white; }
.identity-login-card h2, .identity-login-card p { margin: 0; }
.identity-login-card .dialog-actions { margin-top: 4px; flex-wrap: wrap; }
</style>
