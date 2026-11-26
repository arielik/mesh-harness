// RL-25 AC-15: the alert webhook in the API registry and the OpenAPI document, the scope, the
// feature, `mesh hub token --scope alerts:notify`, and the docs (docs/specs/RL-25.md, "Docs").

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/hub/app.ts";
import type { HubService } from "../src/hub/service.ts";
import * as protocol from "../src/protocol/index.ts";
import { HUB_API, HUB_FEATURES, hubOpenApi, SERVICE_SCOPES } from "../src/protocol/index.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
function section(text: string, title: string): string {
  const start = text.search(new RegExp(`^## ${title}\\s*$`, "m"));
  expect(start, `## ${title}`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + `## ${title}`.length);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("RL-25 AC-15 route, scope, feature, docs", () => {
  it("test_AC15_route", () => {
    const P = protocol as unknown as Record<string, unknown>;
    const route = HUB_API.find((r) => r.method === "POST" && r.path === "/v1/alerts/webhook");
    expect(route).toMatchObject({ rule: "member", scope: "alerts:notify", tag: "admin" });
    expect(route?.onBehalfOf).toBeFalsy();
    expect(route?.body).toBe(P.AlertWebhook);
    expect(route?.response).toBe(P.AlertWebhookResult);
    const svc = { config: { url: "http://127.0.0.1:1" } } as unknown as HubService;
    const served = createApp(svc).routes.find((r) => r.method === "POST" && r.path === "/v1/alerts/webhook");
    expect(served).toMatchObject({ rule: "member", scope: "alerts:notify" });
    expect(served?.onBehalfOf).toBeFalsy();
  });

  it("test_AC15_scope_and_feature", () => {
    expect(SERVICE_SCOPES).toContain("alerts:notify");
    expect(SERVICE_SCOPES.indexOf("alerts:notify")).toBeGreaterThan(SERVICE_SCOPES.indexOf("steps:assign"));
    expect(HUB_FEATURES).toContain("alert-notify");
    expect([...HUB_FEATURES]).toStrictEqual([...HUB_FEATURES].sort());
  });

  it("test_AC15_openapi", () => {
    const committed = read("schemas/hub-api.openapi.json");
    expect(`${JSON.stringify(hubOpenApi(), null, 2)}\n`).toBe(committed);
    const op = (JSON.parse(committed) as { paths: Record<string, Record<string, { description: string; tags: string[] }>> }).paths["/v1/alerts/webhook"]?.post;
    expect(op?.description).toContain("`alerts:notify`");
    expect(op?.tags).toStrictEqual(["admin"]);
  });

  it("test_AC15_no_cost_field", () => {
    const R = (protocol as unknown as { AlertWebhookResult: { shape: Record<string, unknown> } }).AlertWebhookResult;
    for (const k of Object.keys(R.shape)) expect(k.toLowerCase(), k).not.toMatch(/cost|usd|price|budget/);
  });

  it("test_AC15_hub_token_cli", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-rl25-"));
    try {
      const run = promisify(execFile);
      const main = join(ROOT, "src", "main.ts");
      const env: NodeJS.ProcessEnv = { ...process.env, MESH_HUB_CONFIG: "" };
      delete env.MESH_HUB_DB;
      const config = join(dir, "mesh-hub.yaml");
      await run(process.execPath, [main, "hub", "init", "--users", "ann", "--config", config], { cwd: dir, env });
      const { stdout } = await run(process.execPath, [main, "hub", "token", "--config", config, "--service", "x", "--scope", "alerts:notify"], { cwd: dir, env });
      expect(stdout.trim().length).toBeGreaterThan(20);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("test_AC15_docs", () => {
    const auth = read("docs/guide/auth.md");
    for (const t of ["`alerts:notify`", "POST /v1/alerts/webhook", "`service-only`", "`alert-version`", "`alert-body`"]) expect(auth, t).toContain(t);
    const ops = read("docs/guide/operations.md");
    const alerts = section(ops, "Alerts from Alertmanager");
    for (const t of [
      "mesh hub token --service alertmanager --scope alerts:notify",
      "webhook_configs",
      "url: https://<hub>/v1/alerts/webhook",
      "send_resolved: true",
      "credentials_file: /etc/alertmanager/secrets/mesh-hub-alert-webhook/token",
      "`person`",
      "14 days",
      "4 hours",
      "24 hours",
      "mesh setup --notify off",
      "`alert-notify`",
      "`cancelled`",
    ])
      expect(alerts, t).toContain(t);
    const up = section(ops, "Upgrading to 0\\.1\\.\\d+");
    expect(up).toContain("(RL-25)");
    expect(up).toContain("schema 14");
    expect(up.indexOf("(RL-25)")).toBeLessThan(up.indexOf("0.1.23 has no release package."));
    expect(ops).toContain("`alert-notify`, `changes`");
    const events = read("docs/events.md");
    expect(events).toContain("| `alert.notified` |");
    const delivered = events.split("\n").find((l) => l.startsWith("| `message.delivered` |")) as string;
    for (const m of ["`off`", "`stale`", "`desktop`", "`terminal`", "`both`", "`no-channel`"]) expect(delivered, m).toContain(m);
    expect(read("docs/plan/implementation-plan.md")).toContain("| `POST /v1/alerts/webhook` |");
  });
});
