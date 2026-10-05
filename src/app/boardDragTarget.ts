export type DropMarker = { targetId: string; beforeId: string | null; vertical?: boolean }
export type MarkerPosition = { x: number; y: number; width: number; height?: number; vertical?: boolean }
export type DragTarget = { marker: DropMarker; position: MarkerPosition }
export type DragHit = { id: string; kind: "item" | "column"; source: HTMLElement; x: number; y: number }

export function findDragTarget(drag: DragHit, board: HTMLElement): DragTarget | null {
  const columns = [...board.querySelectorAll<HTMLElement>(":scope > .column[data-column-id]")]
  const hovered = columns.find(column => inside(column, drag.x, drag.y))
  if (!hovered) return null
  return drag.kind === "column" ? columnTarget(drag, board, columns, hovered) : cardTarget(drag, hovered)
}

function columnTarget(drag: DragHit, board: HTMLElement, columns: HTMLElement[], hovered: HTMLElement): DragTarget {
  const siblings = columns.filter(column => column !== drag.source)
  const before = siblings.find(column => drag.x < center(column.getBoundingClientRect().left, column.getBoundingClientRect().right))
  const bounds = hovered.getBoundingClientRect()
  return {
    marker: { targetId: hovered.dataset.columnId!, beforeId: before?.dataset.columnId ?? null, vertical: true },
    position: { x: before?.getBoundingClientRect().left ?? board.getBoundingClientRect().right - 4, y: bounds.top, width: 4, height: bounds.height, vertical: true },
  }
}

function cardTarget(drag: DragHit, column: HTMLElement): DragTarget | null {
  const stack = column.querySelector<HTMLElement>(".card-stack[data-column-id]")
  if (!stack) return archiveTarget(column)
  const bounds = stack.getBoundingClientRect()
  const cards = [...stack.querySelectorAll<HTMLElement>(":scope > .lead-card[data-item-id]")].filter(card => card !== drag.source)
  const before = cards.find(card => drag.y < center(card.getBoundingClientRect().top, card.getBoundingClientRect().bottom))
  return {
    marker: { targetId: stack.dataset.columnId!, beforeId: before?.dataset.itemId ?? null },
    position: { x: bounds.left + 14, y: before ? before.getBoundingClientRect().top - 3 : cards.at(-1)?.getBoundingClientRect().bottom ?? bounds.top + 72, width: Math.max(0, bounds.width - 28) },
  }
}

function archiveTarget(column: HTMLElement): DragTarget | null {
  if (!column.classList.contains("bin-column")) return null
  const bounds = column.getBoundingClientRect()
  return { marker: { targetId: column.dataset.columnId!, beforeId: null }, position: { x: bounds.left + 14, y: bounds.bottom - 4, width: Math.max(0, bounds.width - 28) } }
}

function inside(element: HTMLElement, x: number, y: number) {
  const bounds = element.getBoundingClientRect()
  return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom
}
function center(start: number, end: number) { return start + (end - start) / 2 }
