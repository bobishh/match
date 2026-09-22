import { deleteLocal, listLocalKeys, readLocal, writeLocal } from "./localDb"

export const getStorageRaw = readLocal
export const setStorageRaw = writeLocal
export const removeStorageRaw = deleteLocal
export const storageKeys = listLocalKeys
