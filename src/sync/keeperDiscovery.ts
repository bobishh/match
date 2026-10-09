export type KeeperWorkspace = { id: string; title: string }
export type KeeperDiscovery = {
  origin: string
  displayName: string
  personId: string
  publicKey: string
  deviceId: string
  certificates: unknown[]
  fingerprint: string
  capabilities: {
    modes: string[]
    documentReplication: boolean
    chatReplication: boolean
    blobReplication: boolean
    pairing: boolean
  }
}
