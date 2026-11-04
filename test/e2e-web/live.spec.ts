// Smoke test of the hub dashboard (task 2.10): sign in, see the Live page, approve a plan.
import { expect, test, type APIRequestContext } from "@playwright/test";

async function cliToken(request: APIRequestContext, token: string): Promise<string> {
  const r = await request.post("/auth/team/login", { data: { token, hostname: "e2e" } });
  expect(r.ok()).toBeTruthy();
  return (await r.json()).token as string;
}

test("sign in, see the Live page, approve a pending plan", async ({ page, request }) => {
  const bob = await cliToken(request, "bob-e2e-token");
  const auth = { authorization: `Bearer ${bob}` };
  const goal = await (await request.post("/v1/goals", { headers: auth, data: { title: "IPv6 underlay", primaryRepo: "frr-dplane-ovs" } })).json();
  const plan = await request.post(`/v1/goals/${goal.id}/plan`, {
    headers: auth,
    data: { steps: [{ id: "proto", repo: "proto-defs", kind: "implement", title: "proto", brief: "add fields" }] },
  });
  expect(plan.ok()).toBeTruthy();

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "mesh" })).toBeVisible();
  await page.getByLabel("Token token").fill("alice-e2e-token");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByText("Needs attention (1)")).toBeVisible();
  await expect(page.getByText(`Plan v1 for ${goal.id} "IPv6 underlay" awaits approval`)).toBeVisible();
  await expect(page.locator(".goals")).toContainText("IPv6 underlay");
  await expect(page.locator(".people")).toContainText("bob");

  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Nothing needs you.")).toBeVisible();
  await expect(page.locator(".goals")).toContainText("in progress");
  await expect(page.locator(".activity")).toContainText(`approved plan v1 for ${goal.id}`);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("a cross-origin write with the session cookie is refused", async ({ page, request }) => {
  await page.goto("/");
  await page.getByLabel("Token token").fill("alice-e2e-token");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(/Needs attention/)).toBeVisible();
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name === "mesh_session");
  expect(session?.httpOnly).toBe(true);
  const r = await request.post("/v1/goals", { headers: { cookie: `mesh_session=${session?.value}`, origin: "http://evil.example" }, data: { title: "x" } });
  expect(r.status()).toBe(403);
});
