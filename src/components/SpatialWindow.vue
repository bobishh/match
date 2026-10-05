<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue"
import { cycleSpatialWindow, ensureWindowHost, raiseWindow, registerSpatialWindow, saveWindowGeometry, unregisterSpatialWindow, updateWindowGeometry, type WindowDescriptor, type WindowGeometry } from "../ui/windowManager"

const props = withDefaults(defineProps<{
  windowId: string; workspaceId: string; title: string; ariaLabel?: string; closeLabel?: string; resizeLabel?: string; initialWidth?: number; initialHeight?: number
}>(), { initialWidth: 620, initialHeight: 620, closeLabel: "Close" })
const emit = defineEmits<{ close: [] }>()
const host = ensureWindowHost()
const root = ref<HTMLElement | null>(null)
const descriptor = shallowRef<WindowDescriptor | null>(null)
const duplicate = ref(false)
const maximized = ref(false)
let restored: WindowGeometry | null = null
let gesture: { id: number; x: number; y: number; initial: WindowGeometry; resize: boolean } | null = null
const style = computed(() => {
  const entry = descriptor.value
  if (!entry) return { visibility: "hidden" as const }
  const g = entry.geometry
  return { left: `${g.x}px`, top: `${g.y}px`, width: `${g.width}px`, height: `${g.height}px`, zIndex: entry.z }
})
function register() {
  if (descriptor.value) unregisterSpatialWindow(descriptor.value)
  if (!root.value) return
  descriptor.value = registerSpatialWindow(props.workspaceId, props.windowId, root.value, {
    x: Math.max(12, (window.innerWidth - props.initialWidth) / 2), y: 80,
    width: props.initialWidth, height: props.initialHeight,
  })
  duplicate.value = !descriptor.value
  if (descriptor.value) root.value.focus({ preventScroll: true })
}
function raise() { if (descriptor.value) raiseWindow(descriptor.value) }
function start(event: PointerEvent, resize = false) {
  if (event.button !== 0 || (!resize && (event.target as HTMLElement).closest("button, a, input, textarea"))) return
  if (!descriptor.value || maximized.value) return
  raise()
  gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, initial: { ...descriptor.value.geometry }, resize }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  event.preventDefault()
}
function move(event: PointerEvent) {
  if (!gesture || gesture.id !== event.pointerId || !descriptor.value) return
  const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y
  updateWindowGeometry(descriptor.value, gesture.resize
    ? { ...gesture.initial, width: gesture.initial.width + dx, height: gesture.initial.height + dy }
    : { ...gesture.initial, x: gesture.initial.x + dx, y: gesture.initial.y + dy })
}
function end() { gesture = null; if (descriptor.value) saveWindowGeometry(descriptor.value) }
function arrow(event: KeyboardEvent, resize = false) {
  if (event.target !== event.currentTarget || !descriptor.value || maximized.value) return
  const delta = event.shiftKey ? 40 : 10
  const dx = event.key === "ArrowLeft" ? -delta : event.key === "ArrowRight" ? delta : 0
  const dy = event.key === "ArrowUp" ? -delta : event.key === "ArrowDown" ? delta : 0
  if (!dx && !dy) return
  event.preventDefault()
  const g = descriptor.value.geometry
  updateWindowGeometry(descriptor.value, resize ? { ...g, width: g.width + dx, height: g.height + dy } : { ...g, x: g.x + dx, y: g.y + dy })
  saveWindowGeometry(descriptor.value)
}
function resizeViewport() {
  if (!descriptor.value) return
  updateWindowGeometry(descriptor.value, maximized.value ? { x: 12, y: 12, width: window.innerWidth, height: window.innerHeight } : descriptor.value.geometry)
}
function maximize() {
  if (!descriptor.value) return
  if (maximized.value && restored) updateWindowGeometry(descriptor.value, restored)
  else { restored = { ...descriptor.value.geometry }; updateWindowGeometry(descriptor.value, { x: 12, y: 12, width: window.innerWidth, height: window.innerHeight }) }
  maximized.value = !maximized.value
}
function keydown(event: KeyboardEvent) {
  if (event.altKey && event.code === "Backquote") { event.preventDefault(); cycleSpatialWindow(props.workspaceId, event.shiftKey) }
  else if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing) { event.stopPropagation(); emit("close") }
}
onMounted(() => { register(); window.addEventListener("resize", resizeViewport) })
watch(() => [props.windowId, props.workspaceId], () => { maximized.value = false; restored = null; register() })
onBeforeUnmount(() => { window.removeEventListener("resize", resizeViewport); if (descriptor.value) unregisterSpatialWindow(descriptor.value) })
</script>

<template>
  <Teleport :to="host">
    <section v-if="!duplicate" ref="root" class="dialog spatial-window" role="dialog" :aria-label="ariaLabel ?? title" tabindex="-1"
      :data-window-id="windowId" :style="style" @pointerdown.capture="raise" @focusin="raise" @keydown="keydown">
      <header class="spatial-titlebar" tabindex="0" :aria-label="`Move ${title}: arrow keys`"
        @pointerdown="start($event)" @pointermove="move" @pointerup="end" @pointercancel="end" @lostpointercapture="end" @keydown="arrow($event)">
        <div class="spatial-heading"><slot name="header"><strong>{{ title }}</strong></slot></div>
        <div class="spatial-controls">
          <button class="icon-button" type="button" aria-label="Next window" @click="cycleSpatialWindow(workspaceId)">⇥</button>
          <button class="icon-button" type="button" :aria-label="maximized ? 'Restore window size' : 'Maximize window'" @click="maximize">{{ maximized ? '↙' : '↗' }}</button>
          <button class="icon-button" type="button" :aria-label="closeLabel" @click="emit('close')">×</button>
        </div>
      </header>
      <div class="spatial-body"><slot /></div>
      <button class="spatial-resize" type="button" :aria-label="resizeLabel ?? `Resize ${title}: arrow keys`" :disabled="maximized"
        @pointerdown="start($event, true)" @pointermove="move" @pointerup="end" @pointercancel="end" @lostpointercapture="end" @keydown="arrow($event, true)">◢</button>
    </section>
  </Teleport>
</template>

<style scoped>
.spatial-window { padding: 0; max-width: none; max-height: none; position: absolute; display: flex; flex-direction: column; pointer-events: auto; min-width: 0; min-height: 0; background: var(--panel, white); color: var(--ink, #171717); border: 2px solid var(--line, #171717); box-shadow: 6px 6px 0 var(--ink, #171717); overflow: hidden; }
.spatial-window:focus-within { border-color: var(--blue, #165be0); }
.spatial-titlebar { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex: none; padding: 8px 12px; min-height: 52px; border-bottom: 2px solid var(--line, #171717); background: var(--soft, #eee); touch-action: none; user-select: none; cursor: grab; }
.spatial-heading { min-width: 0; overflow: hidden; overflow-wrap: anywhere; }
.spatial-controls { display: flex; flex: none; gap: 4px; }
.spatial-controls button { min-width: 44px; min-height: 44px; }
.spatial-body { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; }
.spatial-resize { position: absolute; bottom: 0; right: 0; width: 44px; height: 44px; padding: 16px 2px 2px 16px; background: transparent; border: 0; color: var(--muted, #666); cursor: nwse-resize; touch-action: none; user-select: none; }
.spatial-resize:disabled { visibility: hidden; }
@media (max-width: 600px) { .spatial-window { left: 6px !important; top: 6px !important; width: calc(100vw - 12px) !important; height: calc(100dvh - 12px) !important; } .spatial-titlebar { cursor: default; } .spatial-resize { display: none; } }
</style>
