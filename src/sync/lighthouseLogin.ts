import { bootstrapIdentity, type LocalProfile } from "../domain/identity"
import { discoverLighthouse, type LighthouseDiscovery } from "./lighthouseDiscovery"
import { signKeeperControllerRequest, verifyKeeperServiceEnvelope } from "./lighthousePairing"

type LighthouseLoginChallenge = {
  challengeId: string
  nonce: string
  servicePersonId: string
  serviceDeviceId: string
  serviceOrigin: string
  issuedAt: number
  expiresAt: number
}

export type LighthouseLoginRequest = {
  discovery: LighthouseDiscovery
  challenge: LighthouseLoginChallenge
  profile: LocalProfile
}

async function getChallenge(origin: string, challengeId: string): Promise<unknown> {
  const response = await fetch(`${origin}/v1/login/challenges/${encodeURIComponent(challengeId)}`, {
    redirect: "error",
    headers: { Accept: "application/json" },
  })
  const body = await response.json().catch(() => null) as { message?: string } | null
  if (!response.ok) throw new Error(body?.message || `Keeper sign-in challenge failed (${response.status}).`)
  if (!body) throw new Error("Keeper returned an invalid sign-in challenge.")
  return body
}

export async function prepareLighthouseLogin(origin: string, challengeId: string): Promise<LighthouseLoginRequest> {
  if (!challengeId || challengeId.length > 256) throw new Error("Sign-in request is missing a valid challenge.")
  const discovery = await discoverLighthouse(origin, { allowLoopbackHttp: true })
  const envelope = await getChallenge(discovery.origin, challengeId)
  const payload = await verifyKeeperServiceEnvelope(discovery, envelope, "lighthouse-login-challenge") as unknown as LighthouseLoginChallenge
  const now = Math.floor(Date.now() / 1000)
  if (payload.challengeId !== challengeId || typeof payload.nonce !== "string" || !payload.nonce
    || payload.servicePersonId !== discovery.personId || payload.serviceDeviceId !== discovery.deviceId
    || payload.serviceOrigin !== discovery.origin || !Number.isSafeInteger(payload.issuedAt)
    || !Number.isSafeInteger(payload.expiresAt) || payload.issuedAt > now + 60 || payload.expiresAt <= now
    || payload.expiresAt <= payload.issuedAt || payload.expiresAt - payload.issuedAt > 300) {
    throw new Error("Keeper sign-in challenge is expired or does not match this service.")
  }
  return { discovery, challenge: payload, profile: await bootstrapIdentity() }
}

async function postProof(discovery: LighthouseDiscovery, proof: unknown) {
  const response = await fetch(`${discovery.origin}/v1/login/proof`, {
    method: "POST",
    redirect: "error",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(proof),
  })
  const body = await response.json().catch(() => null) as { message?: string; code?: string; redirectUrl?: string } | null
  if (!response.ok) throw new Error(body?.message || `Keeper sign-in failed (${response.status}).`)
  if (!body || typeof body.code !== "string" || typeof body.redirectUrl !== "string") throw new Error("Keeper returned an invalid sign-in response.")
  const redirect = new URL(body.redirectUrl)
  if (redirect.origin !== discovery.origin || redirect.pathname !== "/admin/" || redirect.search
    || redirect.hash !== `#login=${encodeURIComponent(body.code)}`) {
    throw new Error("Keeper returned an unsafe sign-in destination.")
  }
  return redirect.toString()
}

export async function approveLighthouseLogin(request: LighthouseLoginRequest): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  if (request.challenge.expiresAt <= now) throw new Error("Keeper sign-in request expired. Start again from the keeper page.")
  const proof = await signKeeperControllerRequest(request.profile, request.discovery, "lighthouse-login-proof", {
    challengeId: request.challenge.challengeId,
    challengeNonce: request.challenge.nonce,
    issuedAt: now,
    expiresAt: request.challenge.expiresAt,
  })
  return postProof(request.discovery, proof)
}
