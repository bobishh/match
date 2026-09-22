import { expect, test } from "@playwright/test"
import { createJobSearchWorkspace } from "./support/workspaces"

test("Given an unreadable authority on one board, when creating and importing another board, then its owner access survives", async ({ page }) => {
  await page.goto("/")
  await createJobSearchWorkspace(page, "Broken authority")
  await expect(page.getByLabel("Workspace role: owner")).toBeVisible()
  await page.evaluate(async () => {
    const { bootstrapIdentity } = await import("/src/domain/identity.ts")
    const { peerStore } = await import("/src/sync/peerStore.ts")
    const { useMatch } = await import("/src/state.ts")
    const { createWorkspaceRevocation } = await import("/src/sync/meshRecords.ts")
    const { getHeads } = await import("/@id/@automerge/automerge/slim")
    const profile = await bootstrapIdentity("Owner")
    const workspaceId = useMatch().activeWorkspace.id
    const revocation = await createWorkspaceRevocation(profile, workspaceId, "former-member", 2, getHeads(useMatch().getActiveDoc()!))
    Reflect.deleteProperty(revocation.payload, "workspaceHeads")
    await peerStore.putWorkspaceAuthority({ version: 1, workspaceId,
      genesisOwnerPersonId: profile.identity.personId, ownerPersonId: profile.identity.personId,
      ownerPublicKey: profile.identity.publicKey, ownerCertificates: [profile.certificate],
      ownerHistory: [], epoch: 1, updatedAt: new Date().toISOString(),
      catalog: { revocations: [revocation] },
    })
  })
  await page.reload()
  await expect(page.getByRole("alert").filter({ hasText: "permissions could not be verified" })).toBeVisible()
  await expect(page.getByLabel("Workspace role: visitor")).toHaveCount(0)
  await createJobSearchWorkspace(page, "Healthy sibling")
  await expect(page.getByLabel("Workspace role: owner")).toBeVisible()
  await expect(page.getByRole("button", { name: /Add lead to/ }).first()).toBeVisible()
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const sync = page.getByRole("dialog", { name: "Device sync" })
  const downloadEvent = page.waitForEvent("download")
  await sync.getByRole("button", { name: "Export .match", exact: true }).click()
  const bundle = await (await downloadEvent).path()
  const chooserEvent = page.waitForEvent("filechooser")
  await sync.getByRole("button", { name: "Import as new board", exact: true }).click()
  await (await chooserEvent).setFiles(bundle!)
  await sync.getByRole("button", { name: "Close", exact: true }).first().click()
  await expect(page.getByRole("status").filter({ hasText: "Imported as a new board" })).toBeVisible()
  await expect(page.getByLabel("Workspace role: owner")).toBeVisible()
  await page.reload()
  await expect(page.getByLabel("Workspace role: owner")).toBeVisible()
})
