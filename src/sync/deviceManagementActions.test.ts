import { describe, expect, it, vi } from "vitest"
import { ownedWorkspaceIds } from "./deviceManagementActions"

describe("owned workspace discovery", () => {
  it("reports a broken board and keeps healthy ownership on repeated mesh starts", async () => {
    const workspaces = [
      { id: "healthy", title: "Healthy board" },
      { id: "broken", title: "Broken board" },
      { id: "visitor", title: "Visitor board" },
    ]
    const failure = new Error("missing workspaceHeads")
    const owner = vi.fn(async (id: string) => {
      if (id === "broken") throw failure
      return id === "healthy" ? "me" : "someone-else"
    })
    const onWorkspaceError = vi.fn()

    const firstStart = await ownedWorkspaceIds(workspaces, owner, "me", onWorkspaceError)
    const retryStart = await ownedWorkspaceIds(workspaces, owner, "me", onWorkspaceError)

    expect(firstStart).toEqual(["healthy"])
    expect(retryStart).toEqual(["healthy"])
    expect(owner).toHaveBeenCalledTimes(6)
    expect(onWorkspaceError).toHaveBeenNthCalledWith(1, workspaces[1], failure)
    expect(onWorkspaceError).toHaveBeenNthCalledWith(2, workspaces[1], failure)
  })

  it("keeps diagnostic callback failures from aborting healthy workspace discovery", async () => {
    const ids = await ownedWorkspaceIds([{ id: "healthy" }, { id: "broken" }], async id => {
      if (id === "broken") throw new Error("invalid board")
      return "me"
    }, "me", () => { throw new Error("UI closed") })

    expect(ids).toEqual(["healthy"])
  })
})
