// Goals board and Goal page (task 3.5): design → approve from the web, the DAG, step details, revise.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

async function bobApi(request: APIRequestContext) {
  const r = await request.post("/auth/team/login", { data: { token: "bob-e2e-token", hostname: "e2e" } });
  return { authorization: `Bearer ${(await r.json()).token}` };
}

async function goalWithPlan(request: APIRequestContext, title: string) {
  const auth = await bobApi(request);
  const goal = await (await request.post("/v1/goals", { headers: auth, data: { title, primaryRepo: "frr-dplane-ovs" } })).json();
  const plan = await request.post(`/v1/goals/${goal.id}/plan`, {
    headers: auth,
    data: {
      design_ref: "frr-dplane-ovs@main:docs/design/x.md",
      steps: [
        { id: "proto", repo: "proto-defs", kind: "implement", title: "proto", brief: "Add the v6 fields to the proto." },
        { id: "dplane", repo: "frr-dplane-ovs", kind: "implement", title: "dplane", brief: "Program v6 next hops.", deps: ["proto"] },
        { id: "agent", repo: "vpc-node-agent", kind: "implement", title: "agent", brief: "Send v6 config.", deps: ["proto"] },
      ],
    },
  });
  expect(plan.ok()).toBeTruthy();
  return goal.id as string;
}

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Token token").fill("alice-e2e-token");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(/Needs attention/)).toBeVisible();
}

test("approve a plan from the Goal page and inspect the DAG", async ({ page, request }) => {
  const id = await goalWithPlan(request, "Board approve");
  await signIn(page);
  await page.getByRole("link", { name: "Goals" }).click();
  const column = page.locator(".column", { hasText: "Awaiting approval" });
  await expect(column).toContainText("Board approve");
  await column.getByRole("link", { name: /Board approve/ }).click();

  await expect(page.getByText(`${id} · Board approve`)).toBeVisible();
  await expect(page.getByText("Plan v1 awaits a decision")).toBeVisible();
  await page.getByRole("button", { name: "Approve plan v1" }).click();

  await expect(page.locator(`[data-step="${id}.proto"]`)).toBeVisible();
  await expect(page.locator(`[data-step="${id}.proto"]`)).toContainText("ready");
  await expect(page.locator(`[data-step="${id}.dplane"]`)).toContainText("blocked");
  await page.locator(`[data-step="${id}.proto"]`).click();
  await expect(page.getByLabel("step details")).toContainText("Add the v6 fields to the proto.");
  await expect(page.getByLabel("step details")).toContainText(`mesh run proto-defs --step ${id}.proto`);

  await page.getByRole("button", { name: "Timeline" }).click();
  await expect(page.getByLabel("timeline")).toContainText(`approved plan v1 for ${id}`);
  await page.getByRole("button", { name: /^Design/ }).click();
  await expect(page.locator(".plan").first()).toContainText("approved");
});

test("ask for changes with a comment", async ({ page, request }) => {
  const id = await goalWithPlan(request, "Board revise");
  await signIn(page);
  await page.goto(`/#/goal/${id}`);
  await expect(page.getByRole("button", { name: "Ask for changes" })).toBeDisabled();
  await page.getByLabel("Decision comment").fill("split the dplane tests out");
  await page.getByRole("button", { name: "Ask for changes" }).click();
  await expect(page.getByText(/^design · owner @bob/)).toBeVisible();
  await expect(page.locator(".plan").first()).toContainText("revised");
  await expect(page.locator(".plan").first()).toContainText("split the dplane tests out");
});

test("create a goal from the board", async ({ page }) => {
  await signIn(page);
  await page.goto("/#/goals");
  await page.getByLabel("New goal title").fill("Made in the browser");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator(".column", { hasText: "Backlog" })).toContainText("Made in the browser");
});

test("decide a gate step and resume a parked one on the Goal page", async ({ page, request }) => {
  const auth = await bobApi(request);
  const goal = await (await request.post("/v1/goals", { headers: auth, data: { title: "Gates", primaryRepo: "frr" } })).json();
  const plan = await request.post(`/v1/goals/${goal.id}/plan`, {
    headers: auth,
    data: {
      approve: true,
      steps: [
        { id: "build", repo: "frr", kind: "implement", title: "build", brief: "b" },
        { id: "verify", repo: "frr", kind: "verify", title: "verify", brief: "v", deps: ["build"], route: { infra: "park" } },
        { id: "r3", repo: "frr", kind: "gate", gate: "R3", title: "R3", brief: "approve", deps: ["build"] },
      ],
    },
  });
  expect(plan.ok()).toBeTruthy();
  for (const [id, body] of [
    ["build", { summary: "built" }],
    ["verify", { summary: "lane down", verdict: "fail", failures: [{ bucket: "infra" }] }],
  ] as const) {
    expect((await request.post(`/v1/steps/${goal.id}.${id}/claim`, { headers: auth, data: {} })).ok()).toBeTruthy();
    expect((await request.post(`/v1/steps/${goal.id}.${id}/done`, { headers: auth, data: body })).ok()).toBeTruthy();
  }
  await signIn(page);
  await page.goto(`/#/goal/${goal.id}`);
  await expect(page.getByLabel("step stages")).toContainText("needs a person 2");
  await page.locator(`[data-step="${goal.id}.r3"]`).click();
  await page.getByLabel("Gate comment").fill("landing looks good");
  // Alice is an admin here, so she may decide Bob's gate.
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByLabel("rounds")).toContainText("gate by @alice");
  await expect(page.getByLabel("step stages")).toContainText("needs a person 1");
  await page.locator(`[data-step="${goal.id}.verify"]`).click();
  await expect(page.getByLabel("parked")).toContainText("infra: routed to a person");
  await expect(page.getByLabel("rounds")).toContainText("infra");
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.locator(`[data-step="${goal.id}.verify"]`)).toContainText("ready");
});
