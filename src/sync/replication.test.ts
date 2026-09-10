import { describe, it, expect, beforeEach } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { readFile } from "fs/promises"
import {
  ReplicationService,
  type ReplicationScope,
  type BlobChunk,
  MAX_PHYSICAL_FRAME_SIZE,
  MAX_REASSEMBLY_SIZE,
  BLOB_CHUNK_SIZE,
} from "./replication"
import { ProofStore } from "../domain/proofs"

beforeEach(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  await Automerge.initializeBase64Wasm(wasm.toString("base64"))
})

describe("ReplicationService (Gate D)", () => {
  describe("4.1: Native Automerge delta replication", () => {
    it("maintains per-peer per-document sync state and transfers only deltas on live updates", () => {
      const proofStoreA = new ProofStore()
      const proofStoreB = new ProofStore()
      const serviceA = new ReplicationService("peer-A", proofStoreA)
      const serviceB = new ReplicationService("peer-B", proofStoreB)

      // Register peer session with full scope
      serviceA.registerPeer("peer-B", { kind: "all" })
      serviceB.registerPeer("peer-A", { kind: "all" })

      // Create document in A with 50 tasks
      let docA = Automerge.init<{ [key: string]: { title: string; desc: string } }>()
      for (let i = 0; i < 50; i++) {
        docA = Automerge.change(docA, (d) => {
          d[`task_${i}`] = { title: `Task ${i}`, desc: "Description text for realistic task payloads" }
        })
      }
      let docB = Automerge.init<{ [key: string]: { title: string; desc: string } }>()

      const docId = "workspace-1"
      serviceA.trackDocument(docId, docA)
      serviceB.trackDocument(docId, docB)

      // Initial sync exchange loop
      let initialTransferBytes = 0
      let active = true
      while (active) {
        active = false
        const msgA = serviceA.generateSyncMessage("peer-B", docId)
        if (msgA) {
          active = true
          initialTransferBytes += msgA.length
          const { doc } = serviceB.receiveSyncMessage("peer-A", docId, msgA)
          docB = doc
        }
        const msgB = serviceB.generateSyncMessage("peer-A", docId)
        if (msgB) {
          active = true
          initialTransferBytes += msgB.length
          const { doc } = serviceA.receiveSyncMessage("peer-B", docId, msgB)
          docA = doc
        }
      }

      expect(Object.keys(docB).length).toBe(50)
      expect(docB.task_0.title).toBe("Task 0")

      // Now A makes a small edit (updating one field)
      docA = Automerge.change(docA, (d) => {
        d.task_0.title = "Updated title only"
      })
      serviceA.updateDocument(docId, docA)

      // Generate next sync message
      const deltaMsg = serviceA.generateSyncMessage("peer-B", docId)
      expect(deltaMsg).not.toBeNull()

      // The delta must be significantly smaller than the initial transfer bytes (less than 25%)
      expect(deltaMsg!.length).toBeLessThan(initialTransferBytes / 4)

      // Apply delta to B
      const { doc: docB_afterDelta } = serviceB.receiveSyncMessage("peer-A", docId, deltaMsg!)
      docB = docB_afterDelta

      expect(docB.task_0.title).toBe("Updated title only")
    })
  })

  describe("4.2: Scope isolation and live catalog following", () => {
    it("restricts workspace-only guests from accessing or learning about other workspaces", () => {
      const serviceA = new ReplicationService("peer-A", new ProofStore())
      const serviceB = new ReplicationService("peer-B", new ProofStore())

      // Peer B is a guest invited to workspace-1 only
      serviceA.registerPeer("peer-B", { kind: "workspace", workspaceId: "workspace-1" })
      serviceB.registerPeer("peer-A", { kind: "workspace", workspaceId: "workspace-1" })

      // Peer A has workspace-1 and private workspace-2
      let docW1 = Automerge.init<{ title: string }>()
      docW1 = Automerge.change(docW1, (d) => { d.title = "Shared Project" })
      let docW2 = Automerge.init<{ title: string }>()
      docW2 = Automerge.change(docW2, (d) => { d.title = "Secret Personal Board" })

      serviceA.trackDocument("workspace-1", docW1)
      serviceA.trackDocument("workspace-2", docW2)

      // Authorized document negotiation: serviceA advertises allowed documents to peer-B
      const advertisedToB = serviceA.getAdvertisedDocuments("peer-B")
      expect(advertisedToB).toEqual(["workspace-1"])
      expect(advertisedToB).not.toContain("workspace-2")

      // If peer B attempts to request or send sync message for unauthorized workspace-2, serviceA rejects it
      const unauthorizedMsg = new Uint8Array([1, 2, 3])
      expect(() => {
        serviceA.receiveSyncMessage("peer-B", "workspace-2", unauthorizedMsg)
      }).toThrow(/unauthorized/i)
    })

    it("follows live catalog for own devices (kind: all)", () => {
      const serviceA = new ReplicationService("peer-A", new ProofStore())
      serviceA.registerPeer("peer-K", { kind: "all" })

      serviceA.trackDocument("workspace-1", Automerge.init())
      expect(serviceA.getAdvertisedDocuments("peer-K")).toEqual(["workspace-1"])

      // Later, A adds workspace-2 to catalog
      serviceA.trackDocument("workspace-2", Automerge.init())
      expect(serviceA.getAdvertisedDocuments("peer-K")).toContain("workspace-1")
      expect(serviceA.getAdvertisedDocuments("peer-K")).toContain("workspace-2")
    })

    it("tripartite isolation (A/J, A/K, B/L): A's two workspaces reach K; only invited workspace reaches B; future private workspace creation never discloses its ID/title to B", () => {
      const deviceJ = new ReplicationService("peer-A-J", new ProofStore())
      const deviceK = new ReplicationService("peer-A-K", new ProofStore())
      const deviceL = new ReplicationService("peer-B-L", new ProofStore())

      // Own device enrollment: J and K pair with "all"
      deviceJ.registerPeer("peer-A-K", { kind: "all" })
      deviceK.registerPeer("peer-A-J", { kind: "all" })

      // Workspace guest: J invites B/L to workspace-1 only
      deviceJ.registerPeer("peer-B-L", { kind: "workspace", workspaceId: "workspace-1" })
      deviceL.registerPeer("peer-A-J", { kind: "workspace", workspaceId: "workspace-1" })

      // Person A creates two initial workspaces
      let docW1 = Automerge.init<{ title: string }>()
      docW1 = Automerge.change(docW1, (d) => { d.title = "Team Project 1" })
      let docW2 = Automerge.init<{ title: string }>()
      docW2 = Automerge.change(docW2, (d) => { d.title = "Personal Board 2" })

      deviceJ.trackDocument("workspace-1", docW1)
      deviceJ.trackDocument("workspace-2", docW2)

      // K (own device) sees both workspaces
      const docsForK = deviceJ.getAdvertisedDocuments("peer-A-K")
      expect(docsForK).toContain("workspace-1")
      expect(docsForK).toContain("workspace-2")

      // L (external workspace guest) sees only workspace-1
      const docsForL = deviceJ.getAdvertisedDocuments("peer-B-L")
      expect(docsForL).toEqual(["workspace-1"])
      expect(docsForL).not.toContain("workspace-2")

      // Later: Person A creates a new private workspace-3
      let docW3 = Automerge.init<{ title: string }>()
      docW3 = Automerge.change(docW3, (d) => { d.title = "Super Secret Strategy" })
      deviceJ.trackDocument("workspace-3", docW3)

      // K receives workspace-3
      expect(deviceJ.getAdvertisedDocuments("peer-A-K")).toContain("workspace-3")

      // B/L still only sees workspace-1; workspace-3 is never disclosed
      const docsForLAfter = deviceJ.getAdvertisedDocuments("peer-B-L")
      expect(docsForLAfter).toEqual(["workspace-1"])
      expect(docsForLAfter).not.toContain("workspace-3")

      // Even if L attempts to sync workspace-3, it is blocked
      expect(() => {
        deviceJ.receiveSyncMessage("peer-B-L", "workspace-3", new Uint8Array([1]))
      }).toThrow(/unauthorized/i)
    })

    it("fixed workspace sets ({ kind: 'workspaces', workspaceIds }): transfers A+B but excludes C and future D", () => {
      const serviceA = new ReplicationService("peer-A", new ProofStore())

      // Peer B is invited with fixed set: workspace-A and workspace-B
      serviceA.registerPeer("peer-B", {
        kind: "workspaces",
        workspaceIds: ["workspace-A", "workspace-B"],
      })

      // A tracks workspace-A, workspace-B, and unselected workspace-C
      serviceA.trackDocument("workspace-A", Automerge.init())
      serviceA.trackDocument("workspace-B", Automerge.init())
      serviceA.trackDocument("workspace-C", Automerge.init())

      // Advertised documents to peer B contain A and B, but NOT C
      const advertised = serviceA.getAdvertisedDocuments("peer-B")
      expect(advertised).toContain("workspace-A")
      expect(advertised).toContain("workspace-B")
      expect(advertised).not.toContain("workspace-C")

      // Later: A adds future workspace-D
      serviceA.trackDocument("workspace-D", Automerge.init())

      // Peer B still only sees A and B; D is never disclosed
      const advertisedAfter = serviceA.getAdvertisedDocuments("peer-B")
      expect(advertisedAfter).toContain("workspace-A")
      expect(advertisedAfter).toContain("workspace-B")
      expect(advertisedAfter).not.toContain("workspace-D")

      // Attempting to sync C or D throws unauthorized
      expect(() => {
        serviceA.generateSyncMessage("peer-B", "workspace-C")
      }).toThrow(/unauthorized/i)
      expect(() => {
        serviceA.generateSyncMessage("peer-B", "workspace-D")
      }).toThrow(/unauthorized/i)
    })
  })

  describe("4.3: Bounded framing, chunking, and backpressure", () => {
    it("chunks payloads larger than 1 MiB and reassembles correctly up to 32 MiB limit", () => {
      const service = new ReplicationService("peer-A", new ProofStore())

      // Create a payload larger than 1 MiB (e.g. 1.5 MiB)
      const bigPayload = new Uint8Array(1.5 * 1024 * 1024)
      bigPayload.fill(42)

      const chunks = service.chunkPayload("msg-100", bigPayload)
      expect(chunks.length).toBeGreaterThan(1)
      for (const chunk of chunks) {
        expect(chunk.data.length).toBeLessThanOrEqual(MAX_PHYSICAL_FRAME_SIZE)
      }

      // Reassemble chunks
      let reassembled: Uint8Array | null = null
      for (const chunk of chunks) {
        reassembled = service.processChunk("peer-B", chunk)
      }

      expect(reassembled).not.toBeNull()
      expect(reassembled!.length).toBe(bigPayload.length)
      expect(reassembled![0]).toBe(42)
    })

    it("rejects chunks that would exceed 32 MiB reassembly limit", () => {
      const service = new ReplicationService("peer-A", new ProofStore())
      const oversizedChunk: BlobChunk = {
        messageId: "huge-msg",
        index: 0,
        count: 40,
        totalSize: 40 * 1024 * 1024, // 40 MiB > 32 MiB limit
        data: new Uint8Array(100),
      }

      expect(() => {
        service.processChunk("peer-B", oversizedChunk)
      }).toThrow(/oversize/i)
    })
  })

  describe("4.4: Content-addressed blob storage with 256 KiB chunks and SHA-256 validation", () => {
    it("splits blobs into 256 KiB chunks, computes sha256, resumes, and rejects corruption", async () => {
      const service = new ReplicationService("peer-A", new ProofStore())

      // 600 KiB blob (will require 3 chunks: 256k, 256k, 88k)
      const blobBytes = new Uint8Array(600 * 1024)
      for (let i = 0; i < blobBytes.length; i++) {
        blobBytes[i] = i % 256
      }

      const blobInfo = await service.storeBlob("workspace-1", blobBytes)
      expect(blobInfo.chunksCount).toBe(3)
      expect(blobInfo.sha256).toMatch(/^[a-f0-9]{64}$/)

      // Recipient service
      const recipient = new ReplicationService("peer-B", new ProofStore())

      // Transfer chunk 0 and chunk 2 (simulating partial transfer)
      const chunk0 = service.getBlobChunk(blobInfo.sha256, 0)
      const chunk1 = service.getBlobChunk(blobInfo.sha256, 1)
      const chunk2 = service.getBlobChunk(blobInfo.sha256, 2)

      expect(chunk0).not.toBeNull()
      expect(chunk0!.length).toBe(BLOB_CHUNK_SIZE)

      await recipient.receiveBlobChunk(blobInfo.sha256, 0, chunk0!, blobInfo.totalSize, blobInfo.chunksCount)
      await recipient.receiveBlobChunk(blobInfo.sha256, 2, chunk2!, blobInfo.totalSize, blobInfo.chunksCount)

      // Blob should not be ready yet
      expect(recipient.isBlobComplete(blobInfo.sha256)).toBe(false)
      expect(recipient.getMissingBlobChunks(blobInfo.sha256)).toEqual([1])

      // Receive chunk 1
      await recipient.receiveBlobChunk(blobInfo.sha256, 1, chunk1!, blobInfo.totalSize, blobInfo.chunksCount)
      expect(recipient.isBlobComplete(blobInfo.sha256)).toBe(true)

      const retrieved = recipient.getBlob(blobInfo.sha256)
      expect(retrieved).not.toBeNull()
      expect(retrieved!.length).toBe(blobBytes.length)

      // Corrupted chunk verification
      const badChunk = new Uint8Array(chunk1!)
      badChunk[0] = badChunk[0] ^ 0xff // flip bits
      const corruptService = new ReplicationService("peer-C", new ProofStore())
      await corruptService.receiveBlobChunk(blobInfo.sha256, 0, chunk0!, blobInfo.totalSize, blobInfo.chunksCount)
      await corruptService.receiveBlobChunk(blobInfo.sha256, 1, badChunk, blobInfo.totalSize, blobInfo.chunksCount)
      await corruptService.receiveBlobChunk(blobInfo.sha256, 2, chunk2!, blobInfo.totalSize, blobInfo.chunksCount)

      // Complete validation must fail because sha256 mismatch
      expect(corruptService.isBlobComplete(blobInfo.sha256)).toBe(false)
    })
  })

  describe("4.5: Per-workspace document and file progress aggregation", () => {
    it("reports separate document and file status, tracks unavailable local paths, and computes complete sync", async () => {
      const service = new ReplicationService("peer-A", new ProofStore())
      service.registerPeer("peer-B", { kind: "workspace", workspaceId: "workspace-1" })

      let doc = Automerge.init<{ files: string[] }>()
      doc = Automerge.change(doc, (d) => {
        d.files = ["sha256:abc123", "local:///Users/bogdan/file.pdf"]
      })
      service.trackDocument("workspace-1", doc)

      // Register referenced blobs
      service.registerBlobReference("workspace-1", "sha256:abc123", { availableLocally: true, size: 5000 })
      service.registerBlobReference("workspace-1", "local:///Users/bogdan/file.pdf", { availableLocally: false, size: 10000 })

      const progress = service.getProgress("workspace-1", "peer-B")
      expect(progress.documentsSynced).toBe(false) // not yet synchronized
      expect(progress.unavailableLocalPaths).toContain("local:///Users/bogdan/file.pdf")
      expect(progress.everythingSynced).toBe(false)

      // Mark document synced
      service.markDocumentSynchronized("peer-B", "workspace-1")
      // Mark local blob transferred
      service.markBlobTransferred("peer-B", "sha256:abc123")

      const finalProgress = service.getProgress("workspace-1", "peer-B")
      expect(finalProgress.documentsSynced).toBe(true)
      expect(finalProgress.filesPending).toBe(0) // all locally available files transferred
      expect(finalProgress.everythingSynced).toBe(true) // documents synced & all available blobs transferred
    })
  })

  describe("4.7: Gate D evidence & performance baseline", () => {
    it("records first-transfer bytes vs one-edit bytes, doc load time, and peak memory on fixed fixture", () => {
      const serviceA = new ReplicationService("bench-A", new ProofStore())
      const serviceB = new ReplicationService("bench-B", new ProofStore())

      serviceA.registerPeer("bench-B", { kind: "all" })
      serviceB.registerPeer("bench-A", { kind: "all" })

      const initialMem = process.memoryUsage().heapUsed
      let docA = Automerge.init<{ [key: string]: { id: string; title: string; desc: string; done: boolean } }>()

      // 1,000 tasks
      for (let i = 0; i < 1000; i++) {
        docA = Automerge.change(docA, (d) => {
          d[`task_${i}`] = {
            id: `task_${i}`,
            title: `Benchmark Task #${i}`,
            desc: "Description text for Automerge performance baseline testing",
            done: false,
          }
        })
      }

      const docId = "ws-bench"
      serviceA.trackDocument(docId, docA)
      let docB = Automerge.init()
      serviceB.trackDocument(docId, docB)

      // Measure first transfer bytes
      let firstTransferBytes = 0
      let msgA = null
      let msgB = null
      do {
        msgA = serviceA.generateSyncMessage("bench-B", docId)
        if (msgA) {
          firstTransferBytes += msgA.length
          const res = serviceB.receiveSyncMessage("bench-A", docId, msgA)
          docB = res.doc
        }
        msgB = serviceB.generateSyncMessage("bench-A", docId)
        if (msgB) {
          firstTransferBytes += msgB.length
          const res = serviceA.receiveSyncMessage("bench-B", docId, msgB)
          docA = res.doc
        }
      } while (msgA !== null || msgB !== null)

      // Measure one-edit bytes
      docA = Automerge.change(docA, (d) => {
        d["task_0"].title = "Edited Title"
      })
      serviceA.updateDocument(docId, docA)

      const editDeltaMsg = serviceA.generateSyncMessage("bench-B", docId)
      expect(editDeltaMsg).not.toBeNull()
      const oneEditBytes = editDeltaMsg!.length

      // Measure document load time
      const savedBytes = Automerge.save(docA)
      const loadStart = performance.now()
      const reloadedDoc = Automerge.load(savedBytes)
      const loadTimeMs = performance.now() - loadStart

      const peakMem = process.memoryUsage().heapUsed
      const memDeltaMb = (peakMem - initialMem) / (1024 * 1024)

      console.log(`[Gate D Benchmark Results]`)
      console.log(`First transfer bytes (1,000 tasks): ${firstTransferBytes} bytes`)
      console.log(`One-edit transfer bytes: ${oneEditBytes} bytes`)
      console.log(`Ratio (one-edit / first-transfer): ${(oneEditBytes / firstTransferBytes * 100).toFixed(2)}%`)
      console.log(`Document load time: ${loadTimeMs.toFixed(2)} ms`)
      console.log(`Heap delta: ${memDeltaMb.toFixed(2)} MB`)

      expect(firstTransferBytes).toBeGreaterThan(10000)
      expect(oneEditBytes).toBeLessThan(firstTransferBytes / 10) // less than 10%
      expect(loadTimeMs).toBeLessThan(1000) // load under 1 second
      expect(reloadedDoc).toBeDefined()
    })
  })
})
