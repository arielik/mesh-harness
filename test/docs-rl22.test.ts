// RL-22 AC-22: the 0.1.41 `error` texts kept beside the new `code`s, the code-less refusals, the
// features, the API registry and its OpenAPI document, and the docs (docs/specs/RL-22.md, §Codes,
// §/healthz, §Docs).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HUB_API, HUB_FEATURES, hubOpenApi, ON_BEHALF_OF_HEADER, SERVICE_SCOPES } from "../src/protocol/index.ts";
import { Ak, NOW } from "./helpers/attention-kit.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

let k: Ak | undefined;
afterEach(async () => {
  await k?.stop();
  k = undefined;
});

describe("RL-22 AC-22 codes keep the 0.1.41 texts", () => {
  it("test_AC22_error_texts", async () => {
    k = await Ak.start(NOW);
    const ak = k;
    const G = await ak.goal("ann", [{ id: "a" }, { id: "g", kind: "gate", gate: "R1", deps: ["a"] }]);
    const want = async (who: string, path: string, body: unknown, status: number, code: string, error: string) => {
      expect(await ak.call(who, "POST", path, body), path).toStrictEqual({ status, json: { error, code } });
    };
    await want("ann", "/v1/goals/G99/approve", {}, 404, "goal-unknown", "no goal G99");
    await want("ann", `/v1/goals/${G}/approve`, {}, 404, "plan-none", `no pending plan for ${G}`);
    await want("ann", `/v1/goals/${G}/approve`, { version: 1 }, 409, "plan-decided", "plan v1 is already approved");
    await want("ann", `/v1/goals/${G}/revise`, {}, 404, "plan-none", `no pending plan for ${G}`);
    await want("bob", `/v1/goals/${G}/replan`, {}, 403, "not-approver", `only the goal owner, approvers or admins can replan ${G}`);
    await want("bob", `/v1/goals/${G}/drop`, {}, 403, "not-approver", `only the goal owner, approvers or admins can drop ${G}`);
    await want("ann", `/v1/steps/${G}.a/approve`, {}, 409, "not-gate", `${G}.a is not a gate step`);
    await want("bob", `/v1/steps/${G}.g/approve`, {}, 403, "not-approver", `only the goal owner, approvers or admins decide ${G}.g`);
    await want("ann", `/v1/steps/${G}.g/approve`, {}, 409, "gate-not-ready", `${G}.g is blocked; a gate is decided when its dependencies are done`);
    await ak.patch(`${G}.g`, { state: "ready" });
    await want("ann", `/v1/steps/${G}.g/reject`, {}, 400, "reopen-required", "rejecting a gate needs the steps to reopen (reopen: [...])");
    await want("ann", `/v1/steps/${G}.g/reject`, { reopen: ["a"] }, 409, "reopen-unknown", `cannot reopen ${G}.a: no such done step`);
    await want("ann", `/v1/steps/${G}.a/resume`, {}, 409, "step-not-resumable", `${G}.a is ready, not parked or failed`);
    await want("bob", `/v1/steps/${G}.a/resume`, {}, 403, "not-approver", `only the goal owner, approvers or admins resume ${G}.a`);
    await want("ann", "/v1/steps/G99.a/resume", {}, 404, "step-unknown", "no step G99.a");
    await ak.patchGoal(G, { state: "dropped" });
    await want("ann", `/v1/goals/${G}/replan`, {}, 409, "goal-closed", `${G} is dropped`);
    // A goal-create refusal carries no code.
    const bad = await ak.call("ann", "POST", "/v1/goals", { title: "t", topics: ["nosuch"] });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.json).not.toHaveProperty("code");
  });
});

