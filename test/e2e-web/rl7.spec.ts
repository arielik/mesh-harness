// RL-7 AC-09 (web Roster: invalid front matter) and AC-13 (web goal header counts skipped steps).
// Runs under `pnpm test:web` (not part of `pnpm check`). Logs in as grace, whom no other spec asserts
// on; repo `git.example.com/e2e/rl7-roster`, agents `rl7-bad` and `rl7-good`. Written from the spec's
// contracts only (docs/specs/RL-7.md). Groups by `data-name`, steps by id.
import { createHash } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const H = (t: string) => sha(t.replace(/\r\n/g, "\n"));

const REPO = { id: "git.example.com/e2e/rl7-roster", name: "rl7-roster" };
const BAD = "---\nname: rl7-bad\ndescription: Validates: findings\n---\nYou validate.\n";
const GOOD = "---\ndescription: Good agent\n---\nYou review.\n";
const INVALID = "front matter is not valid YAML: RL7 sample at line 2, column 14";
const TOKEN = "grace-e2e-token";

async function cliLogin(request: APIRequestContext, hostname: string, install: string): Promise<{ token: string; machine: string }> {
  const r = await request.post("/auth/team/login", { data: { token: TOKEN, hostname, install } });
  expect(r.ok()).toBeTruthy();
  const j = await r.json();
  return { token: j.token as string, machine: j.machine as string };
}
const report = (name: string, text: string, over: Record<string, unknown> = {}) => ({ repo: REPO.id, kind: "claude", path: `.claude/agents/${name}.md`, name, hash: H(text), ...over });

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Token token").fill(TOKEN);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("test_AC09_web_roster_invalid", async ({ page, request }) => {
  const box = await cliLogin(request, "rl7-laptop", "e2e-rl7-laptop");
  const s = await request.post("/v1/sync", {
    headers: { authorization: `Bearer ${box.token}` },
    data: { events: [], counts: {}, sessions: [], machine: { share: "me", repos: [REPO], agents: [report("rl7-bad", BAD, { invalid: INVALID }), report("rl7-good", GOOD, { description: "Good agent" })] } },
  });
  expect(s.ok(), await s.text()).toBeTruthy();
  await signIn(page);
  await page.goto("/#/roster");
  const bad = page.locator('section.roster-group[data-name="rl7-bad"]');
  const good = page.locator('section.roster-group[data-name="rl7-good"]');
  await expect(bad).toHaveCount(1);
  await expect(good).toHaveCount(1);
  // Positive control: the valid group is rendered with its description.
  await expect(good).toContainText("Good agent");
  await expect(bad.locator("span.roster-flag", { hasText: /^invalid$/ })).toHaveCount(1);
  await expect(bad.locator(".roster-invalid")).toHaveText(`invalid: ${INVALID}`);
  await expect(good.locator("span.roster-flag", { hasText: /^invalid$/ })).toHaveCount(0);
  await expect(good.locator(".roster-invalid")).toHaveCount(0);
});

test("test_AC13_web_goal_header", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const box = await cliLogin(request, "rl7-goals", "e2e-rl7-goals");
  const auth = { authorization: `Bearer ${box.token}` };
  const repo = `rl7-${Date.now().toString(36)}`;
  const goal = await (await request.post("/v1/goals", { headers: auth, data: { title: "RL7 progress", primaryRepo: repo } })).json();
  const G = goal.id as string;
  // A clean audit: the two steps gated on open items are skipped, so the goal is done with 2 done (design, audit) + 2 skipped.
  const plan = await request.post(`/v1/goals/${G}/plan`, {
    headers: auth,
    data: {
      approve: true,
      steps: [
        { id: "audit", repo, kind: "implement", title: "audit", brief: "a", output: "review-record" },
        { id: "validate", repo, kind: "implement", title: "validate", brief: "v", deps: ["audit"], output: "review-record", when: { open: true }, consumes: ["open"] },
        { id: "recheck", repo, kind: "implement", title: "recheck", brief: "r", deps: ["audit"], output: "review-record", when: { open: true }, consumes: ["open"] },
      ],
    },
  });
  expect(plan.ok(), await plan.text()).toBeTruthy();
  expect((await request.post(`/v1/steps/${G}.audit/claim`, { headers: auth, data: {} })).ok()).toBeTruthy();
  const rv = await request.post(`/v1/steps/${G}.audit/review`, { headers: auth, data: { coverage: "complete", assessment: "clean", items: [], summary: "nothing found" } });
  expect(rv.status(), await rv.text()).toBe(201);
  const done = await request.post(`/v1/steps/${G}.audit/done`, { headers: auth, data: { summary: "ok" } });
  expect(done.ok(), await done.text()).toBeTruthy();
  const detail = await (await request.get(`/v1/goals/${G}`, { headers: auth })).json();
  // Control: the states the header counts.
  expect((detail.steps as { id: string; state: string }[]).map((x) => `${x.id}:${x.state}`).sort()).toStrictEqual([`${G}.audit:done`, `${G}.design:done`, `${G}.recheck:skipped`, `${G}.validate:skipped`]);
  await signIn(page);
  await page.goto(`/#/goal/${G}`);
  await expect(page.getByText(/· owner @grace · \d+\/\d+ steps done/)).toBeVisible();
  await expect(page.getByText(/^done · owner @grace · 4\/4 steps done/)).toBeVisible();
  expect(errors).toStrictEqual([]);
});
