export type DuplexStream = {
  send: (bytes: Uint8Array) => Promise<void>
  read: () => Promise<Uint8Array>
  closeSend: () => Promise<void>
}

export type SyncConnection = {
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
  dial: (remoteEndpoint: string) => Promise<SyncConnection>
  accept: () => Promise<SyncAcceptor>
  close: (reason?: string) => Promise<void>
}

export type SyncTransport = {
  start: () => Promise<SyncNode>
}
