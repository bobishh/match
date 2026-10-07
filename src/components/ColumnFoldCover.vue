<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue"

const props = defineProps<{ collapsed: boolean }>()
const cover = ref<HTMLElement>()
let observer: ResizeObserver | undefined
let animation: Animation | undefined
let expandedWidth = 220
let headerHeight = 54
let generation = 0

function restingFrame() {
  const column = cover.value!.parentElement!
  const panel = getComputedStyle(column).getPropertyValue("--panel").trim()
  const ink = getComputedStyle(cover.value!, "::before").backgroundColor
  return props.collapsed
    ? { width: `${column.clientHeight}px`, height: "60px", transform: "translateX(60px) rotate(90deg)", backgroundColor: `color-mix(in srgb, ${ink} 18%, ${panel})` }
    : { width: `${column.clientWidth}px`, height: `${headerHeight}px`, transform: "translateX(0px) rotate(0deg)", backgroundColor: panel }
}

function measure() {
  const column = cover.value?.parentElement
  if (!column || animation) return
  if (!props.collapsed) {
    expandedWidth = column.clientWidth
    headerHeight = column.querySelector(".column-header")?.getBoundingClientRect().height || 54
  }
  Object.assign(cover.value!.style, restingFrame())
}

onMounted(() => {
  const column = cover.value!.parentElement!
  const neighbor = column.parentElement?.querySelector<HTMLElement>(".column:not(.column-collapsed)")
  expandedWidth = neighbor?.clientWidth || 220
  measure()
  observer = new ResizeObserver(measure)
  observer.observe(column)
})

watch(() => props.collapsed, collapsed => {
  const element = cover.value
  const column = element?.parentElement
  if (!element || !column) return
  const token = ++generation
  const previousFrame = animation ? {
    width: getComputedStyle(element).width,
    height: getComputedStyle(element).height,
    transform: getComputedStyle(element).transform,
    backgroundColor: getComputedStyle(element).backgroundColor,
  } : undefined
  animation?.cancel()
  animation = undefined
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    requestAnimationFrame(measure)
    return
  }
  // The watcher runs before the column changes size, preserving the open header geometry.
  if (collapsed && !previousFrame) {
    expandedWidth = column.clientWidth
    headerHeight = column.querySelector(".column-header")?.getBoundingClientRect().height || headerHeight
  }
  const length = column.clientHeight
  const spineWidth = 60
  const panel = getComputedStyle(column).getPropertyValue("--panel").trim()
  const ink = getComputedStyle(element, "::before").backgroundColor
  const tint = `color-mix(in srgb, ${ink} 18%, ${panel})`
  const horizontal = { width: `${expandedWidth}px`, height: `${headerHeight}px`, transform: "translateX(0px) rotate(0deg)", backgroundColor: panel }
  const turned = { width: `${expandedWidth}px`, height: `${spineWidth}px`, transform: `translateX(${spineWidth}px) rotate(90deg)`, backgroundColor: tint }
  const vertical = { width: `${length}px`, height: `${spineWidth}px`, transform: `translateX(${spineWidth}px) rotate(90deg)`, backgroundColor: tint }
  const frames = collapsed
    ? [{ ...(previousFrame || horizontal), offset: 0 }, { ...turned, offset: .5 }, { ...vertical, offset: 1 }]
    : [{ ...(previousFrame || vertical), offset: 0 }, { ...turned, offset: .4 }, { ...horizontal, offset: 1 }]
  animation = element.animate(frames, { duration: 360, easing: "ease-in-out", fill: "both" })
  animation.finished.then(() => {
    if (token !== generation) return
    animation?.commitStyles()
    animation?.cancel()
    animation = undefined
    measure()
  }).catch(() => {})
})

onBeforeUnmount(() => {
  generation++
  animation?.cancel()
  observer?.disconnect()
})
</script>

<template>
  <span ref="cover" class="column-fold-cover" aria-hidden="true"></span>
</template>
