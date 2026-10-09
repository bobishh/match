import { bootstrapIdentity } from "./domain/identity"
import type { PersonalRootDocumentV1 } from "./domain/model"
import { getStorageRaw, setStorageRaw } from "./storageRaw"
import { withLocalStateWriteLock } from "./localStateLock"

const mapKey = "tincanban.v1.personal_roots"
function cloneRoot(root: PersonalRootDocumentV1): PersonalRootDocumentV1 {
  return JSON.parse(JSON.stringify(root)) as PersonalRootDocumentV1
}

function parseMap(raw: string | null): Record<string, PersonalRootDocumentV1> {
  if (!raw) return {}
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Personal root map is invalid.")
  return parsed as Record<string, PersonalRootDocumentV1>
}

function validateMutation(personId: string, current: PersonalRootDocumentV1 | null,
  next: PersonalRootDocumentV1 | null, map: Record<string, PersonalRootDocumentV1>) {
  if (next && next.identity.personId !== personId) throw new Error("Personal root identity changed during update.")
  if (next && current && next.rootId !== current.rootId) throw new Error("Personal root ID changed during update.")
  if (next && !current && map[next.rootId]) throw new Error("Personal root ID is already registered.")
}

export class PersonalRootMapStore {
  constructor(
    private readonly cache: Map<string, PersonalRootDocumentV1>,
    private readonly beforeWrite: () => void,
  ) {}

  private async read() { return parseMap(await getStorageRaw(mapKey)) }

  private replaceCache(map: Record<string, PersonalRootDocumentV1>) {
    this.cache.clear()
    for (const [id, root] of Object.entries(map)) this.cache.set(id, cloneRoot(root))
  }

  private async persist(map: Record<string, PersonalRootDocumentV1>) {
    this.beforeWrite()
    await setStorageRaw(mapKey, JSON.stringify(map))
    this.replaceCache(map)
  }

  async save(root: PersonalRootDocumentV1): Promise<void> {
    await withLocalStateWriteLock(mapKey, async () => {
      const map = await this.read()
      map[root.rootId] = cloneRoot(root)
      await this.persist(map)
    })
  }

  async update(personId: string,
    update: (current: PersonalRootDocumentV1 | null) => PersonalRootDocumentV1 | null | Promise<PersonalRootDocumentV1 | null>,
  ): Promise<PersonalRootDocumentV1 | null> {
    return withLocalStateWriteLock(mapKey, async () => {
      const map = await this.read()
      const current = Object.values(map).find(root => root.identity.personId === personId) ?? null
      const before = current ? cloneRoot(current) : null
      const next = await update(before ? cloneRoot(before) : null)
      validateMutation(personId, current, next, map)
      return this.applyUpdate(map, current, before, next)
    })
  }

  private async applyUpdate(map: Record<string, PersonalRootDocumentV1>, current: PersonalRootDocumentV1 | null,
    before: PersonalRootDocumentV1 | null, next: PersonalRootDocumentV1 | null) {
    if (current && next === null) delete map[current.rootId]
    else if (next) map[next.rootId] = cloneRoot(next)
    if (changed(before, next)) await this.persist(map)
    return next ? cloneRoot(next) : null
  }

  async load(rootId?: string): Promise<PersonalRootDocumentV1 | null> {
    let map: Record<string, PersonalRootDocumentV1>
    try { map = await this.read() }
    catch { map = Object.fromEntries(this.cache) }
    this.replaceCache(map)
    if (rootId) return copyRoot(this.cache.get(rootId))
    const personId = (await bootstrapIdentity()).identity.personId
    return copyRoot([...this.cache.values()].find(root => root.identity.personId === personId))
  }
}

function changed(before: PersonalRootDocumentV1 | null, next: PersonalRootDocumentV1 | null) {
  return before === null ? next !== null : next === null || JSON.stringify(before) !== JSON.stringify(next)
}

function copyRoot(root: PersonalRootDocumentV1 | undefined): PersonalRootDocumentV1 | null {
  return root ? cloneRoot(root) : null
}
