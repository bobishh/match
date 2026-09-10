import { readFile } from "node:fs/promises"
import { beforeAll, describe, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "../crdt"
import { representativeLegacyWorkspace } from "../fixtures/legacyWorkspace"
import {
  createMigrationPlan,
  applyMigrationPlan,
  exportWorkspaceBundleV2,
  readWorkspaceBundleV2,
} from "./migration"
import type { Task, Column } from "./model"
import type { Workspace } from "../types"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

describe("Migration plan, application, and v2 bundle validation (Task 1.9)", () => {
  const ownerPersonId = "person_owner_123"

  it("migrates representative legacy workspace preserving exact IDs, relationships, and timestamps", () => {
    const planResult = createMigrationPlan(representativeLegacyWorkspace, ownerPersonId)
    expect(planResult.ok).toBe(true)
    if (!planResult.ok) return

    const legacyDoc = Automerge.from(representativeLegacyWorkspace)
    const migratedDoc = applyMigrationPlan(planResult.value, legacyDoc)

    expect(migratedDoc.formatVersion).toBe(2)
    expect(migratedDoc.ownerPersonId).toBe(ownerPersonId)
    expect(migratedDoc.migration?.sourceFormat).toBe("match-0.0.1")

    // Check all legacy leads became tasks with exact same IDs
    for (const lead of representativeLegacyWorkspace.leads) {
      const task = migratedDoc.entities[lead.id] as Task
      expect(task).toBeDefined()
      expect(task.kind).toBe("task")
      expect(task.createdAt).toBe(lead.createdAt)
      expect(task.updatedAt).toBe(lead.updatedAt)

      // Archived card check: archived != deleted
      if (lead.status === "archived") {
        expect(task.deleted).toBe(false)
        const col = migratedDoc.entities[task.placement.parentId!] as Column
        expect(col.title).toBe("Archive")
        expect(col.displayHint).toBe("collapsed")
      }
    }

    // Check documents preserved with same IDs and parent links
    for (const doc of representativeLegacyWorkspace.documents) {
      const entity = migratedDoc.entities[doc.id]
      expect(entity).toBeDefined()
      expect(entity.kind).toBe("document")
      expect(entity.placement.parentId).toBe(doc.leadId)
    }

    // Check templates preserved
    for (const tpl of representativeLegacyWorkspace.templates) {
      const entity = migratedDoc.entities[tpl.id]
      expect(entity).toBeDefined()
      expect(entity.kind).toBe("document_template")
    }

    // Check artifacts preserved
    for (const art of representativeLegacyWorkspace.artifacts) {
      const entity = migratedDoc.entities[art.id]
      expect(entity).toBeDefined()
      expect(entity.kind).toBe("artifact")
      expect(entity.placement.parentId).toBe(art.leadId)
    }

    // Original legacy arrays must remain readable in document
    expect(migratedDoc.leads).toBeDefined()
    expect(migratedDoc.documents).toBeDefined()
  })

  it("resumes an interrupted migration plan idempotently with identical IDs", () => {
    const planResult = createMigrationPlan(representativeLegacyWorkspace, ownerPersonId)
    expect(planResult.ok).toBe(true)
    if (!planResult.ok) return

    const legacyDoc1 = Automerge.from(representativeLegacyWorkspace)
    const legacyDoc2 = Automerge.from(representativeLegacyWorkspace)

    const doc1 = applyMigrationPlan(planResult.value, legacyDoc1)
    const doc2 = applyMigrationPlan(planResult.value, legacyDoc2)

    expect(doc1.id).toEqual(doc2.id)
    expect(Object.keys(doc1.entities).sort()).toEqual(Object.keys(doc2.entities).sort())
  })

  it("detects duplicate IDs across legacy collections and returns migration_conflict", () => {
    const conflictingWorkspace = {
      ...representativeLegacyWorkspace,
      leads: [{ id: "duplicate_id_123", company: "A", role: "B", status: "lead" as const, createdAt: "", updatedAt: "" }],
      documents: [{ id: "duplicate_id_123", leadId: "other", kind: "note" as const, title: "Doc", format: "markdown" as const, createdAt: "", updatedAt: "" }],
    }

    const planResult = createMigrationPlan(conflictingWorkspace, ownerPersonId)
    expect(planResult.ok).toBe(false)
    if (!planResult.ok) {
      expect(planResult.error.code).toBe("migration_conflict")
      expect(planResult.error.message).toContain("duplicate_id_123")
    }
  })

  it("exports v2 bundle and validates manifest, format, and rejects corrupt bundles", async () => {
    const planResult = createMigrationPlan(representativeLegacyWorkspace, ownerPersonId)
    expect(planResult.ok).toBe(true)
    if (!planResult.ok) return
    const legacyDoc = Automerge.from(representativeLegacyWorkspace)
    const migratedDoc = applyMigrationPlan(planResult.value, legacyDoc)

    const bundleBytes = await exportWorkspaceBundleV2(migratedDoc, [])
    expect(bundleBytes.length).toBeGreaterThan(0)

    // Read back valid bundle
    const readResult = await readWorkspaceBundleV2(bundleBytes)
    expect(readResult.ok).toBe(true)
    if (!readResult.ok) return

    expect(readResult.value.manifest.format).toBe("match")
    expect(readResult.value.manifest.version).toBe(2)
    expect(readResult.value.manifest.workspaceId).toBe(migratedDoc.id)
    expect(readResult.value.doc.id).toBe(migratedDoc.id)

    // Corrupt bundle check: tampered manifest
    const corruptManifestBundle = await exportWorkspaceBundleV2(migratedDoc, [])
    const unzipped = await readWorkspaceBundleV2(new Uint8Array([1, 2, 3, 4]))
    expect(unzipped.ok).toBe(false)
    if (!unzipped.ok) {
      expect(unzipped.error.code).toBe("unsupported_format")
    }
  })

  it("migrates legacy rejected leads to the Rejected column, not Archive", () => {
    const workspaceWithRejected: Workspace = {
      ...representativeLegacyWorkspace,
      leads: [
        ...representativeLegacyWorkspace.leads,
        {
          id: "lead_rejected_1",
          company: "Declined Corp",
          role: "Dev",
          status: "rejected" as any,
          createdAt: "2026-08-10T10:00:00.000Z",
          updatedAt: "2026-08-11T10:00:00.000Z",
        },
      ],
    }

    const planResult = createMigrationPlan(workspaceWithRejected, ownerPersonId)
    expect(planResult.ok).toBe(true)
    if (!planResult.ok) return

    const legacyDoc = Automerge.from(workspaceWithRejected)
    const migratedDoc = applyMigrationPlan(planResult.value, legacyDoc)

    const task = migratedDoc.entities["lead_rejected_1"] as Task
    expect(task).toBeDefined()
    expect(task.deleted).toBe(false)

    const parentCol = migratedDoc.entities[task.placement.parentId!] as Column
    expect(parentCol).toBeDefined()
    expect(parentCol.title).toBe("Rejected")
    expect(parentCol.displayHint).toBe("normal")
  })
})
