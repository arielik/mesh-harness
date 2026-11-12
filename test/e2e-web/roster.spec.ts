// RL-5 AC-22: the web Roster page (`#/roster`). Runs under `pnpm test:web` (not part of `pnpm check`).
// Logs in as erin, whom no other spec asserts on. Written from the spec's contracts only
// (docs/specs/RL-5.md, Web). Groups by `data-name`, copies by `data-key`, sources by `data-repo`.
import { createHash } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const H = (t: string) => sha(t.replace(/\r\n/g, "\n"));

const SRC = "git.example.com/e2e/agents";
const REPO = { id: "git.example.com/e2e/roster-a", name: "roster-a" };
const C1 = "e1".repeat(20);
const C2 = "e2".repeat(20);
const CAT_OLD = "---\ndescription: Reviews code\nmodel: sonnet\ntools: Read, Grep\nmesh-rules: [r.alpha, r.beta]\n---\nYou review.\n";
const CAT_NEW = CAT_OLD.replace("You review.", "You review carefully.");
const LINTER = "---\ndescription: Lints\n---\nYou lint.\n";
const LOCAL = CAT_OLD.replace("You review.", "You review locally.");

async function cliLogin(request: APIRequestContext, token: string, hostname: string, install: string): Promise<{ token: string; machine: string }> {
  const r = await request.post("/auth/team/login", { data: { token, hostname, install } });
  expect(r.ok()).toBeTruthy();
  const j = await r.json();
  return { token: j.token as string, machine: j.machine as string };
}
async function sync(request: APIRequestContext, token: string, machine: Record<string, unknown>): Promise<void> {
  const r = await request.post("/v1/sync", { headers: { authorization: `Bearer ${token}` }, data: { events: [], counts: {}, sessions: [], machine: { share: "me", ...machine } } });
  expect(r.ok(), await r.text()).toBeTruthy();
}
const report = (name: string, text: string, over: Record<string, unknown> = {}) => ({ repo: REPO.id, kind: "claude", path: `.claude/agents/${name}.md`, name, hash: H(text), ...over });

