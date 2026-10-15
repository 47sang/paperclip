import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1512, height: 1050 } });

test("standalone Flyout sections support toggles, radio checks and a profile header", async ({ page }, testInfo) => {
  await page.goto("/iframe.html?id=design-flyout--columns&viewMode=story&globals=theme:dark");
  const columns = page.getByRole("dialog", { name: "Columns", exact: true });
  await expect(columns).toBeVisible();
  const taskId = columns.getByRole("button", { name: "Task ID", exact: true });
  await page.mouse.move(0, 0);
  await expect(taskId).toHaveCSS("color", "oklch(0.708 0 0)");
  await expect(taskId.locator("svg.lucide-check")).toHaveCSS("color", "oklch(0.708 0 0)");
  await taskId.hover();
  await expect(taskId).toHaveCSS("color", "oklch(0.985 0 0)");
  await expect(taskId.locator("svg.lucide-check")).toHaveCSS("color", "oklch(0.985 0 0)");
  await taskId.click();
  await expect(taskId).toHaveAttribute("aria-pressed", "false");
  await expect(taskId.locator("svg")).toHaveCount(0);
  await columns.getByRole("button", { name: "Reset defaults", exact: true }).click();
  await expect(taskId).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(0, 0);
  await page.screenshot({ path: testInfo.outputPath("flyout-component.png") });
  await columns.screenshot({ path: testInfo.outputPath("flyout-component-panel.png") });
  await page.keyboard.press("Escape");
  await expect(columns).toBeHidden();
  await expect(page.getByRole("button", { name: "Columns", exact: true })).toBeFocused();

  await page.goto("/iframe.html?id=design-flyout--views&viewMode=story&globals=theme:dark");
  await expect(page.getByRole("menuitemradio")).toHaveText(["Inbox", "Unread", "Needs attention", "All tasks"]);
  await expect(page.getByRole("menuitemradio", { name: "All tasks", exact: true })).toBeChecked();
  await page.getByRole("menuitemradio", { name: "Unread", exact: true }).click();
  await page.getByRole("button", { name: "Views", exact: true }).click();
  const unread = page.getByRole("menuitemradio", { name: "Unread", exact: true });
  await expect(unread).toBeChecked();
  await expect(unread.locator("svg.lucide-check")).toBeVisible();

  await page.goto("/iframe.html?id=design-flyout--profile&viewMode=story&globals=theme:dark");
  await expect(page.getByRole("heading", { name: "Riley Board", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Account", exact: true }).locator('[data-slot="avatar-fallback"]')).toHaveText("R");
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(page.getByText("Invite selected in this preview.", { exact: true })).toBeVisible();
});

test("Shadow control previews an override and clearing it restores the shared token", async ({ page }, testInfo) => {
  await page.goto("/?path=/story/design-flyout--columns");
  const preview = page.frameLocator("#storybook-preview-iframe");
  const panel = preview.getByRole("dialog", { name: "Columns", exact: true });
  await expect(panel).toBeVisible();
  const defaultShadow = await panel.evaluate(element => getComputedStyle(element).boxShadow);
  const showAddons = page.getByRole("button", { name: "Show addon panel", exact: true });
  if (await showAddons.isVisible()) await showAddons.click();
  await page.getByRole("tab", { name: /^Controls/ }).click();
  const shadow = page.locator("#control-shadow");
  await shadow.fill("0 8px 24px rgb(0 0 0 / 35%)");
  await expect(panel).toHaveCSS("box-shadow", "rgba(0, 0, 0, 0.35) 0px 8px 24px 0px");
  await shadow.fill("");
  await expect(panel).toHaveCSS("box-shadow", defaultShadow);
  await page.screenshot({ path: testInfo.outputPath("flyout-shadow-controls.png") });
});
