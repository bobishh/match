import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { readFile } from "node:fs/promises"
import { initializeAutomerge } from "./crdt"
import { registerWebMcp, type ToolStore, type ModelContext } from "./webmcp"
import { bootstrapIdentity, resetIdentityStorageForTest } from "./domain/identity"
import { useMatch, hydrate, resetStateForTest } from "./state"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

describe("WebMCP tools and legacy aliases (Task 1.12)", () => {
  let registeredTools: Map<string, any>
  let mockContext: ModelContext
  let match: ReturnType<typeof useMatch>

  beforeEach(async () => {
    resetIdentityStorageForTest()
    resetStateForTest()
    await bootstrapIdentity("WebMCP Test User")
    await hydrate()
    match = useMatch()

    registeredTools = new Map()
    mockContext = {
      registerTool: vi.fn((tool) => {
        registeredTools.set(tool.name, tool)
      }),
    }
  })

  it("registers both generic WebMCP commands and legacy aliases", async () => {
    await registerWebMcp({
      workspace: match.workspace,
      createLead: match.createLead,
      createLeadAsync: match.createLeadAsync,
      updateLead: match.updateLead,
      moveLead: match.moveLead,
      createDocument: match.createDocument,
      createArtifact: match.createArtifact,
      persist: match.persist,
      getActiveDoc: match.getActiveDoc,
      executeCommandAsync: match.executeCommandAsync,
      createWorkspaceAsync: match.createWorkspaceAsync,
      availableWorkspaces: match.availableWorkspaces,
      activeWorkspace: match.activeWorkspace,
    }, mockContext)

    // Verify generic commands exist
    expect(registeredTools.has("list_workspaces")).toBe(true)
    expect(registeredTools.has("create_workspace")).toBe(true)
    expect(registeredTools.has("rename_workspace")).toBe(true)
    expect(registeredTools.has("list_tasks")).toBe(true)
    expect(registeredTools.has("create_task")).toBe(true)
    expect(registeredTools.has("patch_task")).toBe(true)
    expect(registeredTools.has("move_entity")).toBe(true)
    expect(registeredTools.has("rename_entity")).toBe(true)
    expect(registeredTools.has("set_entity_deleted")).toBe(true)
    expect(registeredTools.has("list_trash")).toBe(true)
    expect(registeredTools.has("list_placement_issues")).toBe(true)
    expect(registeredTools.has("get_workspace_settings")).toBe(true)
    expect(registeredTools.has("apply_workspace_settings")).toBe(true)

    // Verify legacy aliases exist
    expect(registeredTools.has("list_leads")).toBe(true)
    expect(registeredTools.has("create_lead")).toBe(true)
    expect(registeredTools.has("move_lead")).toBe(true)
    expect(registeredTools.has("list_templates")).toBe(true)
    expect(registeredTools.has("record_pdf_artifact")).toBe(true)
  })

  it("reads and atomically applies the complete workspace settings through WebMCP", async () => {
    await registerWebMcp({
      workspace: match.workspace,
      createLead: match.createLead,
      createLeadAsync: match.createLeadAsync,
      updateLead: match.updateLead,
      moveLead: match.moveLead,
      createDocument: match.createDocument,
      createArtifact: match.createArtifact,
      persist: match.persist,
      getActiveDoc: match.getActiveDoc,
      executeCommandAsync: match.executeCommandAsync,
      createWorkspaceAsync: match.createWorkspaceAsync,
      availableWorkspaces: match.availableWorkspaces,
      activeWorkspace: match.activeWorkspace,
    }, mockContext)

    const read = await registeredTools.get("get_workspace_settings").execute({})
    read.settings.workspace.title = "Agent workspace"
    read.settings.board.entityName = "record"
    read.settings.board.fields = [
      { title: "Due Date", valueType: "datetime", required: false },
    ]
    read.settings.documentTemplates = [{ title: "Agent template", markdown: "# Record" }]
    const result = await registeredTools.get("apply_workspace_settings").execute({ settings: read.settings, expectedHeads: read.heads })

    expect(result.applied).toBe(true)
    expect(result.settings.workspace.title).toBe("Agent workspace")
    expect(result.settings.board.entityName).toBe("record")
    expect(result.settings.board.fields[0].title).toBe("Due Date")
    expect(result.settings.board.fields[0].valueType).toBe("datetime")
    expect(result.settings.documentTemplates[0].title).toBe("Agent template")
  })

  it("executes valid create_task and rejects invalid create_task without mutating", async () => {
    await registerWebMcp({
      workspace: match.workspace,
      createLead: match.createLead,
      createLeadAsync: match.createLeadAsync,
      updateLead: match.updateLead,
      moveLead: match.moveLead,
      createDocument: match.createDocument,
      createArtifact: match.createArtifact,
      persist: match.persist,
      getActiveDoc: match.getActiveDoc,
      executeCommandAsync: match.executeCommandAsync,
      createWorkspaceAsync: match.createWorkspaceAsync,
      availableWorkspaces: match.availableWorkspaces,
      activeWorkspace: match.activeWorkspace,
    }, mockContext)

    const createTask = registeredTools.get("create_task")
    const doc = match.getActiveDoc()!
    const col = Object.values(doc.entities).find((e) => e.kind === "column")!
    expect(col).toBeDefined()

    // 1. Invalid input: missing parentId or empty title
    await expect(createTask.execute({ parentId: col.id, title: "" })).rejects.toThrow(/title is required/i)
    await expect(createTask.execute({ title: "Valid Title" })).rejects.toThrow(/parentId is required/i)

    // Invariant: no task created on failure
    const taskCountBefore = Object.values(match.getActiveDoc()!.entities).filter((e) => e.kind === "task").length
    expect(taskCountBefore).toBe(0)

    // 2. Valid input: creates task visibly
    const result = await createTask.execute({ parentId: col.id, title: "Architectural Review", body: "Review BDD dual-loop" })
    expect(result).toHaveProperty("created", true)

    const docAfter = match.getActiveDoc()!
    const tasks = Object.values(docAfter.entities).filter((e) => e.kind === "task")
    expect(tasks.length).toBe(1)
    expect(tasks[0].title).toBe("Architectural Review")
  })

  it("executes move_entity and rename_entity with proper validation", async () => {
    await registerWebMcp({
      workspace: match.workspace,
      createLead: match.createLead,
      createLeadAsync: match.createLeadAsync,
      updateLead: match.updateLead,
      moveLead: match.moveLead,
      createDocument: match.createDocument,
      createArtifact: match.createArtifact,
      persist: match.persist,
      getActiveDoc: match.getActiveDoc,
      executeCommandAsync: match.executeCommandAsync,
      createWorkspaceAsync: match.createWorkspaceAsync,
      availableWorkspaces: match.availableWorkspaces,
      activeWorkspace: match.activeWorkspace,
    }, mockContext)

    const doc = match.getActiveDoc()!
    const cols = Object.values(doc.entities).filter((e) => e.kind === "column")
    const col1 = cols[0]
    const col2 = cols[1]

    const createTask = registeredTools.get("create_task")
    const moveEntity = registeredTools.get("move_entity")
    const renameEntity = registeredTools.get("rename_entity")

    const res = await createTask.execute({ parentId: col1.id, title: "Original Task" })
    const taskId = res.id

    // Rename
    await expect(renameEntity.execute({ entityId: taskId, title: "" })).rejects.toThrow(/title is required/i)
    await renameEntity.execute({ entityId: taskId, title: "Renamed Task" })
    expect(match.getActiveDoc()!.entities[taskId].title).toBe("Renamed Task")

    // Move to col2
    await moveEntity.execute({ entityId: taskId, parentId: col2.id })
    expect(match.getActiveDoc()!.entities[taskId].placement.parentId).toBe(col2.id)
  })

  it("executes set_entity_deleted and reflects in list_trash", async () => {
    await registerWebMcp({
      workspace: match.workspace,
      createLead: match.createLead,
      createLeadAsync: match.createLeadAsync,
      updateLead: match.updateLead,
      moveLead: match.moveLead,
      createDocument: match.createDocument,
      createArtifact: match.createArtifact,
      persist: match.persist,
      getActiveDoc: match.getActiveDoc,
      executeCommandAsync: match.executeCommandAsync,
      createWorkspaceAsync: match.createWorkspaceAsync,
      availableWorkspaces: match.availableWorkspaces,
      activeWorkspace: match.activeWorkspace,
    }, mockContext)

    const doc = match.getActiveDoc()!
    const col = Object.values(doc.entities).find((e) => e.kind === "column")!
    const createTask = registeredTools.get("create_task")
    const setDeleted = registeredTools.get("set_entity_deleted")
    const listTrash = registeredTools.get("list_trash")

    const res = await createTask.execute({ parentId: col.id, title: "To Delete" })
    const taskId = res.id

    await setDeleted.execute({ entityId: taskId, deleted: true })
    expect(match.getActiveDoc()!.entities[taskId].deleted).toBe(true)

    const trash = await listTrash.execute({})
    expect(trash.some((item: any) => item.id === taskId)).toBe(true)
  })

  it("preserves legacy create_lead duplicate prevention and field mapping", async () => {
    await registerWebMcp({
      workspace: match.workspace,
      createLead: match.createLead,
      createLeadAsync: match.createLeadAsync,
      updateLead: match.updateLead,
      moveLead: match.moveLead,
      createDocument: match.createDocument,
      createArtifact: match.createArtifact,
      persist: match.persist,
      getActiveDoc: match.getActiveDoc,
      executeCommandAsync: match.executeCommandAsync,
      createWorkspaceAsync: match.createWorkspaceAsync,
      availableWorkspaces: match.availableWorkspaces,
      activeWorkspace: match.activeWorkspace,
    }, mockContext)

    const createLead = registeredTools.get("create_lead")

    // Missing company/role -> throws
    await expect(createLead.execute({ company: "", role: "Engineer", status: "lead" })).rejects.toThrow(/company is required/i)

    // Valid create
    const created = await createLead.execute({
      company: "Acme",
      role: "Lead Architect",
      status: "lead",
      priority: "p0",
      workMode: "remote",
      fitScore: 9,
    })
    expect(created).toHaveProperty("created", true)
    expect(created.company).toBe("Acme")

    // Duplicate detection: same company and role returns duplicate: true
    const dup = await createLead.execute({
      company: "Acme",
      role: "Lead Architect",
      status: "applied",
    })
    expect(dup).toHaveProperty("duplicate", true)
  })
})
