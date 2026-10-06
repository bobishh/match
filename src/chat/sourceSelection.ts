import { MAX_QUOTE_CONTEXT, MAX_QUOTE_LENGTH, resolveAnchorSelection, type Anchor, type AnchorSelection } from "./context"

export type SelectedSource = { itemId: string; fieldId: string; selection: AnchorSelection; x: number; y: number }
export function captureSelectedSource(): SelectedSource | null {
  const selected = window.getSelection()
  if (!selected || selected.isCollapsed || !selected.rangeCount) return null
  const range = selected.getRangeAt(0)
  const source = selectedSource(range)
  const owner = source?.closest<HTMLElement>("[data-discussion-item]")
  if (!source || !owner) return null
  const exact = range.toString()
  if (!exact.trim() || exact.length > MAX_QUOTE_LENGTH || !owner.dataset.discussionItem || !source.dataset.discussionField) return null
  const before = document.createRange()
  before.selectNodeContents(source)
  before.setEnd(range.startContainer, range.startOffset)
  const text = source.textContent ?? ""
  const start = before.toString().length, end = start + exact.length
  const rect = range.getBoundingClientRect()
  return { itemId: owner.dataset.discussionItem, fieldId: source.dataset.discussionField,
    selection: { exact, prefix: text.slice(Math.max(0, start - MAX_QUOTE_CONTEXT), start), suffix: text.slice(end, end + MAX_QUOTE_CONTEXT), start, end },
    x: Math.max(8, Math.min(rect.left, window.innerWidth - 150)), y: Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 52)) }
}
function selectedSource(range: Range) {
  const element = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement
  let source = element?.closest<HTMLElement>("[data-discussion-text]")
  while (source && !source.contains(range.endContainer)) source = source.parentElement?.closest<HTMLElement>("[data-discussion-text]")
  return source
}
export function findSourceOwner(itemId: string) {
  return document.querySelector<HTMLElement>(`[data-window-id] [data-discussion-item="${CSS.escape(itemId)}"]`)?.closest<HTMLElement>("[data-window-id]")
}
function sourceRange(source: HTMLElement, start: number, end: number): Range | undefined {
  const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let offset = 0, node = walker.nextNode(), started = false
  while (node) {
    const length = node.textContent?.length ?? 0
    if (!started && start >= offset && start < offset + length) { range.setStart(node, start - offset); started = true }
    if (started && end <= offset + length) { range.setEnd(node, end - offset); return range }
    offset += length; node = walker.nextNode()
  }
}
function clearMarks(source: HTMLElement) {
  source.querySelectorAll("mark[data-reference-highlight]").forEach(mark => mark.replaceWith(...mark.childNodes))
  source.normalize()
}
function markSelection(source: HTMLElement, selection: AnchorSelection): boolean {
  const resolution = resolveAnchorSelection(source.textContent ?? "", selection)
  if (!("start" in resolution)) return false
  const range = sourceRange(source, resolution.start, resolution.end)
  if (!range) return false
  const mark = document.createElement("mark")
  mark.dataset.referenceHighlight = "true"
  mark.append(range.extractContents()); range.insertNode(mark)
  mark.scrollIntoView({ block: "center" })
  return true
}
export function createSourceHighlighter(setState: (state: string) => void) {
  let observer: MutationObserver | undefined
  let highlightedSource: HTMLElement | undefined
  let frame = 0
  function clear() {
    observer?.disconnect(); observer = undefined
    cancelAnimationFrame(frame); frame = 0
    if (highlightedSource?.isConnected) clearMarks(highlightedSource)
    highlightedSource = undefined
  }
  function highlight(owner: HTMLElement, anchor: Anchor) {
    clear()
    const update = () => {
      if (!owner.isConnected) return
      const source = owner.querySelector<HTMLElement>(`[data-discussion-field="${CSS.escape(anchor.fieldId!)}"][data-discussion-text]`)
      if (!source) { setState(`Source unavailable${anchor.selection ? ` · ${anchor.selection.exact}` : ""}`); return }
      highlightedSource = source
      if (!anchor.selection) { source.scrollIntoView({ block: "center" }); source.focus({ preventScroll: true }); return }
      observer?.disconnect()
      clearMarks(source)
      const matched = markSelection(source, anchor.selection)
      setState(matched ? "" : `Source changed · ${anchor.selection.exact}`)
      observer?.observe(owner, { childList: true, subtree: true, characterData: true })
    }
    update()
    if (!anchor.selection) return
    observer = new MutationObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(update)
    })
    observer.observe(owner, { childList: true, subtree: true, characterData: true })
  }
  return { clear, highlight }
}
