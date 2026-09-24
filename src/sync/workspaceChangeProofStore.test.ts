import { expect, it } from "vitest"
import { putRecords, records, type WorkspaceChangeAuthorization } from "./workspaceChangeProofStore"

it("repairs a stored proof that predates owner authority fields when the proof is replayed", async () => {
  const workspaceId = `proof-repair-${crypto.randomUUID()}`
  const signed = { signature: "same-proof" }
  const legacy = {
    signed,
    publicKey: "editor-key",
    certificates: [{ signature: "editor-certificate" }],
  } as unknown as WorkspaceChangeAuthorization
  const complete = {
    ...legacy,
    ownerPublicKey: "owner-key",
    ownerCertificates: [{ signature: "owner-certificate" }],
  } as WorkspaceChangeAuthorization

  await putRecords(workspaceId, [legacy])
  await expect(putRecords(workspaceId, [complete])).resolves.toBe(true)
  expect(await records(workspaceId)).toEqual([complete])
})
