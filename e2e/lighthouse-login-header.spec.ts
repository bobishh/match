import { expect, test } from "./support/coverage"

const login = "/login?keeper=https%3A%2F%2Fkeeper.example&challenge=test-challenge"

test("Given a verified sign-in request, when tincanban opens approval, then its shared header names the approval", async ({ page }) => {
  await page.route("**/src/app/lighthouseLogin.ts", route => route.fulfill({
    contentType: "text/javascript",
    body: `export async function prepareLighthouseLoginApproval() {
      return { keeperName: "Test keeper", keeperOrigin: "https://keeper.example",
        tincanbanName: "Test owner", tincanbanPersonId: "test-person", approve: async () => "/" }
    }`,
  }))
  await page.goto(login)
  await expect(page.getByRole("heading", { name: "TINCANBAN // IDENTITY APPROVAL" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Sign in with your tincanban identity?" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Approve sign-in" })).toBeEnabled()
  await expect(page.getByRole("img", { name: "Lighthouse" })).toHaveCount(0)
})

test("Given an invalid sign-in link, when tincanban opens approval, then shared header stays visible with error", async ({ page }) => {
  await page.goto("/login?challenge=test-challenge&unexpected=1")
  await expect(page.getByRole("heading", { name: "TINCANBAN // IDENTITY APPROVAL" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Could not verify sign-in request" })).toBeVisible()
  await expect(page.getByRole("alert")).toContainText("unexpected parameters")
})
