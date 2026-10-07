<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue"

const props = defineProps<{ collapsed: boolean; title: string; count: number }>()
const cover = ref<HTMLElement>()
const folding = ref(false)
let observer: ResizeObserver | undefined
let animation: Animation | undefined
let expandedWidth = 220
let headerHeight = 54
let generation = 0

function measure() {
  const column = cover.value?.parentElement
  if (!column || props.collapsed || animation) return
  expandedWidth = column.clientWidth
  headerHeight = column.querySelector(".column-header")?.getBoundingClientRect().height || 54
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
    opacity: getComputedStyle(element).opacity,
  } : undefined
  animation?.cancel()
  animation = undefined
  folding.value = false
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return
  // The watcher runs before the column changes size, preserving the open header geometry.
  if (collapsed && !previousFrame) {
    expandedWidth = column.clientWidth
    headerHeight = column.querySelector(".column-header")?.getBoundingClientRect().height || headerHeight
  }
  const length = column.clientHeight
  const spineWidth = 60
  const horizontal = { width: `${expandedWidth}px`, height: `${headerHeight}px`, transform: "translateX(0px) rotate(0deg)", opacity: 1 }
  const turned = { width: `${expandedWidth}px`, height: `${spineWidth}px`, transform: `translateX(${spineWidth}px) rotate(90deg)`, opacity: 1 }
  const vertical = { width: `${length}px`, height: `${spineWidth}px`, transform: `translateX(${spineWidth}px) rotate(90deg)`, opacity: 1 }
  folding.value = true
  const frames = collapsed
    ? [{ ...(previousFrame || horizontal), offset: 0 }, { ...turned, offset: .5 }, { ...vertical, offset: .9 }, { ...vertical, opacity: 0, offset: 1 }]
    : [{ ...(previousFrame || vertical), offset: 0 }, { ...turned, offset: .4 }, { ...horizontal, offset: .9 }, { ...horizontal, opacity: 0, offset: 1 }]
  animation = element.animate(frames, { duration: 360, easing: "ease-in-out", fill: "both" })
  animation.finished.then(() => {
    if (token !== generation) return
    animation?.cancel()
    animation = undefined
    folding.value = false
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
  <span ref="cover" class="column-fold-cover" :class="{ 'is-folding': folding, 'is-collapsing': collapsed }" aria-hidden="true">
    <strong>{{ title }}</strong><span class="count">{{ count }}</span>
  </span>
</template>
