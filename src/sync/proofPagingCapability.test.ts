import { describe, expect, it } from "vitest"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { assertProofPagingNegotiated, supportsProofPaging } from "./proofPagingCapability"

describe("signed join proof paging negotiation", () => {
  it("treats absent legacy capabilities and malformed values as unsupported", () => {
    for (const value of [undefined, null, "proof-paging-v2", {}, [], ["other"]]) {
      expect(supportsProofPaging(value)).toBe(false)
    }
    expect(supportsProofPaging(["proof-paging-v2"])).toBe(true)
  })

  it("allows legacy inline proof bundles without paging", () => {
    const snapshot = meshRustRuntime().state.encodeWorkspaceSet([{ id: "board", bytes: "", authorization: { version: 1, records: [] } }])
    expect(() => assertProofPagingNegotiated(snapshot, ["board"], false)).not.toThrow()
  })

  it("rejects an unnegotiated manifest before installation but accepts negotiated paging", () => {
    const snapshot = meshRustRuntime().state.encodeWorkspaceSet([{ id: "board", bytes: "", authorization: { kind: "workspace-authorization-manifest" } }])
    expect(() => assertProofPagingNegotiated(snapshot, ["board"], false)).toThrow("did not negotiate")
    expect(() => assertProofPagingNegotiated(snapshot, ["board"], true)).not.toThrow()
  })
})
