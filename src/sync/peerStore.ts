import { PeerStore as SharedPeerStore } from "@meta-uber/mesh-peer-store"

export * from "@meta-uber/mesh-peer-store"

export class PeerStore extends SharedPeerStore {
  constructor(dbName = "tincanban-peer-catalog-v1", idbFactory?: IDBFactory) {
    super(dbName, idbFactory)
  }
}

export const peerStore = new PeerStore()
