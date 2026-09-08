import { describe, expect, it } from "vitest"
import { PairingError, createPairingInvite, decodePairingFrame, encodePairingFrame, pairingInviteUrl, parsePairingInvite } from "./protocol"

describe("pairing protocol", () => {
  it("Given a pairing link, when parsed, then it preserves the endpoint and secret", () => {
    const invite = createPairingInvite("endpoint-a", "secret-a")

    expect(parsePairingInvite(pairingInviteUrl("https://match.example", invite))).toEqual(invite)
  })

  it("Given an empty stream, when decoded, then it rejects before merge", () => {
    expect(() => decodePairingFrame(new Uint8Array(), "sync-request", "secret-a")).toThrow(PairingError)
  })

  it("Given a wrong secret, when decoded, then it rejects before merge", () => {
    const frame = encodePairingFrame("sync-request", "wrong-secret", new Uint8Array([1]))

    expect(() => decodePairingFrame(frame, "sync-request", "secret-a")).toThrow("Pairing authorization failed")
  })
})
