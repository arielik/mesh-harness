// MM-1 (AC-23): the web Mine tab lists the signed-in user's machines and their sessions; another
// user's `me` session stays off Live. Runs under `pnpm test:web` (not part of `pnpm check`).
import { createHash } from "node:crypto";
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
  await page.getByRole("link", { name: "Mine", exact: true }).click();
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

// MM-3 (AC-32): `Assigned to you` on the Mine tab (one `li.offer` per open offer to the user's
// machines, with Decline), and the `offer` item of the Live attention list.
test("test_AC32_empty", async ({ page }) => {
  // Nothing in this file offers a step to alice's machines.
  await signIn(page, "alice-e2e-token");
  await openMine(page);
  // Positive control: alice's machine is listed, so the tab has loaded.
  await expect(page.locator("section.machine", { hasText: "alice-mine" })).toHaveCount(1);
  const section = page.locator("section.offers");
  await expect(section.getByRole("heading", { name: "Assigned to you" })).toBeVisible();
  await expect(section.locator("p", { hasText: "Nothing is assigned to you." })).toBeVisible();
  await expect(section.locator("li.offer")).toHaveCount(0);
});

test.describe("AC-32 Assigned to you", () => {
  let G = "";
  /** Steps offered by bob to his machine `m2` (mine-laptop). */
  let rowStep = "";
  let liveStep = "";

  const stepOf = async (request: APIRequestContext, id: string) => {
    const r = await request.get(`/v1/steps/${id}`, { headers: { authorization: `Bearer ${bobA.token}` } });
    expect(r.ok()).toBeTruthy();
    return (await r.json()).context.step;
  };

  test.beforeAll(async ({ request }) => {
    const auth = { authorization: `Bearer ${bobA.token}` };
    const goal = await request.post("/v1/goals", { headers: auth, data: { title: "Offers for bob", primaryRepo: "alpha" } });
    expect(goal.ok()).toBeTruthy();
    G = (await goal.json()).id as string;
    const plan = await request.post(`/v1/goals/${G}/plan`, {
      headers: auth,
      data: {
        approve: true,
        steps: [
          { id: "row", repo: "alpha", kind: "implement", title: "Offer row title", brief: "r" },
          { id: "live", repo: "alpha", kind: "implement", title: "Offer live title", brief: "l" },
        ],
      },
    });
    expect(plan.ok()).toBeTruthy();
    rowStep = `${G}.row`;
    liveStep = `${G}.live`;
    for (const id of [rowStep, liveStep]) {
      const r = await request.post(`/v1/steps/${id}/assign`, { headers: auth, data: { to: "m2" } });
      expect(r.status()).toBe(200);
    }
  });

  test("test_AC32_mine_offer_row", async ({ page }) => {
    await signIn(page, "bob-e2e-token");
    await openMine(page);
    const section = page.locator("section.offers");
    await expect(section).toHaveCount(1);
    await expect(section.getByRole("heading", { name: "Assigned to you" })).toBeVisible();
    // Above the machines.
    await expect(page.locator("section.machine").first()).toBeVisible();
    const offersBox = await section.boundingBox();
    const machineBox = await page.locator("section.machine").first().boundingBox();
    expect(offersBox && machineBox && offersBox.y < machineBox.y).toBeTruthy();
    const row = section.locator("li.offer", { hasText: rowStep });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Offer row title");
    await expect(row).toContainText("from @bob");
    await expect(row).toContainText("to m2");
    await expect(row.locator("code")).toHaveText(`mesh accept ${rowStep}`);
    await expect(row.getByRole("button", { name: "Decline" })).toBeVisible();
    await expect(section).not.toContainText("Nothing is assigned to you.");
  });

  test("test_AC32_decline", async ({ page, request }) => {
    test.setTimeout(45_000);
    await signIn(page, "bob-e2e-token");
    await openMine(page);
    const row = page.locator("section.offers li.offer", { hasText: rowStep });
    // Positive control: the row is there before the click.
    await expect(row).toHaveCount(1);
    const declined = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(`/v1/steps/${rowStep}/decline`));
    await row.getByRole("button", { name: "Decline" }).click();
    expect((await declined).status()).toBe(200);
    // Refetched after the decline (well before the 15 s refresh), and within the spec's 20 s.
    await expect(row).toHaveCount(0, { timeout: 3_000 });
    expect((await stepOf(request, rowStep)).offer.state).toBe("declined");
    // The other offer stays listed.
    await expect(page.locator("section.offers li.offer", { hasText: liveStep })).toHaveCount(1);
  });

  test("test_AC32_live_attention_code", async ({ page }) => {
    await signIn(page, "bob-e2e-token");
    const item = page.locator("li.att-offer", { hasText: liveStep });
    await expect(item).toHaveCount(1);
    await expect(item.locator("code")).toHaveText(`mesh accept ${liveStep}`);
  });
});

