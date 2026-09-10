import { expect, test } from "@playwright/test"

test.describe("Mobile Navigation & Drawer (Gate D)", () => {
  for (const viewport of [
    { width: 360, height: 800, name: "360px (Compact Mobile)" },
    { width: 390, height: 844, name: "390px (iPhone 14)" },
    { width: 430, height: 932, name: "430px (iPhone 14 Pro Max)" },
  ]) {
    test(`Given ${viewport.name} viewport, when opened, hamburger drawer provides accessible grouped navigation and traps focus`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.goto("/")

      // Verify no horizontal overflow on page
      const hasHorizontalOverflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth
      })
      expect(hasHorizontalOverflow).toBe(false)

      // Hamburger button should be visible on mobile
      const hamburger = page.getByRole("button", { name: "Menu", exact: true })
      await expect(hamburger).toBeVisible()
      await expect(hamburger).toHaveAttribute("aria-expanded", "false")

      // Desktop direct action buttons should NOT be visible in mobile topbar
      await expect(page.locator(".top-actions-desktop")).toBeHidden()

      // Click hamburger to open drawer
      await hamburger.click()
      await expect(hamburger).toHaveAttribute("aria-expanded", "true")

      const drawer = page.getByRole("dialog", { name: "Navigation menu" })
      await expect(drawer).toBeVisible()

      // Focus management: focus should be inside the drawer
      const isFocusedInDrawer = await drawer.evaluate((node) => node.contains(document.activeElement))
      expect(isFocusedInDrawer).toBe(true)

      // Verify clearly labeled groups exist inside drawer
      await expect(drawer.getByRole("heading", { name: "Workspaces" })).toBeVisible()
      await expect(drawer.getByRole("heading", { name: "Settings" })).toBeVisible()
      await expect(drawer.getByRole("heading", { name: "Sync & data" })).toBeVisible()

      // Check actions inside drawer
      await expect(drawer.getByRole("button", { name: "Workspaces" })).toBeVisible()
      await expect(drawer.getByRole("button", { name: "Workspace settings" })).toBeVisible()
      await expect(drawer.getByRole("button", { name: "Sync, import & export" })).toBeVisible()

      // Escape key closes drawer and restores focus to hamburger trigger
      await page.keyboard.press("Escape")
      await expect(drawer).toBeHidden()
      await expect(hamburger).toBeFocused()

      // Re-open and verify clicking Settings opens the single workspace settings modal.
      await hamburger.click()
      await expect(drawer).toBeVisible()
      await drawer.getByRole("button", { name: "Workspace settings" }).click()
      await expect(drawer).toBeHidden()
      await expect(page.getByRole("dialog", { name: "Workspace settings" })).toBeVisible()
      await page.getByRole("button", { name: "Dismiss" }).click()

      // Re-open and verify clicking backdrop closes drawer
      await hamburger.click()
      await expect(drawer).toBeVisible()
      // Click outside drawer on backdrop
      await page.locator(".mobile-drawer-backdrop").click({ position: { x: 10, y: 10 } })
      await expect(drawer).toBeHidden()
      await expect(hamburger).toBeFocused()
    })
  }

  test("Given 1024px desktop viewport, topbar displays direct action buttons and hides hamburger button", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 768 })
    await page.goto("/")

    // Hamburger button should be hidden on desktop
    const hamburger = page.getByRole("button", { name: "Menu", exact: true })
    await expect(hamburger).toBeHidden()

    // Desktop keeps only the current workflow; secondary actions live in their modals.
    const desktopActions = page.locator(".top-actions-desktop")
    await expect(desktopActions).toBeVisible()
    await expect(page.getByRole("button", { name: "Open workspaces" })).toBeVisible()
    await expect(desktopActions.getByRole("button", { name: "Workspace settings" })).toBeVisible()
    await expect(desktopActions.getByRole("button", { name: "Sync" })).toBeVisible()
    await expect(desktopActions.getByRole("button", { name: /Add lead/ })).toHaveCount(0)
    await expect(desktopActions.getByRole("link", { name: "Agent guide" })).toHaveCount(0)
    await expect(desktopActions.getByRole("button")).toHaveCount(4)
  })
})
