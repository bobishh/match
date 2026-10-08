<script setup lang="ts">
import { onMounted, ref, watch } from "vue"
import { keeperApi, type PendingKeeperWithdrawal } from "../app/keeperApi"
import { keeperDisplayName } from "../ui/deviceInfo"

const emit = defineEmits<{ restore: [entry: PendingKeeperWithdrawal]; count: [count: number] }>()
const props = defineProps<{ refreshKey?: number }>()
const entries = ref<PendingKeeperWithdrawal[]>([])

async function refresh() {
  try { entries.value = await keeperApi.pendingWithdrawals() }
  catch { /* Leave the last verified history visible during transient storage failure. */ }
  emit("count", entries.value.filter(entry => !entry.orphanResolution).length)
}

onMounted(() => { void refresh() })
watch(() => props.refreshKey, () => { void refresh() })
</script>

<template>
  <section v-if="entries.length" class="keeper-list" aria-label="Saved keeper cancellation history">
    <p class="sync-section-copy">Saved keeper cancellation history</p>
    <article v-for="entry in entries" :key="`${entry.pairingId}:${entry.operationId}`" class="keeper-history-row">
      <span class="keeper-dot" :data-state="entry.orphanResolution ? 'active' : 'reconnecting'" aria-hidden="true"></span>
      <span class="keeper-history-copy">
        <strong>{{ keeperDisplayName(String((entry.pairing.discovery as Record<string, unknown> | undefined)?.displayName ?? "Rusty")) }}</strong>
        <small>{{ entry.orphanResolution ? `Orphan resolved from signed Rusty status · revision ${entry.orphanResolution.serviceRevision}` : 'Cancellation pending · retry available' }}</small>
      </span>
      <button v-if="!entry.orphanResolution" class="button button-quiet" type="button" @click="emit('restore', entry)">Restore request</button>
    </article>
  </section>
</template>

<style scoped>
.keeper-history-row { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; align-items: center; gap: 12px; min-width: 0; width: 100%; min-height: 58px; padding: 10px 12px; border: 2px solid var(--line); color: var(--ink); text-align: left; }
.keeper-history-copy { display: grid; gap: 4px; min-width: 0; }
.keeper-history-copy strong { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.keeper-history-copy small { display: block; min-width: 0; color: var(--muted); font: 700 .8rem/1.2 var(--site-font-sans); text-transform: uppercase; overflow-wrap: anywhere; }
.keeper-history-row > .button { max-width: 100%; white-space: normal; }

@media (max-width: 420px) {
  .keeper-history-row { grid-template-columns: 10px minmax(0, 1fr); }
  .keeper-history-row > .button { grid-column: 2; justify-self: start; }
}
</style>
