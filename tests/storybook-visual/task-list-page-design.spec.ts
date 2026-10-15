import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 1512, height: 862 } });

async function openPage(page: Page, story = "default") {
  await page.goto(`/iframe.html?id=tasks-list-page-design--${story}&viewMode=story&globals=theme:dark`);
  await expect(page.getByTestId("design-page-shell")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
}
const rows = (page: Page) => page.locator('.design-task-list-panel [data-slot="task-row"]');

test("full page uses the reviewed row contract and three default columns", async ({ page }, testInfo) => {
  await openPage(page);
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
  await expect(page.getByRole("toolbar", { name: "Task list controls" })).toBeVisible();
  await expect(rows(page)).toHaveCount(10);
  await expect(page.getByRole("columnheader")).toHaveText(["Task", "Task ID", "Last updated"]);
  await expect(page.locator('.task-list-sort-button[data-active="true"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Group tasks", exact: true })).toHaveCount(0);
  for (const link of await page.locator(".design-sidebar-navigation a").all()) await expect(link).toHaveCSS("font-size", "14px");
  await expect(page.locator(".design-sidebar-new-task")).toHaveCSS("font-size", "14px");
  await expect(page.getByRole("button", { name: "Open account menu", exact: true })).toHaveCSS("font-size", "14px");
  const recentLinks = page.locator(".design-sidebar-recents a");
  await expect(recentLinks).toHaveCount(5);
  await expect(page.locator(".design-sidebar-recents").getByText("Recent Tasks", { exact: true })).toBeVisible();
  for (const link of await recentLinks.all()) await expect(link).toHaveCSS("font-weight", "400");
  const dashboard = page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Dashboard", exact: true });
  await expect(dashboard).toHaveCSS("line-height", "21px");
  expect((await dashboard.locator("svg").boundingBox())!.x).toBe(28);
  expect((await dashboard.boundingBox())!.height).toBe(33);
  expect((await recentLinks.first().boundingBox())!.y).toBeGreaterThan((await page.getByRole("link", { name: "Audit", exact: true }).boundingBox())!.y);
  await expect(page.locator(".design-sidebar-account")).toHaveCSS("border-top-width", "0px");
  await expect(page.locator(".design-sidebar")).toHaveCSS("background-color", "oklch(0.269 0 0)");
  await expect(page.locator(".design-sidebar")).toHaveCSS("border-right-color", "oklch(1 0 0 / 0.1)");
  await expect(page.locator(".design-task-search")).toHaveCSS("background-color", "oklch(0.145 0 0)");
  const geometry = await page.getByTestId("design-page-shell").evaluate(shell => {
    const main = shell.querySelector<HTMLElement>(".design-page-main")!;
    const toolbar = shell.querySelector<HTMLElement>(".design-page-toolbar")!;
    const row = shell.querySelector<HTMLElement>('[data-slot="task-row"]')!;
    const title = row.querySelector<HTMLElement>('[data-slot="task-row-title"]')!;
    return {
      mainX: main.getBoundingClientRect().x,
      headerHeight: shell.querySelector(".design-page-header")!.getBoundingClientRect().height,
      toolbarHeight: toolbar.getBoundingClientRect().height,
      background: getComputedStyle(main).backgroundColor,
      rowHeight: row.getBoundingClientRect().height,
      titleSize: getComputedStyle(title).fontSize,
      titleLeading: getComputedStyle(title).lineHeight,
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  expect(geometry).toEqual({ mainX: 240, headerHeight: 60, toolbarHeight: 44, background: "rgb(26, 26, 26)", rowHeight: 44, titleSize: "14px", titleLeading: "16px", pageOverflow: false });
  await page.screenshot({ path: testInfo.outputPath("task-list-page.png"), fullPage: true });
  await page.locator(".design-sidebar").screenshot({ path: testInfo.outputPath("task-list-sidebar-paper.png") });
  const resize = page.getByRole("separator", { name: "Resize sidebar", exact: true });
  await resize.press("ArrowRight");
  await expect(resize).toHaveAttribute("aria-valuenow", "256");
  await page.reload();
  await expect(resize).toHaveAttribute("aria-valuenow", "256");
  expect((await page.locator(".design-page-main").boundingBox())!.x).toBe(256);
  await resize.hover();
  await expect(resize).toHaveCSS("cursor", "col-resize");
  await expect(resize.locator(":scope > div")).toHaveCSS("background-color", "oklch(0.556 0 0)");
  await page.screenshot({ path: testInfo.outputPath("task-list-sidebar-resize.png"), fullPage: true });
});

test("search preserves ancestor context, recovers from no results, and expansion works", async ({ page }) => {
  await openPage(page);
  await page.getByRole("button", { name: "Collapse all tasks" }).click();
  await expect(rows(page)).toHaveCount(6);
  await page.getByRole("button", { name: "Expand all tasks" }).click();
  await expect(rows(page)).toHaveCount(10);
  await page.getByRole("textbox", { name: "Search tasks", exact: true }).fill("expired credential");
  await expect(rows(page)).toHaveCount(3);
  await expect(page.locator(".design-task-results")).toHaveText("1 matching task · Parent tasks included for context");
  await expect(rows(page).locator('[data-slot="task-row-title"]')).toHaveText(["Improve connector reliability", "Design reconnect and recovery flows", /Document connector recovery behavior/]);
  await page.getByRole("textbox", { name: "Search tasks", exact: true }).fill("no matching task exists");
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByText("No tasks match this view", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(rows(page)).toHaveCount(10);
  await expect(page.getByRole("textbox", { name: "Search tasks", exact: true })).toHaveValue("");
});

test("views change the collection while keeping task families together", async ({ page }) => {
  await openPage(page);
  await page.getByRole("button", { name: "Task view: All tasks" }).click();
  await page.getByRole("menuitemradio", { name: "Unread", exact: true }).click();
  await expect(rows(page)).toHaveCount(3);
  await expect(page.locator(".design-task-results")).toHaveText("3 matching tasks");
  await page.getByRole("button", { name: "Task view: Unread" }).click();
  await page.getByRole("menuitemradio", { name: "All tasks", exact: true }).click();
  await expect(rows(page)).toHaveCount(10);
  await expect(page.getByRole("rowgroup", { name: "Improve connector reliability task group", exact: true }).locator('[data-slot="task-row"]')).toHaveCount(5);
});

test("production filters operate on fixtures and list preferences survive board switching", async ({ page }) => {
  await openPage(page);
  await page.locator(".design-toolbar-filter > button").click();
  await page.getByRole("checkbox", { name: "Done Done", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".design-task-results")).toHaveText("2 matching tasks · Parent tasks included for context");
  await expect(rows(page)).toHaveCount(3);
  await page.getByRole("button", { name: "Board view", exact: true }).click();
  await expect(page.locator(".design-task-board")).toBeVisible();
  await expect(page.locator(".design-task-list-panel")).toBeHidden();
  await expect(page.getByRole("button", { name: "Collapse all tasks", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "List view", exact: true }).click();
  await expect(rows(page)).toHaveCount(3);
  await expect(page.getByRole("columnheader")).toHaveText(["Task", "Task ID", "Last updated"]);
});

test("New Task opens the shared task composer", async ({ page }) => {
  await openPage(page);
  await page.getByRole("toolbar", { name: "Task list controls" }).getByRole("button", { name: "New Task", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New task", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create task", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "New task", exact: true })).toBeHidden();
});

test("production organization switcher changes selection without leaking task fixtures", async ({ page }, testInfo) => {
  await openPage(page);
  await page.getByRole("button", { name: "Open Paperclip Storybook organization switcher", exact: true }).click();
  await expect(page.getByText("Organizations", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("task-list-organization-menu.png"), fullPage: true });
  await page.getByRole("menuitem", { name: /Research Bureau/ }).click();
  await expect(page.getByRole("button", { name: "Open Research Bureau organization switcher", exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByText("No tasks in this organization", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open Research Bureau organization switcher", exact: true }).click();
  await page.getByRole("menuitem", { name: /Paperclip Storybook/ }).click();
  await expect(rows(page)).toHaveCount(10);
});

test("production account menu fits profile, settings, Invite and theme actions", async ({ page }, testInfo) => {
  await openPage(page);
  const trigger = page.getByRole("button", { name: "Open account menu", exact: true });
  await trigger.click();
  await expect(page.getByRole("link", { name: "View profile", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  const invite = page.getByRole("link", { name: "Invite", exact: true });
  await expect(invite).toBeVisible();
  await expect(invite).toHaveAttribute("href", /\/company\/settings\/members\?tab=invites$/);
  await expect(page.getByRole("link", { name: "Documentation", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Switch to light mode", exact: true })).toBeVisible();
  const account = page.getByRole("dialog", { name: "Account", exact: true });
  const content = await account.evaluate(menu => {
    const last = menu.querySelector('[data-flyout-options] > button:last-of-type')!;
    return { bottomGap: menu.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom, minimumHeight: getComputedStyle(menu).minHeight };
  });
  expect(content.minimumHeight).toBe("0px");
  expect(content.bottomGap).toBe(13);
  await page.screenshot({ path: testInfo.outputPath("task-list-account-menu.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("link", { name: "View profile", exact: true })).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await invite.click();
  await expect(account).toBeHidden();
});

test("organization, account, Views and Columns share the refreshed flyout appearance", async ({ page }, testInfo) => {
  await openPage(page);
  const scenarios = [
    { trigger: "Open Paperclip Storybook organization switcher", role: "menu", name: /organization switcher/, option: /Research Bureau/, optionRole: "menuitem", screenshot: "flyout-organizations" },
    { trigger: "Open account menu", role: "dialog", name: "Account", option: "Settings", optionRole: "link", screenshot: "flyout-account" },
    { trigger: "Task view: All tasks", role: "menu", name: "Task view: All tasks", option: "Unread", optionRole: "menuitemradio", screenshot: "flyout-views" },
    { trigger: "Columns", role: "menu", name: "Columns", option: "Created by", optionRole: "menuitemcheckbox", screenshot: "flyout-columns" },
  ] as const;
  let sharedShadow: string | undefined;
  for (const scenario of scenarios) {
    await page.getByRole("button", { name: scenario.trigger, exact: true }).click();
    const menu = page.getByRole(scenario.role, { name: scenario.name, exact: true });
    await expect(menu).toHaveCSS("background-color", "rgb(26, 26, 26)");
    await expect(menu).toHaveCSS("border-width", "1px");
    await expect(menu).toHaveCSS("border-radius", "8px");
    const shadow = await menu.evaluate(element => getComputedStyle(element).boxShadow);
    expect(shadow).not.toBe("none");
    if (sharedShadow) expect(shadow).toBe(sharedShadow);
    sharedShadow = shadow;
    const option = menu.getByRole(scenario.optionRole, { name: scenario.option, exact: true });
    await expect(option).toHaveCSS("color", "oklch(0.708 0 0)");
    const selected = menu.locator('[data-selected="true"], [aria-checked="true"]').first();
    if (await selected.count()) {
      await expect(selected).toHaveCSS("color", "oklch(0.708 0 0)");
      await expect(selected.locator("svg.lucide-check")).toHaveCSS("color", "oklch(0.708 0 0)");
    }
    await option.hover();
    await expect(option).toHaveCSS("background-color", "rgb(51, 51, 51)");
    await expect(option).toHaveCSS("color", await menu.locator("[data-flyout-header]").evaluate(element => getComputedStyle(element).color));
    if (scenario.name === "Task view: All tasks") {
      const selected = menu.getByRole("menuitemradio", { name: "All tasks", exact: true });
      await expect(selected).toBeChecked();
      await expect(selected.locator("svg.lucide-check")).toBeVisible();
      await expect(selected.locator("svg.lucide-circle")).toHaveCount(0);
    }
    await page.screenshot({ path: testInfo.outputPath(`${scenario.screenshot}.png`) });
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  }
});

test("separate sidebar search target opens the production global palette", async ({ page }) => {
  await openPage(page);
  const organization = page.getByRole("button", { name: "Open Paperclip Storybook organization switcher", exact: true });
  const search = page.getByRole("button", { name: "Global search", exact: true });
  await expect(organization.locator("svg.lucide-chevrons-up-down")).toHaveCount(0);
  const organizationBounds = (await organization.boundingBox())!;
  expect((await search.boundingBox())!.x).toBeGreaterThanOrEqual(organizationBounds.x + organizationBounds.width);
  await search.click();
  const input = page.getByPlaceholder("Search tasks, agents, projects...", { exact: true });
  await expect(input).toBeVisible();
  await expect(page.getByText("Organizations", { exact: true })).toBeHidden();
  await input.fill("Codex");
  await expect(page.getByRole("option", { name: /CodexCoder/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(input).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Search tasks", exact: true })).toHaveValue("");
});

test("sidebar truncated labels share the table marquee and fade without extra tab stops", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openPage(page);
  const organization = page.getByRole("button", { name: "Open Paperclip Storybook organization switcher", exact: true });
  const label = organization.locator("[data-cell-marquee]");
  const recent = page.locator(".design-sidebar-recents a").first().locator("[data-cell-marquee]");
  for (const text of [label, recent]) {
    await expect(text).toHaveAttribute("data-truncated", "true");
    await expect(text).not.toHaveAttribute("tabindex");
    expect(await text.locator(".cell-marquee-viewport").evaluate(element => getComputedStyle(element).maskImage)).toContain("linear-gradient");
    await text.hover();
    await expect(text).toHaveAttribute("data-revealing", "true");
    await expect.poll(() => text.locator(".cell-marquee-content").evaluate(element => getComputedStyle(element).transform)).not.toBe("matrix(1, 0, 0, 1, 0, 0)");
    await page.mouse.move(0, 0);
    await expect(text).not.toHaveAttribute("data-revealing");
    await expect(text.locator(".cell-marquee-content")).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  }
  const fitting = page.getByRole("link", { name: "Dashboard", exact: true }).locator("[data-cell-marquee]");
  await fitting.hover();
  await expect(fitting).not.toHaveAttribute("data-truncated");
  await expect(fitting).not.toHaveAttribute("data-revealing");
  await page.mouse.move(0, 0);
  await organization.focus();
  await expect(label).toHaveAttribute("data-revealing", "true");
  await page.keyboard.press("Escape");
  await expect(label).not.toHaveAttribute("data-revealing");
});

test("fractionally clipped recent titles reveal even when scrollWidth equals clientWidth", async ({ page }, testInfo) => {
  await openPage(page);
  const task = page.locator(".design-sidebar-recents").getByRole("link", { name: "Review budget notifications", exact: true });
  const label = task.locator("[data-cell-marquee]");
  const dimensions = await label.evaluate(element => {
    const content = element.querySelector(".cell-marquee-content")!;
    const range = document.createRange();
    range.selectNodeContents(content);
    return { client: element.clientWidth, scroll: content.scrollWidth, viewport: element.getBoundingClientRect().width, text: range.getBoundingClientRect().width };
  });
  expect(dimensions.scroll).toBe(dimensions.client);
  expect(dimensions.text).toBeGreaterThan(dimensions.viewport);
  expect(dimensions.text - dimensions.viewport).toBeLessThan(1);
  await expect(label).toHaveAttribute("data-truncated", "true");
  const bounds = (await task.boundingBox())!;
  // Hover the link padding, outside the text rectangle, just like the row's
  // visible hover state. Small overflow must still reveal the full final glyph.
  await page.mouse.move(bounds.x + 3, bounds.y + 3);
  await expect(label).toHaveAttribute("data-revealing", "true");
  await expect(label.locator(".cell-marquee-content")).toHaveCSS("overflow", "visible");
  await expect.poll(() => label.locator(".cell-marquee-content").evaluate(element => getComputedStyle(element).transform)).not.toBe("matrix(1, 0, 0, 1, 0, 0)");
  await page.locator(".design-sidebar").screenshot({ path: testInfo.outputPath("recent-task-marquee.png") });
  await page.mouse.move(0, 0);
  await expect(label).not.toHaveAttribute("data-revealing");
  await expect(label.locator(".cell-marquee-content")).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
});

test("all-columns layout clips inside the table at a narrower desktop width", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1100, height: 862 });
  await openPage(page, "all-columns");
  await expect(page.getByRole("columnheader")).toHaveCount(9);
  const overflow = await page.locator(".task-list-columns-scroll").evaluate(element => ({ table: element.scrollWidth > element.clientWidth, page: document.documentElement.scrollWidth > window.innerWidth }));
  expect(overflow).toEqual({ table: true, page: false });
  await expect(page.locator(".design-toolbar-actions")).toBeInViewport();
  await page.getByRole("button", { name: "Task ID: sort ascending", exact: true }).click();
  await expect(page.locator('.task-list-sort-button[data-active="true"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Columns", exact: true }).click();
  await page.getByRole("menuitem", { name: "Reset defaults", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("columnheader")).toHaveText(["Task", "Task ID", "Last updated"]);
  await expect(page.locator('.task-list-sort-button[data-active="true"]')).toHaveCount(0);
  await expect(page.locator('[data-slot="task-list-sort-direction"]')).toHaveCount(0);
  await expect(page.locator('[role="columnheader"][aria-sort="none"]')).toHaveCount(3);
  await page.mouse.move(0, 0);
  for (const button of await page.locator(".task-list-sort-button").all()) await expect(button).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.locator(".design-task-list-panel").screenshot({ path: testInfo.outputPath("task-list-reset-defaults.png") });
});
