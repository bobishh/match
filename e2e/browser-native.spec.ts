import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import * as Automerge from "@automerge/automerge"
import { expect, test } from "@playwright/test"
import { profileFromIdentitySeedForDevice, signEnvelope } from "@meta-uber/mesh-identity"
import { encodePairingFrame } from "@meta-uber/mesh-pairing"
import { createPeerAdvertisement, createWorkspaceDeviceRevocation, createWorkspaceGrant } from "@meta-uber/mesh-workspace"
import "../src/testSetup"

test("Given a signed editor and native Rust peer, when they sync and revoke access, then documents converge and further access is denied", async ({ page }) => {
  test.setTimeout(180_000)
  const workspaceId = "browser-native-e2e"
  const secret = "browser-native-e2e-secret"
  const owner = await profileFromIdentitySeedForDevice(new Uint8Array(32).fill(1), "Owner", new Uint8Array(32).fill(2))
  const editor = await profileFromIdentitySeedForDevice(new Uint8Array(32).fill(3), "Editor", new Uint8Array(32).fill(4))
  const grant = await createWorkspaceGrant(owner, workspaceId, editor.identity.personId, "editor")
  const authority = { personId: owner.identity.personId, publicKey: owner.identity.publicKey, certificates: [owner.certificate] }
  const snapshot = {
    workspaceId, genesisOwner: authority, genesisEpoch: 1, expectedCurrentOwner: authority,
    document: Array.from(Automerge.save(Automerge.from({ native: "from-rust" }))),
    ownershipTransfers: [], successionClaims: [], revocations: [], deviceRevocations: [], departures: [],
  }
  const native = spawn("cargo", ["run", "--locked", "--manifest-path", "crates/meta-mesh-native/Cargo.toml", "--example", "browser_document_probe"], {
    cwd: "vendor/meta-mesh", detached: true, stdio: "pipe",
  }) as ChildProcessWithoutNullStreams
  try {
    native.stdin.write(`${JSON.stringify({ secret, snapshot })}\n`)
    const endpoint = await new Promise<string>((resolve, reject) => {
      let output = ""
      let errors = ""
      const timer = setTimeout(() => reject(new Error(`Native peer startup timed out: ${errors}`)), 120_000)
      native.stdout.on("data", chunk => {
        output += String(chunk)
        const match = output.match(/\b[0-9a-f]{64}\b/)
        if (match) { clearTimeout(timer); resolve(match[0]) }
      })
      native.stderr.on("data", chunk => { errors += String(chunk) })
      native.on("exit", code => { clearTimeout(timer); reject(new Error(`Native peer exited ${code}: ${errors}`)) })
      native.on("error", error => { clearTimeout(timer); reject(error) })
    })
    await page.exposeFunction("signedHandshake", async (remoteEndpoint: string, withGrant: boolean) => {
      const peer = await createPeerAdvertisement(editor, workspaceId, remoteEndpoint, {
        ...(withGrant ? { grant } : {}), ownerPublicKey: owner.identity.publicKey,
        ownerCertificates: [owner.certificate], instanceId: "browser-tab",
      })
      const payload = { workspaceId, peer, revocations: [], ownershipTransfers: [], successionVotes: [], successionClaims: [],
        capabilities: ["iroh-gossip-v1", "automerge-sync-v1", "device-revocation-v1"] }
      return { frame: Array.from(encodePairingFrame("mesh-handshake-request", secret,
        new TextEncoder().encode(JSON.stringify(payload)))), payload }
    })
    await page.exposeFunction("syncFrameHasChanges", (message: number[]) =>
      Automerge.decodeSyncMessage(Uint8Array.from(message)).changes.length > 0)
    await page.exposeFunction("revokeEditor", async (documentBytes: number[]) => {
      const document = Automerge.load(Uint8Array.from(documentBytes))
      const revocation = await createWorkspaceDeviceRevocation(owner, workspaceId,
        editor.identity.personId, editor.device.deviceId, Automerge.getHeads(document), [owner.certificate])
      const updated = { ...snapshot, document: documentBytes,
        deviceRevocations: [{ record: revocation.record, signer: revocation.authority }] }
      const acknowledgement = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Native authority update timed out")), 10_000)
        const onData = (chunk: Uint8Array) => {
          if (String(chunk).includes("authority-updated")) {
            clearTimeout(timer)
            native.stdout.off("data", onData)
            resolve()
          }
        }
        native.stdout.on("data", onData)
      })
      native.stdin.write(`${JSON.stringify(updated)}\n`)
      await acknowledgement
      return updated
    })
    await page.goto("/")
    const browserDocument = Automerge.from({ browser: "from-wasm" })
    const source = Automerge.save(browserDocument)
    const hashes = Automerge.getAllChanges(browserDocument).map(change => Automerge.decodeChange(change).hash)
    const signed = await signEnvelope(editor.privateKeys.devicePrivateKey, {
      kind: "workspace-changes", version: 1, workspaceId, hashes,
      personId: editor.identity.personId, deviceId: editor.device.deviceId,
    }, editor.device.deviceId)
    const proof = [{ signed, publicKey: editor.identity.publicKey, certificates: [editor.certificate], grant }]
    const result = await page.evaluate(async ({ remote, bytes, localDeviceId, snapshot, proof }) => {
      const { startIrohBrowserNode } = await import("/src/iroh.ts")
      const { meshRustRuntime } = await import("/vendor/meta-mesh/packages/mesh-replication/src/runtime.ts")
      const { WasmMeshAuthenticatedSessions } = await import("/vendor/meta-mesh/packages/mesh-transport/wasm/meta_mesh.js")
      const signedHandshake = (globalThis as typeof globalThis & {
        signedHandshake: (endpoint: string, withGrant: boolean) => Promise<{ frame: number[]; payload: unknown }>
      }).signedHandshake
      const revokeEditor = (globalThis as typeof globalThis & {
        revokeEditor: (documentBytes: number[]) => Promise<unknown>
      }).revokeEditor
      const syncFrameHasChanges = (globalThis as typeof globalThis & {
        syncFrameHasChanges: (message: number[]) => Promise<boolean>
      }).syncFrameHasChanges
      const node = await startIrohBrowserNode()
      const sessions = new WasmMeshAuthenticatedSessions()
      const engine = meshRustRuntime().createAutomergeSyncEngine(localDeviceId)
      engine.loadDocument("browser-native-e2e", "document", Uint8Array.from(bytes))
      try {
        const connection = await node.dialRelay(remote)
        const rpc = async (request: unknown) => {
          const stream = await connection.openStream()
          await stream.send(new TextEncoder().encode(JSON.stringify(request)))
          await stream.closeSend()
          const response = JSON.parse(new TextDecoder().decode(await stream.read()))
          if (response.error) throw new Error(response.error)
          return response
        }
        const deniedRead = await rpc({ kind: "read" }).then(() => "accepted", error => String(error.message))
        if (deniedRead !== "Unauthenticated mesh peer") throw new Error(`Unknown peer: ${deniedRead}`)
        const unsigned = await signedHandshake(node.endpointId, false)
        let wasmDenied = false
        try { meshRustRuntime().state.admitMeshPeer(unsigned.payload, snapshot, node.endpointId, Date.now()) }
        catch { wasmDenied = true }
        if (!wasmDenied) throw new Error("WASM admitted peer without grant")
        const noGrant = await rpc({ kind: "handshake", frame: unsigned.frame })
          .then(() => "accepted", error => String(error.message))
        if (noGrant === "accepted") throw new Error("Peer without grant was admitted")
        const signed = await signedHandshake(node.endpointId, true)
        const wasmAdmission = meshRustRuntime().state.admitMeshPeer(signed.payload, snapshot, node.endpointId, Date.now())
        if (wasmAdmission.deviceId !== localDeviceId || wasmAdmission.role !== "editor") throw new Error("WASM admission diverged")
        sessions.admit(signed.payload, snapshot, node.endpointId, Date.now())
        if (sessions.peer("browser-native-e2e", node.endpointId)?.deviceId !== localDeviceId) throw new Error("WASM session registry lost admitted peer")
        const admission = await rpc({ kind: "handshake", frame: signed.frame })
        if (admission.deviceId !== localDeviceId) throw new Error("Wrong admitted device")
        let frame = engine.generate("document", remote, true, proof)
        if (!frame) throw new Error("Missing initial sync frame")
        const forged = { ...frame, fromDeviceId: "forged-device", message: Array.from(frame.message) }
        const forgedReply = await rpc({ kind: "sync", frame: forged }).then(() => "accepted", error => String(error.message))
        if (forgedReply !== "Mesh document sender does not match admitted peer") throw new Error(`Forged frame: ${forgedReply}`)
        let converged = false
        let unsignedDenied = false
        for (let round = 0; round < 16; round += 1) {
          if (!unsignedDenied && await syncFrameHasChanges(Array.from(frame.message))) {
            const unsignedFrame = { ...frame, proof: null, message: Array.from(frame.message) }
            const denied = await rpc({ kind: "sync", frame: unsignedFrame }).then(() => "accepted", error => String(error.message))
            if (denied !== "Missing workspace change authorization") throw new Error(`Unsigned native change: ${denied}`)
            unsignedDenied = true
          }
          const response = await rpc({ kind: "sync", frame: { ...frame, message: Array.from(frame.message) } })
          const next = response.response
            ? engine.receive(remote, { ...response.response, message: Uint8Array.from(response.response.message) }, true, proof).response
            : engine.generate("document", remote, true, proof)
          if (!next) { converged = true; break }
          frame = next
        }
        if (!converged) throw new Error("Automerge sync did not converge")
        if (!unsignedDenied) throw new Error("Native peer did not exercise unsigned change rejection")
        const native = await rpc({ kind: "read" })
        const revokedSnapshot = await revokeEditor(native.document)
        const evicted = sessions.refresh(revokedSnapshot, Date.now())
        if (evicted.length !== 1 || evicted[0] !== node.endpointId || sessions.peer("browser-native-e2e", node.endpointId) !== null) {
          throw new Error("WASM session registry retained revoked device")
        }
        let wasmRevoked = false
        try { meshRustRuntime().state.admitMeshPeer(signed.payload, revokedSnapshot, node.endpointId, Date.now()) }
        catch { wasmRevoked = true }
        if (!wasmRevoked) throw new Error("WASM retained revoked device")
        const deniedAfterRevocation = await rpc({ kind: "read" }).then(() => "accepted", error => String(error.message))
        if (deniedAfterRevocation !== "Unauthenticated mesh peer") throw new Error(`Revoked peer: ${deniedAfterRevocation}`)
        const revokedHandshake = await rpc({ kind: "handshake", frame: signed.frame })
          .then(() => "accepted", error => String(error.message))
        if (revokedHandshake !== "Mesh peer access is revoked") throw new Error(`Revoked handshake: ${revokedHandshake}`)
        await connection.close()
        return { browser: Array.from(engine.saveDocument("document")), native: native.document }
      } finally {
        await node.close("probe complete")
      }
    }, { remote: endpoint, bytes: Array.from(source), localDeviceId: editor.device.deviceId, snapshot, proof })
    for (const [side, bytes] of Object.entries(result)) {
      const doc = Automerge.load(Uint8Array.from(bytes))
      expect(String(doc.browser), `${side} browser content`).toBe("from-wasm")
      expect(String(doc.native), `${side} native content`).toBe("from-rust")
    }
  } finally {
    if (native.pid) {
      try { process.kill(-native.pid, "SIGINT") } catch { /* Already stopped. */ }
    }
  }
})
