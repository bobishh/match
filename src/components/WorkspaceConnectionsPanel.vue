<script setup lang="ts">
import { defineAsyncComponent, type Component } from "vue"
import { useAutomations, type AutomationWorkspace } from "../app/useAutomations"
import AutomationsPanel from "./AutomationsPanel.vue"
import type { BlindReplicationController } from "../app/blindReplication"
const TelemetryDeliveryPanel = defineAsyncComponent<Component>(() => import("./TelemetryDeliveryPanel.vue"))
const props = defineProps<{ workspace: AutomationWorkspace; workspaceTitle: string; workspaceId: string; controller: BlindReplicationController; owner: boolean }>()
const automations = useAutomations(props.workspace, props.controller, () => props.owner)
const emit = defineEmits<{ open: [tab: "Participants" | "Rusty" | "Backups"] }>()
</script>
<template>
  <section class="settings-connections" aria-label="Workspace connections">
    <h3>{{ workspaceTitle }}</h3>
    <p class="dialog-copy">Manage access, storage connections and backups for this workspace.</p>
    <button class="button" type="button" @click="emit('open', 'Participants')">Participants and devices</button>
    <button class="button" type="button" @click="emit('open', 'Rusty')">Rusty storage</button>
    <button class="button" type="button" @click="emit('open', 'Backups')">Back up or move workspace</button>
  </section>
  <TelemetryDeliveryPanel />
  <AutomationsPanel :management="automations" :owner="owner" />
</template>
<style scoped>
.settings-connections { display: grid; gap: 12px; }
h3, p { margin: 0; }
.button { justify-self: start; }
</style>
