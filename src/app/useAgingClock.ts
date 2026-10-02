import { ref, onMounted, onBeforeUnmount } from "vue"
import { cardAge, isCardAgingExemptColumn } from "../domain/aging"

export function useCardAges(policy: () => Parameters<typeof cardAge>[1]) {
  const now = useAgingClock()
  return (item: Parameters<typeof cardAge>[0], column: { title: string; archive?: true }) =>
    isCardAgingExemptColumn(column) ? null : cardAge(item, policy(), now.value)
}

// Only the local clock changes; activity timestamps remain in the document.
function useAgingClock() {
  const now = ref(new Date())
  let interval: ReturnType<typeof setInterval> | undefined
  onMounted(() => { interval = setInterval(() => { now.value = new Date() }, 60_000) })
  onBeforeUnmount(() => clearInterval(interval))
  return now
}
