import * as Automerge from "@automerge/automerge/slim"
import type { WorkspaceDocumentV2 } from "./domain/model"

type Entities = WorkspaceDocumentV2["entities"]

/** Cache only within one read operation, while the owning document remains alive. */
export function createWorkspaceViewReader(document: Automerge.Doc<WorkspaceDocumentV2>) {
  const views = new Map<string, Automerge.Doc<WorkspaceDocumentV2>>()
  return (heads: string[]) => {
    const key = [...heads].sort().join(",")
    let view = views.get(key)
    if (!view) { view = Automerge.view(document, heads); views.set(key, view) }
    return view
  }
}

/** Read the same conflict winners as view(), without materializing unrelated entities. */
export function workspaceEntitiesAtHeads(document: Automerge.Doc<WorkspaceDocumentV2>, heads: string[]): Entities {
  // Keep the low-level API confined here. Historical reads and materialization
  // must use identical heads; latest object IDs are unsafe after map replacement.
  const backend = Automerge.getBackend(document)
  const map = backend.getWithType("_root", "entities", heads)
  if (!map) return Object.create(null) as Entities
  if (map[0] !== "map") throw new Error("Invalid historical workspace entity map")
  const mapId = map[1]
  const cache = new Map<string, Entities[string] | undefined>()
  const read = (id: string) => {
    if (cache.has(id)) return cache.get(id)
    const value = backend.getWithType(mapId, id, heads)
    const entity = !value ? undefined : ["map", "list", "text", "table"].includes(value[0])
      ? backend.materialize(value[1] as string, heads) : value[1]
    cache.set(id, entity as Entities[string] | undefined)
    return cache.get(id)
  }
  return new Proxy(Object.create(null) as Entities, {
    get: (_, key) => typeof key === "string" ? read(key) : undefined,
    ownKeys: () => backend.keys(mapId, heads),
    getOwnPropertyDescriptor: (_, key) => typeof key === "string" && backend.getWithType(mapId, key, heads)
      ? { configurable: true, enumerable: true, value: read(key) } : undefined,
  })
}
