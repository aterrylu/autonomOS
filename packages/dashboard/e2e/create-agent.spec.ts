import { expect, test } from "@playwright/test";
import { mockApi } from "./mocks";

/**
 * Create-agent flow. Opens the Create panel, asserts Dispatcher is the
 * Recommended auto-default, submits, and asserts POST /api/agents was called
 * with the expected body. No real agent is spawned — POST is mocked.
 */
test("create-agent: Dispatcher is the recommended default and submit posts the right body", async ({
  page,
}) => {
  const state = await mockApi(page);
  await page.goto("/");

  // Open the Create Agent panel via the sidebar "+ New" button.
  // The sidebar "+ New" button (title="New Agent") opens the Create panel.
  await page.locator('button[title="New Agent"]').click();

  await expect(
    page.getByRole("heading", { name: "Create New Agent" }),
  ).toBeVisible();

  // Dispatcher card carries the "Recommended" badge and is the auto-default
  // selection (templates.dispatcher present in the mock → auto-selected).
  await expect(page.getByText("Recommended", { exact: true })).toBeVisible();

  // The name input is auto-filled from the dispatcher role ("Dispatcher").
  const nameInput = page.getByPlaceholder("e.g. Dispatcher, Researcher");
  await expect(nameInput).toHaveValue("Dispatcher");

  // The recommended runtime (Claude Code) is installed + selectable.
  await expect(page.getByText("Claude Code", { exact: true })).toBeVisible();

  // Submit.
  await page.getByRole("button", { name: "Create Agent" }).click();

  // POST /api/agents fired once with the dispatcher template + name + home dir.
  await expect
    .poll(() => state.createdAgents.length, { timeout: 5_000 })
    .toBe(1);
  expect(state.createdAgents[0]).toMatchObject({
    name: "Dispatcher",
    provider: "claude-code",
    template: "dispatcher",
    workingDirectory: "~",
  });

  // On success the Create Agent tab closes — the heading is gone.
  await expect(
    page.getByRole("heading", { name: "Create New Agent" }),
  ).toHaveCount(0);
});

test("create-agent: name is required — empty name blocks submit and shows an error", async ({
  page,
}) => {
  // Empty agent list → no dispatcher auto-default name; but we also clear the
  // name to prove the validation guard. Use the default agent list so the
  // panel is opened manually (not the first-run auto-open).
  const state = await mockApi(page);
  await page.goto("/");

  // The sidebar "+ New" button (title="New Agent") opens the Create panel.
  await page.locator('button[title="New Agent"]').click();
  await expect(
    page.getByRole("heading", { name: "Create New Agent" }),
  ).toBeVisible();

  // Clear the auto-filled name.
  const nameInput = page.getByPlaceholder("e.g. Dispatcher, Researcher");
  await nameInput.fill("");

  await page.getByRole("button", { name: "Create Agent" }).click();

  // Validation error shown, and NO POST fired.
  await expect(page.getByText("Agent name is required")).toBeVisible();
  expect(state.createdAgents.length).toBe(0);
});
