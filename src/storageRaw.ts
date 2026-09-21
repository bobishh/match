const persistentStorageBacking = new Map<string, string>()

export function getStorageRaw(key: string): string | null {
  if (typeof localStorage !== "undefined") {
    try {
      return localStorage.getItem(key)
    } catch {
      // Fall back to process-local storage when browser storage is unavailable.
    }
  }
  return persistentStorageBacking.get(key) ?? null
}

export function setStorageRaw(key: string, value: string): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(key, value)
  else persistentStorageBacking.set(key, value)
}

export function removeStorageRaw(key: string): void {
  if (typeof localStorage !== "undefined") localStorage.removeItem(key)
  else persistentStorageBacking.delete(key)
}

export function storageKeys(): string[] {
  if (typeof localStorage === "undefined") return [...persistentStorageBacking.keys()]
  return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .filter((key): key is string => key !== null)
}
