// MM-1 (AC-23): the web Mine tab lists the signed-in user's machines and their sessions; another
// user's `me` session stays off Live. Runs under `pnpm test:web` (not part of `pnpm check`).
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

async function cliLogin(request: APIRequestContext, token: string, hostname: string, install: string): Promise<{ token: string; machine: string }> {
  const r = await request.post("/auth/team/login", { data: { token, hostname, install } });
  expect(r.ok()).toBeTruthy();
  const j = await r.json();
  return { token: j.token as string, machine: j.machine as string };
}

const session = (sid: string, name: string, over: Record<string, unknown> = {}) => ({
  sid,
  claudeSessionIds: [`c-${sid}`],
  cwd: "",
  kind: "interactive",
  state: "idle",
  quiet: false,
  startedAt: Date.now() - 60_000,
  lastEventAt: Date.now() - 30_000,
  turns: 1,
  humanPrompts: 1,
  seenByReconciler: true,
  name,
  ...over,
});

async function sync(request: APIRequestContext, token: string, sessions: unknown[]): Promise<void> {
  const r = await request.post("/v1/sync", { headers: { authorization: `Bearer ${token}` }, data: { events: [], counts: {}, sessions, machine: { share: "me" } } });
  expect(r.ok()).toBeTruthy();
}

async function signIn(page: Page, token: string): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Token token").fill(token);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