async function signIn(page: Page, token: string): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Token token").fill(token);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}
async function openRoster(page: Page): Promise<void> {
  const link = page.getByRole("link", { name: "Roster", exact: true });
  await link.click();
  await expect(page).toHaveURL(/#\/roster$/);
  await expect(link).toHaveClass(/\bactive\b/);
  await expect(page.locator("h2", { hasText: "Roster" })).toBeVisible();
}

test.describe.configure({ mode: "serial" });

let erinBox: { token: string; machine: string };
const reviewerPinned = () => report("reviewer", LOCAL, { pin: { source: SRC, commit: C1, hash: H(CAT_OLD) } });

async function seed(request: APIRequestContext): Promise<void> {
  const alice = await cliLogin(request, "alice-e2e-token", "roster-admin", "e2e-roster-admin");
  const saved = await request.post("/v1/catalog-sources", { headers: { authorization: `Bearer ${alice.token}` }, data: { repo: `https://${SRC}.git`, folder: "agents" } });
  expect([200, 201], await saved.text()).toContain(saved.status());
  const pusher = await cliLogin(request, "erin-e2e-token", "roster-pusher", "e2e-roster-pusher");
  await sync(request, pusher.token, { repos: [{ id: SRC, name: "agents" }] });
  for (const [commit, text] of [
    [C1, CAT_OLD],
    [C2, CAT_NEW],
  ] as const) {
    const p = await request.post("/v1/catalog-sources/push", {
      headers: { authorization: `Bearer ${pusher.token}` },
      data: { repo: SRC, commit, defs: [{ path: "agents/reviewer.md", text }, { path: "agents/linter.md", text: LINTER }] },
    });
    expect(p.ok(), await p.text()).toBeTruthy();
  }
  erinBox = await cliLogin(request, "erin-e2e-token", "roster-laptop", "e2e-roster-laptop");
  await sync(request, erinBox.token, { repos: [REPO], agents: [reviewerPinned()] });
}

test("test_AC22_empty_state", async ({ page }) => {
  await signIn(page, "erin-e2e-token");
  await openRoster(page);
  await expect(page.locator("p.empty", { hasText: "No agents on the roster yet." })).toBeVisible();
  await expect(page.locator("section.roster-group")).toHaveCount(0);
});

test("test_AC22_nav_and_render", async ({ page, request }) => {
  await seed(request);
  await signIn(page, "erin-e2e-token");
  await openRoster(page);
  const group = page.locator('section.roster-group[data-name="reviewer"]');
  await expect(group).toHaveCount(1);
  await expect(group.locator("h3")).toContainText("reviewer");
  await expect(group.locator("span.roster-flag")).toHaveText(["diverged", "pinned", "behind", "modified"]);
  const catalogVersion = group.locator(`div.roster-version[data-hash="${H(CAT_NEW)}"]`);
  await expect(catalogVersion).toHaveCount(1);
  for (const t of [H(CAT_NEW).slice(0, 12), "Reviews code", "sonnet", "tools: Read, Grep", "rules: r.alpha, r.beta"]) await expect(catalogVersion).toContainText(t);
  const local = group.locator('li.roster-copy[data-key="roster-a/reviewer"]');
  await expect(local).toHaveCount(1);
  for (const t of ["repo", `pin ${C1.slice(0, 7)}`, "behind", "modified"]) await expect(local).toContainText(t);
  await expect(group.locator('li.roster-copy[data-key="agents/reviewer"]')).toContainText(`catalog ${C2.slice(0, 7)}`);
  const linter = page.locator('section.roster-group[data-name="linter"]');
  await expect(linter).toHaveCount(1);
  await expect(linter.locator("span.roster-flag")).toHaveCount(0);
  const src = page.locator(`section.roster-sources li[data-repo="${SRC}"]`);
  await expect(src).toHaveCount(1);
  for (const t of [SRC, "agents", "2 agent(s)"]) await expect(src).toContainText(t);
});

test("test_AC22_filter", async ({ page }) => {
  await signIn(page, "erin-e2e-token");
  await openRoster(page);
  await expect(page.locator('section.roster-group[data-name="reviewer"]')).toHaveCount(1);
  await expect(page.locator('section.roster-group[data-name="linter"]')).toHaveCount(1);
  const filter = page.locator('input[name="roster-filter"]');
  await filter.fill("LINT");
  await expect(page.locator('section.roster-group[data-name="linter"]')).toHaveCount(1);
  await expect(page.locator('section.roster-group[data-name="reviewer"]')).toHaveCount(0);
  await filter.fill("zzz");
  await expect(page.locator("section.roster-group")).toHaveCount(0);
  await expect(page.locator("p.empty", { hasText: 'No agent matches "zzz".' })).toBeVisible();
  await filter.fill("");
  await expect(page.locator('section.roster-group[data-name="reviewer"]')).toHaveCount(1);
  await expect(page.locator('section.roster-group[data-name="linter"]')).toHaveCount(1);
});

test("test_AC22_live", async ({ page, request }) => {
  await signIn(page, "erin-e2e-token");
  await openRoster(page);
  await expect(page.locator('section.roster-group[data-name="reviewer"]')).toHaveCount(1);
  await expect(page.locator('section.roster-group[data-name="scribe"]')).toHaveCount(0);
  await sync(request, erinBox.token, { repos: [REPO], agents: [reviewerPinned(), report("scribe", "---\ndescription: Writes\n---\nYou write.\n")] });
  await expect(page.locator('section.roster-group[data-name="scribe"]')).toBeVisible({ timeout: 20_000 });
});

// Code review T3 (with S2): a version with `rules: []` and no model or tools renders no stray `0`.
test("test_AC22_empty_rules_no_zero", async ({ page, request }) => {
  const BARE = "---\ndescription: Bare agent\nmesh-rules: []\n---\nYou are bare.\n";
  await sync(request, erinBox.token, {
    repos: [REPO],
    agents: [reviewerPinned(), report("scribe", "---\ndescription: Writes\n---\nYou write.\n"), report("bare", BARE, { description: "Bare agent", rules: [] })],
  });
  await signIn(page, "erin-e2e-token");
  await openRoster(page);
  const version = page.locator(`section.roster-group[data-name="bare"] div.roster-version[data-hash="${H(BARE)}"]`);
  await expect(version).toHaveCount(1);
  // Positive controls: the version shows its hash12 and description, and a version with rules shows them.
  await expect(version).toContainText(H(BARE).slice(0, 12));
  await expect(version).toContainText("Bare agent");
  await expect(page.locator('section.roster-group[data-name="reviewer"] div.roster-version').first()).toContainText("rules: r.alpha, r.beta");
  // Every text node under the version element (nodeType 3), in document order.
  const texts = await version.evaluate((root) => {
    const out: string[] = [];
    const walk = (n: { nodeType: number; nodeValue: string | null; childNodes: ArrayLike<unknown> }): void => {
      if (n.nodeType === 3) out.push(n.nodeValue ?? "");
      for (let i = 0; i < n.childNodes.length; i++) walk(n.childNodes[i] as typeof n);
    };
    walk(root as unknown as Parameters<typeof walk>[0]);
    return out;
  });
  expect(texts.length).toBeGreaterThan(0);
  expect(texts.filter((t) => t.trim() === "0"), JSON.stringify(texts)).toStrictEqual([]);
  await expect(version).not.toContainText("rules:");
  await expect(version).not.toContainText("tools:");
});
