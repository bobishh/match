<script setup lang="ts">
import { onMounted, ref } from "vue"
import { keeperApi, type PendingKeeperWithdrawal } from "../app/keeperApi"
import { keeperDisplayName } from "../ui/deviceInfo"

const emit = defineEmits<{ restore: [entry: PendingKeeperWithdrawal]; count: [count: number] }>()
const entries = ref<PendingKeeperWithdrawal[]>([])

async function refresh() {
  try { entries.value = await keeperApi.pendingWithdrawals() }
  catch { /* Leave the last verified history visible during transient storage failure. */ }
  emit("count", entries.value.length)
}

onMounted(() => { void refresh() })
</script>

<template>
  <section v-if="entries.length" class="keeper-list" aria-label="Saved keeper cancellation history">
    <p class="sync-section-copy">Saved keeper cancellation history</p>
    <article v-for="entry in entries" :key="`${entry.pairingId}:${entry.operationId}`" class="keeper-row">
      <span class="keeper-dot" data-state="reconnecting" aria-hidden="true"></span>
      <span class="keeper-row-copy"><strong>{{ keeperDisplayName(String((entry.pairing.discovery as Record<string, unknown> | undefined)?.displayName ?? "Rusty")) }}</strong><small>Cancellation pending · retry available</small></span>
      <button class="button button-quiet" type="button" @click="emit('restore', entry)">Restore request</button>
    </article>
  </section>
</template>
