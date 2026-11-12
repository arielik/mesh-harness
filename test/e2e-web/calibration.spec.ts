// RL-6 AC-14: per-group statistics on the web Roster page (`#/roster`). Runs under `pnpm test:web`
// (not part of `pnpm check`). Logs in as frank, whom no other spec asserts on. Written from the spec's
// contracts only (docs/specs/RL-6.md, Web). Groups by `data-name`, rows by `data-key`/`data-hash`,
// cells by `data-col`.
import { createHash } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const H = (t: string) => sha(t.replace(/\r\n/g, "\n"));

const REPO = { id: "git.example.com/e2e/calib-a", name: "calib-a" };
const SCOUT = "---\ndescription: Scouts\n---\nYou scout.\n";
const IDLE = "---\ndescription: Idles\n---\nYou idle.\n";
const S = H(SCOUT);
const SCOUT_KEY = `${REPO.name}/scout`;
const TOKEN = "frank-e2e-token";

async function cliLogin(request: APIRequestContext, token: string, hostname: string, install: string): Promise<{ token: string; machine: string }> {
  const r = await request.post("/auth/team/login", { data: { token, hostname, install } });
  expect(r.ok()).toBeTruthy();
  const j = await r.json();
  return { token: j.token as string, machine: j.machine as string };
}
async function api(request: APIRequestContext, token: string, path: string, data: unknown, ok: number[] = [200, 201]): Promise<Record<string, unknown>> {
  const r = await request.post(path, { headers: { authorization: `Bearer ${token}` }, data });
  expect(ok, `${path}: ${await r.text()}`).toContain(r.status());
  return (await r.json()) as Record<string, unknown>;
}
const report = (name: string, text: string) => ({ repo: REPO.id, kind: "claude", path: `.claude/agents/${name}.md`, name, hash: H(text) });

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Token token").fill(TOKEN);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}
async function openRoster(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Roster", exact: true }).click();
  await expect(page).toHaveURL(/#\/roster$/);
}

const SEED_TITLE = "Calibration stats seed";

/**
 * frank's machine reports scout and idle; one done headless round of scout with telemetry and a
 * raising record of 2 items. Idempotent through the hub (a test may run in a fresh worker): the seed
 * goal is created once.
 */
async function seed(request: APIRequestContext): Promise<void> {
  const box = await cliLogin(request, TOKEN, "calib-laptop", "e2e-calib-laptop");
  await api(request, box.token, "/v1/sync", { events: [], counts: {}, sessions: [], machine: { share: "me", repos: [REPO], agents: [report("scout", SCOUT), report("idle", IDLE)] } }, [200]);
  const list = await request.get("/v1/goals", { headers: { authorization: `Bearer ${box.token}` } });
  expect(list.ok(), await list.text()).toBeTruthy();
  if (((await list.json()).goals as { title: string }[]).some((x) => x.title === SEED_TITLE)) return;
  const g = await api(request, box.token, "/v1/goals", { title: SEED_TITLE, primaryRepo: REPO.name }, [201]);
  const G = g.id as string;
  await api(
    request,
    box.token,
    `/v1/goals/${G}/plan`,
    { steps: [{ id: "scan", repo: REPO.name, kind: "review", title: "Scan", brief: "b", deps: [], mode: "headless", agent: "scout", output: "review-record" }], approve: true },
    [201],
  );
  const id = `${G}.scan`;
  await api(request, box.token, `/v1/steps/${id}/claim`, {}, [200]);
  const items = ["s.one", "s.two"].map((rule) => ({ key: { rule, path: "src/a.ts" }, title: `T-${rule}`, severity: "S3", category: "c", evidence: [] }));
  await api(request, box.token, `/v1/steps/${id}/review`, { coverage: "complete", assessment: "issues", items, dispositions: [], summary: "s", agent: { key: SCOUT_KEY, hash: S } }, [201]);
  await api(request, box.token, `/v1/steps/${id}/done`, { outcome: "done", summary: "ok" }, [200]);
  const telemetry = {
    runId: "calib-r1",
    agentKey: SCOUT_KEY,
    agentHash: S,
    profile: "read-only",
    profileHash: "f".repeat(64),
    turns: 3,
    turnsApprox: false,
    tokensIn: 10,
    tokensOut: 20,
    cacheRead: 0,
    cacheWrite: 0,
    costUsdEstimate: 0.1234,
    durationMs: 65_000,
    exit: "success",
    permissionDenials: { count: 0, tools: [] },
    undeclaredRules: 0,
    redactions: 0,
  };
  await api(request, box.token, `/v1/steps/${id}/run`, { state: "finished", runId: "calib-r1", round: 1, telemetry }, [200]);
}
const group = (page: Page, name: string) => page.locator(`section.roster-group[data-name="${name}"]`);

test("test_AC14_stats_table", async ({ page, request }) => {
  await seed(request);
  await signIn(page);
  await openRoster(page);
  const g = group(page, "scout");
  await expect(g).toHaveCount(1);
  const toggle = g.locator("button.roster-stats-toggle");
  await expect(toggle).toHaveText("Stats");
  await toggle.click();
  const table = g.locator("table.roster-stats");
  await expect(table).toBeVisible();
  const row = table.locator(`tr[data-key="${SCOUT_KEY}"][data-hash="${S}"]`);
  await expect(row).toHaveCount(1);
  const want: Record<string, string> = {
    hash: S.slice(0, 12),
    runs: "1",
    failures: "0",
    cost: "$0.12",
    duration: "65.0s",
    raised: "2",
    accepted: "0",
    "dismissed-agents": "0",
    "dismissed-people": "0",
    reinstated: "0",
    carried: "0",
    regressions: "0",
    undeclared: "0",
    uncalibrated: "0",
    calibration: "-",
  };
  for (const [col, text] of Object.entries(want)) await expect(row.locator(`td[data-col="${col}"]`), col).toHaveText(text);
});

test("test_AC14_toggle_no_reload", async ({ page, request }) => {
  await seed(request);
  const statsCalls: string[] = [];
  page.on("request", (r) => {
    if (/\/v1\/agents\/[^/]+\/stats/.test(r.url())) statsCalls.push(r.url());
  });
  await signIn(page);
  await openRoster(page);
  const g = group(page, "scout");
  await g.locator("button.roster-stats-toggle").click();
  await expect(g.locator("table.roster-stats")).toBeVisible();
  expect(statsCalls).toHaveLength(1);
  expect(statsCalls[0]).toContain(`/v1/agents/${encodeURIComponent(SCOUT_KEY)}/stats`);
  expect(statsCalls[0]).toContain("days=30");
  await g.locator("button.roster-stats-toggle").click();
  await expect(g.locator("table.roster-stats")).toHaveCount(0);
  expect(statsCalls).toHaveLength(1);
});

test("test_AC14_empty", async ({ page, request }) => {
  await seed(request);
  await signIn(page);
  await openRoster(page);
  const idle = group(page, "idle");
  await expect(idle).toHaveCount(1);
  await idle.locator("button.roster-stats-toggle").click();
  await expect(idle.locator("p.empty", { hasText: "No runs or findings in the last 30 days." })).toBeVisible();
  await expect(idle.locator("table.roster-stats tr[data-key]")).toHaveCount(0);
  // Control: scout's group shows its row.
  const scout = group(page, "scout");
  await scout.locator("button.roster-stats-toggle").click();
  await expect(scout.locator(`table.roster-stats tr[data-key="${SCOUT_KEY}"]`)).toHaveCount(1);
});

test("test_AC14_error", async ({ page, request }) => {
  await seed(request);
  await page.route("**/v1/agents/*/stats*", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) }));
  await signIn(page);
  await openRoster(page);
  const g = group(page, "scout");
  await g.locator("button.roster-stats-toggle").click();
  await expect(g.locator("p.error")).toHaveText("boom");
  await expect(g.locator("table.roster-stats tr[data-key]")).toHaveCount(0);
});
