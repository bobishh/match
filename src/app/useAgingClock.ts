import { ref, onMounted, onBeforeUnmount } from "vue"

// Only the local clock changes; activity timestamps remain in the document.
export function useAgingClock() {
  const now = ref(new Date())
  let interval: ReturnType<typeof setInterval> | undefined
  onMounted(() => { interval = setInterval(() => { now.value = new Date() }, 60_000) })
  onBeforeUnmount(() => clearInterval(interval))
  return now
}
