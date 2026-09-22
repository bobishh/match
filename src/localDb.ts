import { BrowserMeshStore, MemoryMeshStore } from "@meta-uber/mesh-browser-store"

const store = typeof indexedDB === "undefined"
  ? new MemoryMeshStore()
  : new BrowserMeshStore("match-local-state-v1", ["kv"])

export async function readLocal(key: string): Promise<string | null> {
  return await store.get<string>("kv", key) ?? null
}

export async function writeLocal(key: string, value: string): Promise<void> {
  await store.put("kv", key, value)
}

export async function deleteLocal(key: string): Promise<void> {
  await store.delete("kv", key)
}

export async function listLocalKeys(): Promise<string[]> {
  return (await store.list<string>("kv")).map(item => item.key)
}
