<script setup lang="ts">
import { ref } from "vue"
import { discoverLighthouse, type KeeperWorkspace } from "../sync/lighthouseDiscovery"

const props = defineProps<{ ownedWorkspaces: KeeperWorkspace[] }>()
const open = ref(false)
const originInput = ref("")
const status = ref<"idle" | "loading" | "found" | "error">("idle")
const error = ref("")
const discovery = ref<Awaited<ReturnType<typeof discoverLighthouse>> | null>(null)
const selectedWorkspaceIds = ref<string[]>([])

async function discover() {
  error.value = ""
  discovery.value = null
  status.value = "loading"
  try {
    discovery.value = await discoverLighthouse(originInput.value)
    selectedWorkspaceIds.value = props.ownedWorkspaces.map(workspace => workspace.id)
    status.value = "found"
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Could not discover this Lighthouse service."
    status.value = "error"
  }
}

function close() {
  open.value = false
  status.value = "idle"
  error.value = ""
  discovery.value = null
}
</script>

<template>
  <section class="sync-section keeper-discovery" aria-label="Keeper discovery">
    <p class="sync-section-copy">Self-hosted Lighthouse</p>
    <button v-if="!open" class="button" type="button" @click="open = true">Add keeper</button>
    <div v-else class="keeper-discovery-form">
      <label class="pairing-paste">
        <span>Keeper hostname</span>
        <input v-model="originInput" type="url" autocomplete="url" placeholder="keeper.example.com" aria-label="Keeper hostname" @keydown.enter.prevent="discover" />
      </label>
      <div class="dialog-actions">
        <button class="button button-primary" type="button" :disabled="status === 'loading' || !originInput.trim()" @click="discover">{{ status === 'loading' ? "Discovering…" : "Discover keeper" }}</button>
        <button class="button button-quiet" type="button" @click="close">Cancel</button>
      </div>
      <p v-if="error" class="sync-error" role="alert">{{ error }}</p>
      <section v-if="discovery" class="mesh-member-action" aria-label="Discovered keeper">
        <h3>{{ discovery.displayName }}</h3>
        <p class="dialog-copy">{{ discovery.origin }}</p>
        <p><span class="detail-label">Fingerprint</span><br /><code>{{ discovery.fingerprint }}</code></p>
        <p class="dialog-copy">Service identity: {{ discovery.personId }}. Discovery data is not proof of prior ownership or authenticated trust.</p>
        <p class="dialog-copy">Capabilities: {{ discovery.capabilities.modes.join(", ") }} mode; documents {{ discovery.capabilities.documentReplication ? "yes" : "no" }}; chat {{ discovery.capabilities.chatReplication ? "yes" : "no" }}; attachments {{ discovery.capabilities.blobReplication ? "yes" : "no" }}.</p>
        <p v-if="ownedWorkspaces.length" class="sync-section-copy">Owned boards eligible for a future request</p>
        <div v-if="ownedWorkspaces.length" class="sync-workspace-list">
          <label v-for="workspace in ownedWorkspaces" :key="workspace.id" class="sync-checkbox-item">
            <input v-model="selectedWorkspaceIds" type="checkbox" :value="workspace.id" :aria-label="`Keeper board: ${workspace.title}`" />
            <span>{{ workspace.title }}<small class="sync-workspace-detail">Replicate · Visitor access</small></span>
          </label>
        </div>
        <p v-else class="dialog-copy">No board has verified owner access here. Open Sync on an owned board and retry.</p>
        <p class="dialog-copy" role="status">Pairing and provisioning are unavailable. Discovery did not connect or grant access.</p>
        <button class="button button-primary" type="button" disabled>Pairing unavailable</button>
      </section>
    </div>
  </section>
</template>
