<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"

const props = defineProps<{ collapsed: boolean; title: string; count: number }>()
const visual = ref<HTMLElement>()
const cover = ref<HTMLElement>()
const titleElement = ref<HTMLElement>()
const countElement = ref<HTMLElement>()
const duration = 520
const easing = "cubic-bezier(.4, 0, .6, 1)"
let observer: ResizeObserver | undefined
let animations: Animation[] = []
let generation = 0
let disposed = false

type Paint = { width: string; height: string; transform: string; backgroundColor: string }
type Ink = { transform: string; fontSize: string; letterSpacing: string; width: string; height: string }
const column = () => visual.value!.parentElement!
const snapshot = (element: HTMLElement, properties: string[]) => {
  const style = getComputedStyle(element)
  return Object.fromEntries(properties.map(property => [property, style[property as keyof CSSStyleDeclaration]])) as Record<string, string>
}
const paintProperties = ["width", "height", "transform", "backgroundColor"]
const inkProperties = ["transform", "fontSize", "letterSpacing", "width", "height"]

function targetInk(element: HTMLElement, vertical = false): Ink {
  const outer = column().getBoundingClientRect()
  const rect = element.getBoundingClientRect()
  const style = getComputedStyle(element)
  const x = rect.left - outer.left - column().clientLeft + (vertical ? rect.width : 0)
  const y = rect.top - outer.top - column().clientTop
  return { transform: `translate(${x}px, ${y}px) rotate(${vertical ? 90 : 0}deg)`,
    fontSize: style.fontSize, letterSpacing: style.letterSpacing,
    width: `${vertical ? rect.height : rect.width}px`, height: `${vertical ? rect.width : rect.height}px` }
}

function restingFrames() {
  const parent = column()
  const nativeTitle = parent.querySelector<HTMLElement>(props.collapsed ? ".column-closed strong" : ".column-header h2")!
  const nativeCount = parent.querySelector<HTMLElement>(props.collapsed ? ".column-closed .count" : ".column-header .count")!
  const headerHeight = parent.querySelector(".column-header")?.getBoundingClientRect().height || 54
  const panel = getComputedStyle(parent).getPropertyValue("--panel").trim()
  const ink = getComputedStyle(cover.value!, "::before").backgroundColor
  const paint: Paint = props.collapsed
    ? { width: `${parent.clientHeight}px`, height: "60px", transform: "translateX(60px) rotate(90deg)", backgroundColor: `color-mix(in srgb, ${ink} 18%, ${panel})` }
    : { width: `${parent.clientWidth}px`, height: `${headerHeight}px`, transform: "translateX(0px) rotate(0deg)", backgroundColor: panel }
  return { paint, title: targetInk(nativeTitle, props.collapsed), count: targetInk(nativeCount), width: parent.getBoundingClientRect().width }
}

function settle() {
  if (disposed || animations.length || !visual.value) return
  const frames = restingFrames()
  Object.assign(cover.value!.style, frames.paint)
  Object.assign(titleElement.value!.style, frames.title)
  Object.assign(countElement.value!.style, frames.count)
}

function releaseWidth() {
  column().style.removeProperty("flex")
  column().style.removeProperty("min-width")
}

onMounted(() => {
  settle()
  observer = new ResizeObserver(settle)
  observer.observe(column())
  void document.fonts.ready.then(settle)
})

watch(() => props.collapsed, async collapsed => {
  if (!visual.value) return
  const token = ++generation
  const parent = column()
  const before = { width: parent.getBoundingClientRect().width,
    paint: snapshot(cover.value!, paintProperties), title: snapshot(titleElement.value!, inkProperties), count: snapshot(countElement.value!, inkProperties) }
  const interrupted = animations.length > 0
  animations.forEach(animation => animation.cancel())
  animations = []
  releaseWidth()
  await nextTick()
  if (disposed || token !== generation) return
  // Read the destination layout before painting, then animate from the exact visible geometry.
  const after = restingFrames()
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { settle(); return }
  parent.style.flex = `0 0 ${before.width}px`
  parent.style.minWidth = "0px"
  Object.assign(cover.value!.style, before.paint)
  Object.assign(titleElement.value!.style, before.title)
  Object.assign(countElement.value!.style, before.count)
  const horizontalWidth = collapsed ? before.width - 4 : after.width - 4
  const turned = { ...after.paint, backgroundColor: collapsed ? after.paint.backgroundColor : before.paint.backgroundColor, width: `${horizontalWidth}px`, height: "60px", transform: "translateX(60px) rotate(90deg)" }
  const paintFrames = interrupted ? [before.paint, after.paint] : collapsed
    ? [{ ...before.paint, offset: 0 }, { ...turned, offset: .55 }, { ...after.paint, offset: 1 }]
    : [{ ...before.paint, offset: 0 }, { ...turned, offset: .45 }, { ...after.paint, offset: 1 }]
  const inkFrames = (from: Record<string, string>, to: Ink) => interrupted ? [from, to] : collapsed
    ? [{ ...from, offset: 0 }, { ...to, offset: .55 }, { ...to, offset: 1 }]
    : [{ ...from, offset: 0 }, { ...from, offset: .45 }, { ...to, offset: 1 }]
  const travel = Math.abs(after.width - before.width) / Math.max(1, horizontalWidth - 60)
  const options = { duration: interrupted ? Math.max(180, duration * Math.min(1, travel)) : duration, easing, fill: "both" as const }
  const widthFrames = interrupted
    ? [{ flexBasis: `${before.width}px` }, { flexBasis: `${after.width}px` }]
    : collapsed
      ? [{ flexBasis: `${before.width}px`, offset: 0 }, { flexBasis: `${before.width}px`, offset: .12 }, { flexBasis: `${after.width}px`, offset: 1 }]
      : [{ flexBasis: `${before.width}px`, offset: 0 }, { flexBasis: `${after.width}px`, offset: .88 }, { flexBasis: `${after.width}px`, offset: 1 }]
  animations = [
    parent.animate(widthFrames, options),
    cover.value!.animate(paintFrames, options),
    titleElement.value!.animate(inkFrames(before.title, after.title), options),
    countElement.value!.animate(inkFrames(before.count, after.count), options),
  ]
  try {
    await Promise.all(animations.map(animation => animation.finished))
    if (token !== generation || disposed) return
    animations.forEach(animation => animation.commitStyles())
    animations.forEach(animation => animation.cancel())
    animations = []
    releaseWidth()
    parent.style.removeProperty("flex-basis")
    settle()
  } catch { /* A repeated click continues from the current visible frame. */ }
})

watch(() => [props.title, props.count], async () => { await nextTick(); settle() })
onBeforeUnmount(() => {
  disposed = true
  generation++
  animations.forEach(animation => animation.cancel())
  observer?.disconnect()
})
</script>

<template>
  <span ref="visual" class="column-fold-visuals" aria-hidden="true">
    <span ref="cover" class="column-fold-cover"></span>
    <strong ref="titleElement" class="column-fold-title">{{ props.title }}</strong>
    <span ref="countElement" class="column-fold-count count">{{ props.count }}</span>
  </span>
</template>