// RL-3 AC-23: the Pulses section of the Mine page (read-only). The e2e hub is shared: pulses are
// found by `data-pulse`, never counted. Written from the spec's contracts only (docs/specs/RL-3.md).
test.describe("AC-23 pulses on the Mine page", () => {
  const PRESET = 'description: One step\nsteps:\n  - { id: run, kind: implement, repo: "{repo}", title: "Run {repo}", brief: "Do it." }\n';
  const title = `pulse-${Math.random().toString(36).slice(2, 10)}`;
  let mine = "";
  let foreign = "";

  const create = async (request: APIRequestContext, token: string, t: string): Promise<string> => {
    const sha = createHash("sha256").update(PRESET, "utf8").digest("hex");
    const r = await request.post("/v1/pulses", {
      headers: { authorization: `Bearer ${token}` },
      data: { title: t, preset: { name: "one-step", text: PRESET, sha256: sha }, params: { repo: "alpha" }, when: { every: "1d" } },
    });
    expect(r.status()).toBe(201);
    return (await r.json()).id as string;
  };

  test.beforeAll(async ({ request }) => {
    mine = await create(request, bobA.token, title);
    const alice = await cliLogin(request, "alice-e2e-token", "alice-pulse", "e2e-pulse-alice");
    foreign = await create(request, alice.token, `${title}-alice`);
  });

  test("test_AC23_pulse_shown", async ({ page }) => {
    await signIn(page, "bob-e2e-token");
    await openMine(page);
    const section = page.locator("section.pulses");
    await expect(section.getByRole("heading", { name: "Pulses" })).toBeVisible();
    // After "Assigned to you" in the page order.
    await expect(page.locator("xpath=//section[contains(concat(' ', @class, ' '), ' offers ')]/following::section[contains(concat(' ', @class, ' '), ' pulses ')]")).toHaveCount(1);
    const el = section.locator(`div.pulse[data-pulse="${mine}"]`);
    await expect(el).toHaveCount(1);
    for (const t of [mine, title, "every 1d", "active", "next "]) await expect(el).toContainText(t);
  });

  test("test_AC23_slots", async ({ page, request }) => {
    const auth = { authorization: `Bearer ${bobA.token}` };
    const first = await request.post(`/v1/pulses/${mine}/fire`, { headers: auth });
    expect(first.status()).toBe(201);
    const f = (await first.json()).slot;
    expect(f.state).toBe("fired");
    const second = await request.post(`/v1/pulses/${mine}/fire`, { headers: auth });
    expect(second.status()).toBe(201);
    expect((await second.json()).slot.state).toBe("skipped");
    await signIn(page, "bob-e2e-token");
    await openMine(page);
    const el = page.locator(`div.pulse[data-pulse="${mine}"]`);
    const fired = el.locator(`li[data-slot="${f.slot}"]`);
    await expect(fired).toHaveClass(/\bslot-fired\b/);
    await expect(fired).toContainText("fired");
    await expect(fired).toContainText(f.goal as string);
    const skipped = el.locator("li[data-slot].slot-skipped");
    await expect(skipped).toHaveCount(1);
    await expect(skipped).toContainText("skipped");
    await expect(skipped).toContainText("(overlap)");
  });

  test("test_AC23_foreign_hidden", async ({ page }) => {
    await signIn(page, "bob-e2e-token");
    await openMine(page);
    // Positive control: bob's own pulse is shown.
    await expect(page.locator(`div.pulse[data-pulse="${mine}"]`)).toHaveCount(1);
    await expect(page.locator(`div.pulse[data-pulse="${foreign}"]`)).toHaveCount(0);
  });

  test("test_AC23_empty", async ({ page }) => {
    await signIn(page, "carol-e2e-token");
    await openMine(page);
    await expect(page.locator("section.pulses").getByText("No pulses. Create one with mesh pulse add.")).toBeVisible();
    await expect(page.locator("section.pulses div.pulse")).toHaveCount(0);
  });

  test("test_AC23_read_only", async ({ page }) => {
    await signIn(page, "bob-e2e-token");
    await openMine(page);
    const el = page.locator(`div.pulse[data-pulse="${mine}"]`);
    await expect(el).toHaveCount(1);
    await expect(el.locator("button")).toHaveCount(0);
  });
});
