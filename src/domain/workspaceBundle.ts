import * as Automerge from "@automerge/automerge/slim"
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import type { CommandResult, WorkspaceDocumentV2, ChangeProof } from "./model"
import { canonicalizeJson } from "./identity"

export async function exportWorkspaceBundleV2(
  doc: WorkspaceDocumentV2,
  proofs: ChangeProof[] = []
): Promise<Uint8Array> {
  const heads = Automerge.getHeads(doc as Automerge.Doc<WorkspaceDocumentV2>).sort()
  const manifest = {
    format: "match",
    version: 2,
    workspaceId: doc.id,
    heads,
    includedBlobHashes: [],
    missingBlobHashes: [],
    proofFormatVersion: 1,
    exportedAt: new Date().toISOString(),
  }

  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
    "workspace.automerge": Automerge.save(doc as Automerge.Doc<WorkspaceDocumentV2>),
    "workspace.json": strToU8(canonicalizeJson(doc)),
    "proofs.json": strToU8(JSON.stringify(proofs, null, 2)),
  }

  return zipSync(files)
}

export async function readWorkspaceBundleV2(
  bundleBytes: Uint8Array
): Promise<CommandResult<{ doc: WorkspaceDocumentV2; manifest: any; proofs: ChangeProof[] }>> {
  let archive: Record<string, Uint8Array>
  try {
    archive = unzipSync(bundleBytes)
  } catch (e) {
    return { ok: false, error: { code: "unsupported_format", message: "Failed to unzip bundle" } }
  }

  const manifestFile = archive["manifest.json"]
  const automergeFile = archive["workspace.automerge"]

  if (!manifestFile || !automergeFile) {
    return { ok: false, error: { code: "unsupported_format", message: "Invalid bundle structure" } }
  }

  let manifest: any
  try {
    manifest = JSON.parse(strFromU8(manifestFile))
  } catch {
    return { ok: false, error: { code: "unsupported_format", message: "Corrupt manifest.json" } }
  }

  if (manifest.format !== "match" || manifest.version !== 2) {
    return {
      ok: false,
      error: { code: "unsupported_format", message: `Unsupported bundle format ${manifest.format} v${manifest.version}` },
    }
  }

  let doc: Automerge.Doc<WorkspaceDocumentV2>
  try {
    doc = Automerge.load<WorkspaceDocumentV2>(automergeFile)
  } catch {
    return { ok: false, error: { code: "unsupported_format", message: "Corrupt workspace.automerge bytes" } }
  }

  if (manifest.workspaceId !== doc.id) {
    return {
      ok: false,
      error: { code: "unsupported_format", message: "Manifest workspaceId does not match document" },
    }
  }

  let proofs: ChangeProof[] = []
  if (archive["proofs.json"]) {
    try {
      proofs = JSON.parse(strFromU8(archive["proofs.json"]))
    } catch {
      proofs = []
    }
  }

  return {
    ok: true,
    value: { doc, manifest, proofs },
  }
}
