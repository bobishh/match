import { expect, test } from "@playwright/test"

for (const status of [202, 503]) {
  test(`Given diagnostics return ${status}, when chat saves, then text persists and telemetry excludes content`, async ({ page }) => {
    const batches: Array<{ events: Array<Record<string, unknown>> }> = []
    await page.route("**/telemetry", async route => {
      batches.push(route.request().postDataJSON())
      await route.fulfill({ status, body: "" })
    })
    await page.goto("/")
    await page.getByRole("button", { name: "Workspace chat", exact: true }).filter({ visible: true }).click()
    const chat = page.getByRole("dialog", { name: "Workspace chat", exact: true })
    const text = "private-body-must-never-enter-diagnostics"
    await chat.getByRole("textbox", { name: "Message", exact: true }).fill(text)
    await chat.getByRole("button", { name: "Send message" }).click()
    await expect(chat.getByText(text, { exact: true })).toBeVisible()
    await expect(chat.getByText("Saving locally…", { exact: true })).toHaveCount(0)
    await expect.poll(() => batches.flatMap(batch => batch.events).some(event => event.event === "chat.submit"), { timeout: 15000 }).toBe(true)
    const events = batches.flatMap(batch => batch.events)
    expect(JSON.stringify(batches)).not.toContain(text)
    expect(events.some(event => event.event === "chat.persisted" && event.record_id)).toBe(true)
    expect(events.some(event => event.event === "chat.rendered" && event.record_id)).toBe(true)
    for (const event of events) expect(Object.keys(event).sort()).toEqual([
      "connection_id", "duration_ms", "event", "outcome", "peer_id", "phase", "record_id", "session_id", "timestamp_ms", "workspace_id",
    ])
    await page.reload()
    await page.getByRole("button", { name: "Workspace chat", exact: true }).filter({ visible: true }).click()
    await expect(page.getByRole("dialog", { name: "Workspace chat", exact: true }).getByText(text, { exact: true })).toBeVisible()
  })
}
