import { nextTick, onBeforeUnmount, watch, type Ref } from "vue"

type Modal = { root: HTMLElement; trigger: HTMLElement | null; close: () => void }
const stack: Modal[] = []
const inertElements = new Map<HTMLElement, { inert: boolean; ariaHidden: string | null }>()
let previousOverflow = ""
let pendingReturnTarget: HTMLElement | null = null
const focusableSelector = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

function focusable(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>(focusableSelector)]
    .filter(el => el.getClientRects().length && !el.closest('[inert], [aria-hidden="true"]'))
}

function focusModal(modal: Modal) {
  const candidates = focusable(modal.root)
  const target = candidates.find(el => el.hasAttribute("autofocus"))
    ?? candidates[0]
    ?? modal.root.querySelector<HTMLElement>('[role="dialog"]')
    ?? modal.root
  if (!target.hasAttribute("tabindex") && !target.matches(focusableSelector)) target.tabIndex = -1
  target.focus({ preventScroll: true })
}

function updateInert() {
  for (const [el, original] of inertElements) {
    el.inert = original.inert
    if (original.ariaHidden === null) el.removeAttribute("aria-hidden")
    else el.setAttribute("aria-hidden", original.ariaHidden)
  }
  inertElements.clear()
  const top = stack.at(-1)
  if (!top) return
  let branch: HTMLElement = top.root
  while (branch.parentElement) {
    for (const sibling of branch.parentElement.children) {
      if (sibling !== branch && sibling instanceof HTMLElement) {
        inertElements.set(sibling, { inert: sibling.inert, ariaHidden: sibling.getAttribute("aria-hidden") })
        sibling.inert = true
        sibling.setAttribute("aria-hidden", "true")
      }
    }
    if (branch.parentElement === document.body) break
    branch = branch.parentElement
  }
}

function onKeydown(event: KeyboardEvent) {
  const top = stack.at(-1)
  if (!top) return
  if (event.key === "Escape") {
    if (event.isComposing) return
    event.preventDefault()
    event.stopPropagation()
    top.close()
  } else if (event.key === "Tab") {
    const targets = focusable(top.root)
    const first = targets[0]
    const last = targets.at(-1)
    if (!first || !top.root.contains(document.activeElement)) {
      event.preventDefault()
      focusModal(top)
    } else if (!targets.includes(document.activeElement as HTMLElement)) {
      event.preventDefault()
      ;(event.shiftKey ? last : first)?.focus()
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
}

function onFocus(event: FocusEvent) {
  const top = stack.at(-1)
  if (top && !top.root.contains(event.target as Node)) focusModal(top)
}

function register(root: HTMLElement, close: () => void) {
  const trigger = pendingReturnTarget ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
  pendingReturnTarget = null
  const modal: Modal = { root, trigger, close }
  if (!stack.length) {
    previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    document.addEventListener("keydown", onKeydown, true)
    document.addEventListener("focusin", onFocus)
  }
  stack.push(modal)
  focusModal(modal)
  updateInert()
  // Steps inside one dialog may replace the focused element entirely.
  const observer = new MutationObserver(() => {
    if (stack.at(-1) === modal && !root.contains(document.activeElement)) focusModal(modal)
  })
  observer.observe(root, { childList: true, subtree: true })
  return () => {
    observer.disconnect()
    const wasTop = stack.at(-1) === modal
    stack.splice(stack.indexOf(modal), 1)
    updateInert()
    if (!stack.length) {
      document.body.style.overflow = previousOverflow
      document.removeEventListener("keydown", onKeydown, true)
      document.removeEventListener("focusin", onFocus)
    }
    if (!wasTop) return
    pendingReturnTarget = trigger
    void nextTick(() => {
      const top = stack.at(-1)
      if (top) {
        if (trigger?.isConnected && top.root.contains(trigger)) trigger.focus({ preventScroll: true })
        else if (!top.root.contains(document.activeElement)) focusModal(top)
      } else if (trigger?.isConnected && (document.activeElement === document.body || root.contains(document.activeElement))) {
        // Do not steal focus if the user already started the next action.
        trigger.focus({ preventScroll: true })
      }
      pendingReturnTarget = null
    })
  }
}

export function hideLeavingElement(element: Element) {
  element.setAttribute("aria-hidden", "true")
  element.setAttribute("inert", "")
}

export function showEnteringElement(element: Element) {
  element.removeAttribute("aria-hidden")
  element.removeAttribute("inert")
}

export function useModal(root: Ref<HTMLElement | null>, close: () => void) {
  let release: (() => void) | undefined
  watch(root, element => {
    release?.()
    release = element ? register(element, close) : undefined
  }, { flush: "post" })
  onBeforeUnmount(() => { release?.(); release = undefined })
}