async function openMine(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Mine" }).click();
  await expect(page).toHaveURL(/#\/mine$/);
}

test.describe.configure({ mode: "serial" });

let bobA: { token: string; machine: string };
let bobB: { token: string; machine: string };

test.beforeAll(async ({ request }) => {
  bobA = await cliLogin(request, "bob-e2e-token", "mine-laptop", "e2e-mine-laptop");
  bobB = await cliLogin(request, "bob-e2e-token", "mine-empty", "e2e-mine-empty");
  await sync(request, bobA.token, [session("mine-s1", "mine-first-session", { repo: { id: "example.org/team/alpha", name: "alpha" } })]);
  await sync(request, bobB.token, []);
  // The first sync confirms `me`; a second one is what a daemon would send next.
  await sync(request, bobA.token, [session("mine-s1", "mine-first-session", { repo: { id: "example.org/team/alpha", name: "alpha" } })]);
  const named = await request.post(`/v1/machines/${bobA.machine}/name`, { headers: { authorization: `Bearer ${bobA.token}` }, data: { nickname: "m2" } });
  expect(named.ok()).toBeTruthy();
  const alice = await cliLogin(request, "alice-e2e-token", "alice-mine", "e2e-mine-alice");
  await sync(request, alice.token, [session("mine-s-al", "alice-private-session")]);
  await sync(request, alice.token, [session("mine-s-al", "alice-private-session")]);
});

test("test_AC23_mine_tab_lists_machines", async ({ page }) => {
  await signIn(page, "bob-e2e-token");
  await openMine(page);
  const named = page.locator("section.machine", { hasText: "mine-laptop" });
  await expect(named).toHaveCount(1);
  await expect(named).toContainText("m2");
  await expect(named).toContainText("alpha");
  await expect(named).toContainText("mine-first-session");
  await expect(named).toContainText("idle");
  await expect(named).toContainText("no step");
  await expect(page.locator("section.machine", { hasText: "mine-empty" })).toHaveCount(1);
  expect(await page.locator("section.machine").count()).toBeGreaterThanOrEqual(2);
});

test("test_AC23_empty_machine_text", async ({ page }) => {
  await signIn(page, "bob-e2e-token");
  await openMine(page);
  await expect(page.locator("section.machine", { hasText: "mine-empty" })).toContainText("no sessions");
});

test("test_AC23_no_machines_text", async ({ page }) => {
  await signIn(page, "carol-e2e-token");
  await openMine(page);
  await expect(page.getByText("No machines logged in as you yet. Run mesh login on each machine.")).toBeVisible();
  await expect(page.locator("section.machine")).toHaveCount(0);
});

test("test_AC23_other_users_me_not_on_live", async ({ page }) => {
  // Positive control: alice sees her own session on Live.
  await signIn(page, "alice-e2e-token");
  await expect(page.locator(".people")).toContainText("alice-private-session");
  await page.getByRole("button", { name: "Sign out" }).click();
  await signIn(page, "bob-e2e-token");
  await expect(page.locator(".people")).toContainText("alice");
  await expect(page.locator("body")).not.toContainText("alice-private-session");
});

test("test_AC23_new_session_within_20s", async ({ page, request }) => {
  test.setTimeout(45_000);
  await signIn(page, "bob-e2e-token");
  await openMine(page);
  await expect(page.locator("section.machine", { hasText: "mine-laptop" })).toContainText("mine-first-session");
  await sync(request, bobA.token, [
    session("mine-s1", "mine-first-session", { repo: { id: "example.org/team/alpha", name: "alpha" } }),
    session("mine-s2", "late-arrival", { lastEventAt: Date.now() }),
  ]);
  await expect(page.locator("section.machine", { hasText: "mine-laptop" })).toContainText("late-arrival", { timeout: 20_000 });
});

// MM-2 (AC-19): machine labels in the title line (`span.labels`) and a `labels` column for sessions.
test.describe("AC-19 labels on the Mine tab", () => {
  const ALPHA = { repo: { id: "example.org/team/alpha", name: "alpha" } };

  async function labelMachine(request: APIRequestContext, who: { token: string; machine: string }, labels: string[]): Promise<void> {
    const r = await request.post(`/v1/machines/${who.machine}/labels`, { headers: { authorization: `Bearer ${who.token}` }, data: { labels } });
    expect(r.status()).toBe(200);
  }

  /** The text of each cell of the row of `name`, keyed by its column header. */
  async function cells(page: Page, machine: string, name: string): Promise<Record<string, string>> {
    const section = page.locator("section.machine", { hasText: machine });
    const headers = (await section.locator("th").allTextContents()).map((t) => t.trim());
    const row = section.locator("tr", { hasText: name });
    const values = (await row.locator("td").allTextContents()).map((t) => t.trim());
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ""]));
  }

  test("test_AC19_machine_labels_span", async ({ page, request }) => {
    await labelMachine(request, bobA, ["perf-lab", "gpu"]);
    await signIn(page, "bob-e2e-token");
    await openMine(page);
    const labels = page.locator("section.machine", { hasText: "mine-laptop" }).locator("span.labels");
    await expect(labels).toHaveCount(1);
    await expect(labels).toHaveText("gpu, perf-lab");
  });

  test("test_AC19_unlabelled_machine_no_span", async ({ page, request }) => {
    await labelMachine(request, bobA, ["gpu"]);
    await signIn(page, "bob-e2e-token");
    await openMine(page);
    // Positive control: the labelled machine has the span.
    await expect(page.locator("section.machine", { hasText: "mine-laptop" }).locator("span.labels")).toHaveCount(1);
    await expect(page.locator("section.machine", { hasText: "mine-empty" }).locator("span.labels")).toHaveCount(0);
  });

  test("test_AC19_sessions_labels_column", async ({ page, request }) => {
    await sync(request, bobA.token, [session("mine-s1", "mine-first-session", { ...ALPHA, labels: ["perf"] }), session("mine-s3", "unlabelled-one", { lastEventAt: Date.now() })]);
    await signIn(page, "bob-e2e-token");
    await openMine(page);
    const section = page.locator("section.machine", { hasText: "mine-laptop" });
    await expect(section).toContainText("unlabelled-one");
    const headers = (await section.locator("th").allTextContents()).map((t) => t.trim());
    const at = headers.indexOf("labels");
    expect(at).toBeGreaterThan(0);
    expect(headers[at - 1]).toBe("step");
    expect(headers[at + 1]).toBe("age");
    expect((await cells(page, "mine-laptop", "mine-first-session")).labels).toBe("perf");
    expect((await cells(page, "mine-laptop", "unlabelled-one")).labels).toBe("");
  });

  test("test_AC19_live_refresh", async ({ page, request }) => {
    test.setTimeout(45_000);
    await sync(request, bobA.token, [session("mine-s1", "mine-first-session", { ...ALPHA, labels: ["perf"] })]);
    await signIn(page, "bob-e2e-token");
    await openMine(page);
    const row = page.locator("section.machine", { hasText: "mine-laptop" }).locator("tr", { hasText: "mine-first-session" });
    await expect(row).toContainText("perf");
    // What a daemon sends after `mesh label <s> zz`.
    await sync(request, bobA.token, [session("mine-s1", "mine-first-session", { ...ALPHA, labels: ["zz"], lastEventAt: Date.now() })]);
    await expect(row).toContainText("zz", { timeout: 20_000 });
  });
});
