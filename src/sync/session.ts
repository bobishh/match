import { decodePairingFrame, encodePairingFrame, type PairingInvite } from "./protocol"
import type { SyncAcceptor, SyncConnection, SyncNode } from "./transport"

export type WorkspaceReplica = {
  getBytes: () => Uint8Array
  mergeBytes: (bytes: Uint8Array) => Promise<void>
}

type JoinOptions = {
  attempts?: number
  sleep?: (milliseconds: number) => Promise<void>
}

const defaultJoinAttempts = 30
const defaultRetryDelayMs = 500

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds))
}

function retryableDialError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /bootstrap|connection|relay|network/i.test(message)
}

async function dialPairingPeer(node: SyncNode, endpoint: string, options: JoinOptions) {
  const attempts = options.attempts ?? defaultJoinAttempts
  const sleep = options.sleep ?? wait
  let lastError: unknown

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await node.dial(endpoint)
    } catch (error) {
      lastError = error
      if (!retryableDialError(error) || attempt === attempts) throw error
      await sleep(defaultRetryDelayMs)
    }
  }

  throw lastError
}

async function closeConnection(connection: SyncConnection | undefined) {
  await connection?.close()
}

async function closeAcceptor(acceptor: SyncAcceptor | undefined) {
  await acceptor?.close()
}

export async function acceptWorkspaceSync(node: SyncNode, secret: string, workspace: WorkspaceReplica) {
  let acceptor: SyncAcceptor | undefined
  let connection: SyncConnection | undefined
  try {
    acceptor = await node.accept()
    connection = await acceptor.accept()
    if (!connection) throw new Error("Pairing cancelled")

    const request = await connection.acceptStream()
    await workspace.mergeBytes(decodePairingFrame(await request.read(), "sync-request", secret))
    await request.send(encodePairingFrame("sync-response", secret, workspace.getBytes()))
    await request.closeSend()

    const acknowledgement = await connection.acceptStream()
    decodePairingFrame(await acknowledgement.read(), "sync-ack", secret)
    await acknowledgement.closeSend()
  } finally {
    await closeConnection(connection)
    await closeAcceptor(acceptor)
  }
}

export async function joinWorkspaceSync(
  node: SyncNode,
  invite: PairingInvite,
  workspace: WorkspaceReplica,
  options: JoinOptions = {},
) {
  let connection: SyncConnection | undefined
  try {
    connection = await dialPairingPeer(node, invite.endpoint, options)
    const request = await connection.openStream()
    await request.send(encodePairingFrame("sync-request", invite.secret, workspace.getBytes()))
    await request.closeSend()
    await workspace.mergeBytes(decodePairingFrame(await request.read(), "sync-response", invite.secret))

    const acknowledgement = await connection.openStream()
    await acknowledgement.send(encodePairingFrame("sync-ack", invite.secret, new Uint8Array()))
    await acknowledgement.closeSend()
  } finally {
    await closeConnection(connection)
  }
}
