import type { Board, Column } from "./model"

export type CardStageButton = { columnId: string; label?: string }

export function cardStageButtons(board: Board | null | undefined, columns: Column[]): CardStageButton[] {
  const configured = board?.cardStageButtons ?? columns.map(column => ({ columnId: column.id }))
  const available = new Set(columns.map(column => column.id))
  return configured.filter(button => available.has(button.columnId))
}
