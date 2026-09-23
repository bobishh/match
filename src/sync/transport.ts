import type { GossipStateMachine } from "@meta-uber/mesh-replication"

export type DuplexStream = {
  send: (bytes: Uint8Array) => Promise<void>
  read: () => Promise<Uint8Array>
  closeSend: () => Promise<void>
}

export type SyncConnection = {
  readonly remoteEndpointId?: string
  openStream: () => Promise<DuplexStream>
  acceptStream: () => Promise<DuplexStream>
  close: () => Promise<void>
}

export type SyncAcceptor = {
  accept: () => Promise<SyncConnection | undefined>
  close: () => Promise<void>
}

export type SyncNode = {
  endpointId: string
  createGossipEngine: () => GossipStateMachine
  dial: (remoteEndpoint: string) => Promise<SyncConnection>
  dialRelay?: (remoteEndpoint: string) => Promise<SyncConnection>
  accept: () => Promise<SyncAcceptor>
  close: (reason?: string) => Promise<void>
}

export type SyncTransport = {
  start: (secret?: Uint8Array) => Promise<SyncNode>
}
