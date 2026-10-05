import { onMounted, onScopeDispose, watch, type Ref } from "vue"

type Presence = "connected" | "reconnecting" | "offline" | "empty"
type Frames = Record<Presence | "dim", string>

/** Reuse the header's presence state; animate only while reconnecting. */
export function useMeshFavicon(presence: Readonly<Ref<Presence>>) {
  let icon: HTMLLinkElement | null = null
  let original: string | null = null
  let frames: Frames | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let motion: MediaQueryList | undefined
  const load = new AbortController()
  const stopBlink = () => { clearInterval(timer); timer = undefined }
  const paint = (href: string) => { if (icon && icon.getAttribute("href") !== href) icon.setAttribute("href", href) }
  const render = () => {
    stopBlink()
    if (!frames) return
    paint(frames[presence.value])
    if (presence.value !== "reconnecting" || motion?.matches) return
    let dim = false
    timer = setInterval(() => { dim = !dim; paint(frames![dim ? "dim" : "reconnecting"]) }, 500)
  }
  watch(presence, render)
  onMounted(async () => {
    icon = document.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]')
    original = icon?.getAttribute("href") ?? null
    if (!original) return
    motion = window.matchMedia("(prefers-reduced-motion: reduce)")
    motion.addEventListener("change", render)
    try {
      const response = await fetch(original, { signal: load.signal })
      if (!response.ok) return
      const source = await response.text()
      if (load.signal.aborted) return
      frames = presenceFrames(source)
      render()
    } catch { /* Keep the static icon if the optional animation cannot load. */ }
  })
  onScopeDispose(() => {
    load.abort()
    stopBlink()
    motion?.removeEventListener("change", render)
    if (icon && original) icon.setAttribute("href", original)
  })
}

function presenceFrames(source: string): Frames {
  const svg = new DOMParser().parseFromString(source, "image/svg+xml")
  const interior = svg.querySelector("[data-connection-fill]")
  if (!interior || svg.querySelector("parsererror")) throw new Error("Invalid favicon")
  const styles = getComputedStyle(document.documentElement)
  const color = (name: string, fallback: string) => styles.getPropertyValue(`--${name}`).trim() || fallback
  const frame = (fill: string) => {
    interior.setAttribute("fill", fill)
    return `data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`
  }
  const yellow = frame(color("yellow", "#ffd43b"))
  return { connected: frame(color("green", "#69db7c")), reconnecting: yellow, empty: yellow,
    offline: frame(color("red", "#ff5a36")), dim: frame(color("paper", "#f3f0e8")) }
}
