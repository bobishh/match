import { onBeforeUnmount, ref, watch } from "vue"

/** Show progress only when work outlasts the delay; never delay completion. */
export function useDelayedFlag(active: () => boolean, delay = 200) {
  const visible = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  watch(active, value => {
    clearTimeout(timer)
    visible.value = false
    if (value) timer = setTimeout(() => { visible.value = true }, delay)
  }, { immediate: true })
  onBeforeUnmount(() => clearTimeout(timer))
  return visible
}
