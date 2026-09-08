export const pairingVersion = "0.0.1"

export type PairingInvite = {
  version: string
  endpoint: string
  secret: string
}

export type PairingFrameType = "sync-request" | "sync-response" | "sync-ack"

export class PairingError extends Error {}

function encodeBase64Url(bytes: Uint8Array) {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

export function createPairingSecret(random = crypto.getRandomValues.bind(crypto)) {
  const bytes = new Uint8Array(32)
  random(bytes)
  return encodeBase64Url(bytes)
}

export function createPairingInvite(endpoint: string, secret: string): PairingInvite {
  return { version: pairingVersion, endpoint, secret }
}

export function pairingInviteUrl(origin: string, invite: PairingInvite) {
  const url = new URL("/pair", origin)
  url.hash = new URLSearchParams({ v: invite.version, endpoint: invite.endpoint, secret: invite.secret }).toString()
  return url.toString()
}

export function parsePairingInvite(raw: string): PairingInvite {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new PairingError("Invalid pairing link")
  }

  const params = url.protocol === "match:" && url.hostname === "pair"
    ? url.searchParams
    : url.pathname.replace(/\/$/, "") === "/pair" && url.hash
      ? new URLSearchParams(url.hash.slice(1))
      : undefined

  if (!params) throw new PairingError("Invalid pairing link")
  const version = params.get("v") ?? ""
  const endpoint = params.get("endpoint") ?? ""
  const secret = params.get("secret") ?? ""
  if (version !== pairingVersion || !endpoint || !secret) throw new PairingError("Invalid pairing link")
  return { version, endpoint, secret }
}

export function encodePairingFrame(type: PairingFrameType, secret: string, bytes: Uint8Array) {
  const header = new TextEncoder().encode(`${JSON.stringify({ type, version: pairingVersion, secret })}\n`)
  const frame = new Uint8Array(header.length + bytes.length)
  frame.set(header)
  frame.set(bytes, header.length)
  return frame
}

export function decodePairingFrame(frame: Uint8Array, expectedType: PairingFrameType, expectedSecret: string) {
  const separator = frame.indexOf(10)
  if (separator < 0) throw new PairingError("Pairing frame missing")

  let header: { type?: string; version?: string; secret?: string }
  try {
    header = JSON.parse(new TextDecoder().decode(frame.slice(0, separator)))
  } catch {
    throw new PairingError("Pairing frame invalid")
  }

  if (header.type !== expectedType || header.version !== pairingVersion || header.secret !== expectedSecret) {
    throw new PairingError("Pairing authorization failed")
  }
  return frame.slice(separator + 1)
}