describe("RL-22 AC-22 registry, features, OpenAPI", () => {
  it("test_AC22_scopes_and_routes", () => {
    expect(SERVICE_SCOPES.slice(-3)).toStrictEqual(["goals:decide", "questions:answer", "sessions:message"]);
    const route = (m: string, p: string) => HUB_API.find((r) => r.method === m && r.path === p);
    const decide = ["/v1/goals/:id/approve", "/v1/goals/:id/revise", "/v1/goals/:id/replan", "/v1/steps/:id/approve", "/v1/steps/:id/reject", "/v1/steps/:id/resume", "/v1/steps/:id/park"];
    for (const p of decide) expect(route("POST", p), p).toMatchObject({ rule: "member", scope: "goals:decide", onBehalfOf: true, onBehalfOfRequired: true });
    expect(route("POST", "/v1/questions/:id/answer")).toMatchObject({ scope: "questions:answer", onBehalfOf: true, onBehalfOfRequired: true });
    expect(route("POST", "/v1/messages")).toMatchObject({ scope: "sessions:message", onBehalfOf: true, onBehalfOfRequired: true });
    for (const p of ["/v1/goals/:id/drop", "/v1/goals", "/v1/goals/from-preset"]) expect(route("POST", p), p).toMatchObject({ scope: "goals:write", onBehalfOf: true, onBehalfOfOptional: true });
    expect(route("GET", "/v1/attention")).toMatchObject({ scope: "goals:read" });
    expect(route("GET", "/v1/attention")?.onBehalfOf).toBeFalsy();
    expect(route("GET", "/v1/questions")).toMatchObject({ rule: "member", scope: "goals:read" });
    for (const f of ["decide-for", "questions-list", "step-park", "team-attention"]) expect(HUB_FEATURES, f).toContain(f);
    expect([...HUB_FEATURES]).toStrictEqual([...HUB_FEATURES].sort());
  });

  it("test_AC22_openapi", () => {
    type Op = { description: string; parameters?: { name: string; description?: string }[] };
    const doc = hubOpenApi() as { paths: Record<string, Record<string, Op>> };
    const hdr = (p: string, m = "post") => doc.paths[p]?.[m]?.parameters?.find((x) => x.name === ON_BEHALF_OF_HEADER)?.description ?? "";
    expect(hdr("/v1/steps/{id}/park")).toContain("required for a service on this route");
    expect(hdr("/v1/questions/{id}/answer")).toContain("required for a service on this route");
    expect(hdr("/v1/goals/{id}/drop")).toContain("optional");
    expect(hdr("/v1/goals")).toContain("optional");
    expect(doc.paths["/v1/goals/{id}/approve"]?.post?.description).toContain("`goals:decide`");
    expect(doc.paths["/v1/messages"]?.post?.description).toContain("`sessions:message`");
    expect(doc.paths["/v1/questions/{id}/answer"]?.post?.description).toContain("`questions:answer`");
    expect(doc.paths["/v1/questions"]?.get).toBeDefined();
    expect(doc.paths["/v1/steps/{id}/park"]?.post).toBeDefined();
    expect(JSON.parse(read("schemas/hub-api.openapi.json"))).toStrictEqual(JSON.parse(JSON.stringify(hubOpenApi())));
  });

  it("test_AC22_docs", () => {
    const auth = read("docs/guide/auth.md");
    for (const w of ["`goals:decide`", "`questions:answer`", "`sessions:message`", "**A service decides for a person**", "`decide-for`", "GET /v1/attention?team=1", "GET /v1/questions?state=open", "with their own login"]) expect(auth, w).toContain(w);
    for (const c of ["goal-unknown", "step-unknown", "question-unknown", "not-approver", "not-addressed", "plan-none", "plan-decided", "design-unknown", "goal-closed", "goal-held", "not-gate", "gate-not-ready", "reopen-required", "reopen-unknown", "step-not-resumable", "step-gate", "step-debrief", "step-parked", "step-not-parkable", "question-answered", "session-unknown", "step-unheld", "team-required", "bad-query", "team-forbidden"]) {
      expect(auth, c).toContain(`\`${c}\``);
    }
    const concepts = read("docs/guide/concepts.md");
    for (const w of ["mesh step park", "operator: ", "team-attention", "GET /v1/attention?team=1"]) expect(concepts, w).toContain(w);
    expect(read("docs/guide/howto.md")).toContain("mesh step park");
    const events = read("docs/events.md");
    expect(events).toContain("or a person parked it by hand (`operator: true`, `reason` starts with `operator: `)");
    expect(events).toContain("carry `via`");
    const ops = read("docs/guide/operations.md");
    expect(ops).toContain("0.1.42 (RL-22)");
    for (const f of ["`decide-for`", "`questions-list`", "`step-park`", "`team-attention`"]) expect(ops, f).toContain(f);
    const plan = read("docs/plan/implementation-plan.md");
    expect(plan).toContain("| `POST /v1/steps/:id/park` |");
    expect(plan).toContain("| `GET /v1/questions` |");
    expect(plan).toContain("`goals:decide`");
  });
});
