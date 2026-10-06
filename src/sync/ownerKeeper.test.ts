import { describe, expect, it } from "vitest"
import { writeLocal } from "../localDb"
import { ownerKeepers, rememberActivatedKeeper, removeOwnerKeeper, saveOwnerKeeper } from "./ownerKeeper"

describe("identity-scoped owner-keeper policy", () => {
  it("reconciles repeated activation receipts without downgrading an existing editor", async () => {
    const owner = `owner-${crypto.randomUUID()}`
    const details = { origin: "https://keeper.example", boardIds: ["board"], futureBoards: true }
    await saveOwnerKeeper(owner, { personId: "keeper", role: "editor" })
    await rememberActivatedKeeper(owner, "keeper", details)
    await rememberActivatedKeeper(owner, "keeper", details)
    await expect(ownerKeepers(owner)).resolves.toEqual([{ personId: "keeper", role: "editor", details }])
    await rememberActivatedKeeper(owner, "new-keeper", details)
    await expect(ownerKeepers(owner)).resolves.toContainEqual({ personId: "new-keeper", role: "visitor", details })
  })
  it("reloads policy for its owner identity and updates one keeper idempotently", async () => {
    const owner = `owner-${crypto.randomUUID()}`
    const otherOwner = `owner-${crypto.randomUUID()}`
    const keeper = `keeper-${crypto.randomUUID()}`
    await saveOwnerKeeper(owner, { personId: keeper, role: "visitor" })
    await saveOwnerKeeper(owner, { personId: keeper, role: "editor" })

    await expect(ownerKeepers(owner)).resolves.toEqual([{ personId: keeper, role: "editor" }])
    await expect(ownerKeepers(otherOwner)).resolves.toEqual([])
  })

  it("ignores malformed local policy records", async () => {
    const owner = `owner-${crypto.randomUUID()}`
    await writeLocal(`tincanban.owner-keepers.v1:${owner}`, '[null,{"personId":"keeper","role":"owner"}]')

    await expect(ownerKeepers(owner)).resolves.toEqual([])
    await writeLocal(`tincanban.owner-keepers.v1:${owner}`, "not-json")
    await expect(ownerKeepers(owner)).resolves.toEqual([])
  })

  it("retains pairing details when future-board enrollment updates the role", async () => {
    const owner = `owner-${crypto.randomUUID()}`
    const details = { origin: "https://keeper.example", boardIds: ["board"], futureBoards: true }
    await saveOwnerKeeper(owner, { personId: "keeper", role: "visitor", details })
    await saveOwnerKeeper(owner, { personId: "keeper", role: "editor" })
    await expect(ownerKeepers(owner)).resolves.toEqual([{ personId: "keeper", role: "editor", details }])
  })

  it("removes one keeper only for its owner", async () => {
    const owner = `owner-${crypto.randomUUID()}`
    const otherOwner = `owner-${crypto.randomUUID()}`
    await saveOwnerKeeper(owner, { personId: "old", role: "visitor" })
    await saveOwnerKeeper(owner, { personId: "current", role: "editor" })
    await saveOwnerKeeper(otherOwner, { personId: "old", role: "visitor" })
    await removeOwnerKeeper(owner, "old")
    await expect(ownerKeepers(owner)).resolves.toEqual([{ personId: "current", role: "editor" }])
    await expect(ownerKeepers(otherOwner)).resolves.toEqual([{ personId: "old", role: "visitor" }])
  })
})
