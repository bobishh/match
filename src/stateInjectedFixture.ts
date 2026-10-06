import * as Automerge from "@automerge/automerge/slim"
import { hasEntityKind, type Board, type WorkspaceDocumentV2 } from "./domain/model"
import { stateRuntime } from "./stateContext"

type FixtureItem = { id: string; title: string; parentId: string }
type FixtureWindow = Window & { __TINCANBAN_INJECT_FIXTURE__?: { items?: FixtureItem[] } }

export function applyInjectedFixture(updateReactiveState: (doc: Automerge.Doc<WorkspaceDocumentV2>) => void): void {
  const fixture = typeof window === "undefined" ? undefined : (window as FixtureWindow).__TINCANBAN_INJECT_FIXTURE__
  const items = fixture?.items
  if (!items || !stateRuntime.activeDoc) return
  const updated = Automerge.change(stateRuntime.activeDoc, draft => {
    const board = Object.values(draft.entities).find(
      (entity): entity is Board => hasEntityKind(entity, "board"),
    )
    if (!board) return
    board.preset = { key: "blank", version: 1, bindings: {} }
    ensureFixtureColumn(draft, board)
    addFixtureItems(draft, items)
  })
  updateReactiveState(updated)
}

function ensureFixtureColumn(draft: WorkspaceDocumentV2, board: Board): void {
  if (Object.values(draft.entities).some(entity => hasEntityKind(entity, "column") && entity.title === "To do")) return
  const id = crypto.randomUUID()
  draft.entities[id] = { id, kind: "column", title: "To do", placement: { parentId: board.id, rank: "0/1" },
    archivedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
}

function addFixtureItems(draft: WorkspaceDocumentV2, items: FixtureItem[]): void {
  for (const item of items) draft.entities[item.id] = { id: item.id, title: item.title, body: "",
    placement: { parentId: item.parentId, rank: "0/1" }, archivedAt: null, createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), values: {} }
}
