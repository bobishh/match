import { readLocal, writeLocal } from "../localDb"

export type OwnerKeeper = { personId: string; role: "visitor" | "editor" }
const key = (ownerPersonId: string) => `match.owner-keepers.v1:${ownerPersonId}`

export async function ownerKeepers(ownerPersonId: string): Promise<OwnerKeeper[]> {
  const raw = await readLocal(key(ownerPersonId))
  if (!raw) return []
  let value: unknown
  try { value = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(value)) return []
  const records = value as OwnerKeeper[]
  return records.filter(record => !!record && typeof record.personId === "string" &&
    (record.role === "visitor" || record.role === "editor"))
}

export async function saveOwnerKeeper(ownerPersonId: string, keeper: OwnerKeeper) {
  const records = await ownerKeepers(ownerPersonId)
  await writeLocal(key(ownerPersonId), JSON.stringify([...records.filter(record => record.personId !== keeper.personId), keeper]))
}
