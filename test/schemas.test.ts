import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HUB_API, hubOpenApi, jsonSchemas, MESH_SKILL } from "../src/protocol/index.ts";
import { createApp } from "../src/hub/app.ts";
import type { HubService } from "../src/hub/index.ts";

describe("published JSON Schemas", () => {
  it("match the protocol (run `pnpm schemas` after changing src/protocol)", () => {
    for (const [name, schema] of Object.entries(jsonSchemas())) {
      const committed = readFileSync(join(import.meta.dirname, "..", "schemas", `${name}.json`), "utf8");
      expect(`${JSON.stringify(schema, null, 2)}\n`, `schemas/${name}.json is out of date: run pnpm schemas`).toBe(committed);
    }
  });
});

describe("hub API document", () => {
  it("is up to date (run `pnpm schemas`)", () => {
    const committed = readFileSync(join(import.meta.dirname, "..", "schemas", "hub-api.openapi.json"), "utf8");
    expect(`${JSON.stringify(hubOpenApi(), null, 2)}\n`).toBe(committed);
  });

  it("lists exactly the routes the hub serves, with the same rule", () => {
    const svc = { config: { url: "http://127.0.0.1:1" } } as unknown as HubService;
    const served = createApp(svc).routes.map((r) => `${r.method} ${r.path} ${r.rule}`).sort();
    const documented = HUB_API.map((r) => `${r.method} ${r.path} ${r.rule}`).sort();
    expect(documented).toEqual(served);
  });

  it("is a valid-looking OpenAPI 3.1 document", () => {
    const doc = hubOpenApi() as { openapi: string; paths: Record<string, Record<string, { operationId: string }>> };
    expect(doc.openapi).toBe("3.1.0");
    const ids = Object.values(doc.paths).flatMap((ops) => Object.values(ops).map((o) => o.operationId));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("skills/mesh/SKILL.md", () => {
  it("matches the skill mesh setup installs (run `pnpm schemas`)", () => {
    expect(readFileSync(join(import.meta.dirname, "..", "skills", "mesh", "SKILL.md"), "utf8")).toBe(MESH_SKILL);
  });
});

// MM-1 (AC-24, AC-25, AC-26).
const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("AC-24 OpenAPI and route table", () => {
  type Op = { summary?: string; description?: string; operationId: string };
  const doc = () => hubOpenApi() as { paths: Record<string, Record<string, Op>> };

  it("test_AC24_openapi_up_to_date", () => {
    expect(`${JSON.stringify(hubOpenApi(), null, 2)}\n`).toBe(read("schemas/hub-api.openapi.json"));
    const committed = JSON.parse(read("schemas/hub-api.openapi.json")) as { paths: Record<string, unknown> };
    expect(Object.keys(committed.paths)).toContain("/v1/fleet");
    expect(Object.keys(committed.paths)).toContain("/v1/machines/{id}/name");
  });

  it("test_AC24_openapi_lists_fleet", () => {
    const op = doc().paths["/v1/fleet"]?.get;
    expect(op).toBeDefined();
    expect(JSON.stringify(op)).toContain("live:read");
  });

  it("test_AC24_openapi_lists_name", () => {
    expect(doc().paths["/v1/machines/{id}/name"]?.post).toBeDefined();
  });

  it("test_AC24_route_table_method_path_rule_scope", () => {
    const svc = { config: { url: "http://127.0.0.1:1" } } as unknown as HubService;
    const served = createApp(svc).routes.map((r) => `${r.method} ${r.path} ${r.rule} ${r.scope ?? "-"}`).sort();
    const documented = HUB_API.map((r) => `${r.method} ${r.path} ${r.rule} ${r.scope ?? "-"}`).sort();
    // Positive control: the pre-existing live route is in the table.
    expect(documented).toContain("GET /v1/live member live:read");
    expect(documented).toContain("GET /v1/fleet member live:read");
    expect(documented).toContain("POST /v1/machines/:id/name member -");
    expect(documented).toEqual(served);
  });
});

describe("AC-25 docs and skill", () => {
  it("test_AC25_skill_mentions_fleet", () => {
    expect(MESH_SKILL.length).toBeGreaterThan(0);
    expect(MESH_SKILL).toContain("mesh_fleet");
    expect(MESH_SKILL).toContain("mesh machines");
  });

  it("test_AC25_skill_file_equal", () => {
    const file = read("skills/mesh/SKILL.md");
    expect(file).toContain("mesh_fleet");
    expect(file).toBe(MESH_SKILL);
  });

  it("test_AC25_install_guide_levels", () => {
    const install = read("docs/guide/install.md");
    expect(install.length).toBeGreaterThan(0);
    for (const t of ["`steps`", "`me`", "`all`", "--share-sessions me"]) expect(install).toContain(t);
    expect(install).toMatch(/`me`[^\n]*default[^\n]*new setups|default[^\n]*new setups[^\n]*`me`/);
  });

  it("test_AC25_concepts_howto", () => {
    const concepts = read("docs/guide/concepts.md");
    const howto = read("docs/guide/howto.md");
    expect(concepts.length).toBeGreaterThan(0);
    expect(howto.length).toBeGreaterThan(0);
    expect(concepts).toContain("mesh machines");
    expect(howto).toContain("mesh machines");
    for (const t of ["See all your machines", "mesh machine name", "workspaceRoots", "Mine"]) expect(howto).toContain(t);
  });

  it("test_AC25_plan_routes", () => {
    const plan = read("docs/plan/implementation-plan.md");
    expect(plan.length).toBeGreaterThan(0);
    expect(plan).toContain("GET /v1/fleet");
    expect(plan).toContain("POST /v1/machines/:id/name");
  });

  it("test_AC25_events_doc", () => {
    const events = read("docs/events.md");
    expect(events.length).toBeGreaterThan(0);
    expect(events).toContain("machine.named");
  });
});

// MM-2 (AC-20, AC-21, AC-22). The MM-1 version pin (AC-26, 0.1.9) is superseded by AC-22.

describe("AC-20 OpenAPI and route table (labels)", () => {
  type Op = { tags?: string[]; requestBody?: unknown; operationId: string };
  const doc = () => hubOpenApi() as { paths: Record<string, Record<string, Op>> };

  it("test_AC20_openapi_fresh", () => {
    expect(`${JSON.stringify(hubOpenApi(), null, 2)}\n`).toBe(read("schemas/hub-api.openapi.json"));
    const committed = JSON.parse(read("schemas/hub-api.openapi.json")) as { paths: Record<string, unknown> };
    expect(Object.keys(committed.paths)).toContain("/v1/machines/{id}/labels");
  });

  it("test_AC20_openapi_lists_labels_route", () => {
    const op = doc().paths["/v1/machines/{id}/labels"]?.post;
    expect(op).toBeDefined();
    expect(op?.tags).toContain("daemon");
    expect(op?.requestBody).toBeDefined();
    expect(JSON.stringify(op?.requestBody)).toMatch(/labels/);
    expect(JSON.stringify(op?.requestBody)).toMatch(/add/);
    expect(JSON.stringify(op?.requestBody)).toMatch(/remove/);
  });

  it("test_AC20_HUB_API_matches_app", () => {
    const svc = { config: { url: "http://127.0.0.1:1" } } as unknown as HubService;
    const served = createApp(svc).routes.map((r) => `${r.method} ${r.path} ${r.rule} ${r.scope ?? "-"}`).sort();
    const documented = HUB_API.map((r) => `${r.method} ${r.path} ${r.rule} ${r.scope ?? "-"}`).sort();
    expect(documented).toContain("POST /v1/machines/:id/name member -");
    expect(documented).toContain("POST /v1/machines/:id/labels member -");
    expect(HUB_API.find((r) => r.method === "POST" && r.path === "/v1/machines/:id/labels")?.tag).toBe("daemon");
    expect(documented).toEqual(served);
  });
});

describe("AC-21 docs and skill (labels)", () => {
  it("test_AC21_skill_mentions_labels", () => {
    for (const t of ["mesh label", ".mesh/agent.yaml", "mesh machines --label"]) expect(MESH_SKILL).toContain(t);
  });

  it("test_AC21_skill_file_equals", () => {
    const file = read("skills/mesh/SKILL.md");
    expect(file).toContain("mesh label");
    expect(file).toBe(MESH_SKILL);
  });

  it("test_AC21_docs_mention", () => {
    const concepts = read("docs/guide/concepts.md");
    // concepts.md is a glossary: a "Labels" heading or a bold "**Label.**" entry.
    expect(concepts).toMatch(/^#+ .*Labels|^\*\*Labels?\.\*\*/m);
    expect(concepts).toContain(".mesh/agent.yaml");
    expect(concepts).toContain("not a topic");
    const howto = read("docs/guide/howto.md");
    for (const t of ["Label sessions and machines", ".mesh/agent.yaml", "mesh run", "--label", "mesh label", "mesh machine label", "mesh machines --label"]) expect(howto).toContain(t);
    const install = read("docs/guide/install.md");
    const hubSees = install.slice(install.indexOf("What the hub sees"));
    expect(install).toContain("What the hub sees");
    expect(hubSees).toMatch(/label/i);
    expect(read("docs/plan/implementation-plan.md")).toContain("POST /v1/machines/:id/labels");
    expect(read("docs/events.md")).toContain("machine.labelled");
  });
});

describe("AC-22 version and placement", () => {
  // The MM-2 version pin (0.1.10) is superseded by MM-3 AC-34 (test_AC34_version below).

  it("test_AC22_placement", async () => {
    const protocol = (await import("../src/protocol/index.ts")) as Record<string, unknown>;
    for (const name of ["parseLabels", "Label", "LABEL_RULE", "MAX_LABELS"]) expect(protocol[name], name).toBeDefined();
    const core = (await import("../src/core/index.ts")) as Record<string, unknown>;
    expect(typeof core.filterFleet).toBe("function");
    // Where `.mesh/agent.yaml` is read (src/daemon) is left to review and `pnpm boundaries`:
    // these tests do not assert on source text.
  });
});

// MM-3 (AC-33, AC-34).
const MM3_ROUTES: [string, string, string][] = [
  ["POST", "/v1/steps/:id/assign", "steps"],
  ["POST", "/v1/steps/:id/accept", "steps"],
  ["POST", "/v1/steps/:id/decline", "steps"],
  ["POST", "/v1/steps/:id/withdraw", "steps"],
  ["POST", "/v1/goals/:id/assign", "goals"],
  ["POST", "/v1/goals/:id/withdraw", "goals"],
  ["GET", "/v1/offers", "steps"],
];

describe("AC-33 OpenAPI, route table, docs and skill (offers)", () => {
  type Op = { tags?: string[]; operationId: string };
  const openApiPath = (p: string) => p.replace(/:id/g, "{id}");

  it("test_AC33_openapi_current", () => {
    expect(`${JSON.stringify(hubOpenApi(), null, 2)}\n`).toBe(read("schemas/hub-api.openapi.json"));
  });

  it("test_AC33_openapi_routes", () => {
    const committed = JSON.parse(read("schemas/hub-api.openapi.json")) as { paths: Record<string, Record<string, Op>> };
    // Positive control: an MM-2 route is there.
    expect(committed.paths["/v1/machines/{id}/labels"]?.post).toBeDefined();
    for (const [method, path] of MM3_ROUTES) expect(committed.paths[openApiPath(path)]?.[method.toLowerCase()], `${method} ${path}`).toBeDefined();
  });

  it("test_AC33_hub_api_matches_app", () => {
    const svc = { config: { url: "http://127.0.0.1:1" } } as unknown as HubService;
    const served = createApp(svc).routes.map((r) => `${r.method} ${r.path} ${r.rule} ${r.scope ?? "-"}`).sort();
    const documented = HUB_API.map((r) => `${r.method} ${r.path} ${r.rule} ${r.scope ?? "-"}`).sort();
    for (const [method, path, tag] of MM3_ROUTES) {
      expect(documented, `${method} ${path}`).toContain(`${method} ${path} member -`);
      expect(HUB_API.find((r) => r.method === method && r.path === path)?.tag, `${method} ${path}`).toBe(tag);
    }
    expect(documented).toEqual(served);
  });

  it("test_AC33_docs_mention", () => {
    const concepts = read("docs/guide/concepts.md");
    expect(concepts).toContain("Offers and accept policy");
    for (const t of ["offer_expiry", "--stick", "assignments"]) expect(concepts, t).toContain(t);
    const howto = read("docs/guide/howto.md");
    for (const t of ["Hand work to another machine", "mesh assign", "mesh offers", "mesh accept", "mesh decline", "mesh withdraw", "mesh session accept", "shareSessions: steps"]) expect(howto, t).toContain(t);
    const install = read("docs/guide/install.md");
    for (const t of ["accept", "assignments"]) expect(install, t).toContain(t);
    const plan = read("docs/plan/implementation-plan.md");
    const s56 = plan.slice(plan.indexOf("### 5.6"), plan.indexOf("\n### ", plan.indexOf("### 5.6") + 1));
    expect(s56).toContain("POST /v1/machines/:id/labels");
    for (const [method, path] of MM3_ROUTES) expect(s56, `${method} ${path}`).toContain(`${method} ${path}`);
    const events = read("docs/events.md");
    for (const e of ["step.offered", "step.accepted", "step.declined", "step.offer_expired", "step.offer_withdrawn"]) expect(events, e).toContain(`\`${e}\``);
  });

  it("test_AC33_skill", () => {
    for (const t of ["mesh_assign", "mesh_offers", "mesh_accept"]) expect(MESH_SKILL, t).toContain(t);
    expect(read("skills/mesh/SKILL.md")).toBe(MESH_SKILL);
  });
});

describe("AC-34 version and placement", () => {
  // The package version is pinned by RL-1 AC-34 below (the only test that asserts it, per the RL-1 spec).

  it("test_AC34_placement", async () => {
    const core = (await import("../src/core/index.ts")) as Record<string, unknown>;
    for (const name of ["acceptMatches", "pickSession", "offerText", "offerLine"]) expect(typeof core[name], name).toBe("function");
    const protocol = (await import("../src/protocol/index.ts")) as Record<string, unknown>;
    for (const name of ["parseAccept", "AcceptRule", "AcceptPolicy", "ACCEPT_RULE_TEXT", "OfferState", "StepOffer"]) expect(protocol[name], name).toBeDefined();
    // Positive control: an MM-2 export is found the same way.
    expect(protocol.parseLabels).toBeDefined();
  });
});

// MM-4 (AC-17, AC-18).
const MM4_ROUTES: [string, string, string][] = [
  ["GET", "/v1/steps/:id/suggest", "steps"],
  ["GET", "/v1/goals/:id/suggest", "goals"],
];

describe("AC-17 OpenAPI and route table (suggest)", () => {
  type Param = { name: string; in: string };
  type Prop = { type?: string; maxLength?: number; minLength?: number };
  type Op = { tags?: string[]; parameters?: Param[]; requestBody?: { content: Record<string, { schema: { properties?: Record<string, Prop> } }> } };
  const committed = () => JSON.parse(read("schemas/hub-api.openapi.json")) as { paths: Record<string, Record<string, Op>> };
  const openApiPath = (p: string) => p.replace(/:id/g, "{id}");

  it("test_AC17_openapi_fresh", () => {
    expect(`${JSON.stringify(hubOpenApi(), null, 2)}\n`).toBe(read("schemas/hub-api.openapi.json"));
  });

  it("test_AC17_suggest_paths", () => {
    const doc = committed();
    // Positive control: an MM-3 route is there.
    expect(doc.paths["/v1/steps/{id}/assign"]?.post).toBeDefined();
    for (const [method, path, tag] of MM4_ROUTES) {
      const op = doc.paths[openApiPath(path)]?.[method.toLowerCase()];
      expect(op, `${method} ${path}`).toBeDefined();
      expect(op?.tags, `${method} ${path}`).toContain(tag);
      const query = (op?.parameters ?? []).filter((p) => p.in === "query").map((p) => p.name);
      expect(query, `${method} ${path}`).toEqual(expect.arrayContaining(["team", "any"]));
    }
  });

  it("test_AC17_message_to", () => {
    const op = committed().paths["/v1/messages"]?.post;
    const props: Record<string, Prop> = op?.requestBody?.content["application/json"]?.schema.properties ?? {};
    // Positive control: the existing field is there.
    expect(props.toSid?.type).toBe("string");
    expect(props.to?.type).toBe("string");
    expect(props.to?.maxLength).toBe(200);
    expect(props.to?.minLength).toBe(1);
  });

  it("test_AC17_hub_api_matches_app", () => {
    const svc = { config: { url: "http://127.0.0.1:1" } } as unknown as HubService;
    const served = createApp(svc).routes.map((r) => `${r.method} ${r.path} ${r.rule} ${r.scope ?? "-"}`).sort();
    const documented = HUB_API.map((r) => `${r.method} ${r.path} ${r.rule} ${r.scope ?? "-"}`).sort();
    for (const [method, path, tag] of MM4_ROUTES) {
      expect(documented, `${method} ${path}`).toContain(`${method} ${path} member -`);
      expect(HUB_API.find((r) => r.method === method && r.path === path)?.tag, `${method} ${path}`).toBe(tag);
    }
    expect(documented).toEqual(served);
  });
});

describe("AC-18 docs and skill (suggest)", () => {
  it("test_AC18_skill_equals_file", () => {
    expect(read("skills/mesh/SKILL.md")).toBe(MESH_SKILL);
  });

  it("test_AC18_skill_rows", () => {
    // Positive control: an MM-3 row is there.
    expect(MESH_SKILL).toContain("mesh_assign");
    expect(MESH_SKILL).toContain("mesh assign <goal\\|step> --suggest");
    expect(MESH_SKILL).toContain("mesh say <machine>/<session>");
  });

  it("test_AC18_docs_mentions", () => {
    const concepts = read("docs/guide/concepts.md");
    for (const t of ["Suggest", "maxSessions"]) expect(concepts, t).toContain(t);
    const howto = read("docs/guide/howto.md");
    for (const t of ["--suggest", "Assign", "mesh say"]) expect(howto, t).toContain(t);
    const install = read("docs/guide/install.md");
    for (const t of ["maxSessions", "--max-sessions"]) expect(install, t).toContain(t);
    const plan = read("docs/plan/implementation-plan.md");
    const s56 = plan.slice(plan.indexOf("### 5.6"), plan.indexOf("\n### ", plan.indexOf("### 5.6") + 1));
    for (const t of ["/v1/steps/:id/suggest", "/v1/goals/:id/suggest", "v0.1.13"]) expect(s56, t).toContain(t);
  });
});

// RL-1 AC-34 (version, OpenAPI, routes, boundaries) and AC-35 (docs and skill).
describe("RL-1 AC-34 checks, schema, boundaries", () => {
  const ROUTES = [
    { method: "GET", path: "/v1/profiles", scope: "goals:read", tag: "goals" },
    { method: "GET", path: "/v1/profiles/:name", scope: "goals:read", tag: "goals" },
    { method: "POST", path: "/v1/profiles", scope: undefined, tag: "goals" },
    { method: "POST", path: "/v1/steps/:id/artifacts", scope: undefined, tag: "steps" },
    { method: "GET", path: "/v1/artifacts/:id", scope: "goals:read", tag: "goals" },
    { method: "GET", path: "/v1/goals/:id/artifacts", scope: "goals:read", tag: "goals" },
    { method: "POST", path: "/v1/steps/:id/run", scope: undefined, tag: "steps" },
  ];

  // The RL-1 version pin (test_AC34_version, 0.1.15) is superseded by RL-2 AC-31 (test_AC31_version below).

  it("test_AC34_seven_routes", () => {
    for (const want of ROUTES) {
      const row = HUB_API.find((x) => x.method === want.method && x.path === want.path);
      expect(row, `${want.method} ${want.path}`).toBeDefined();
      expect(row?.rule, want.path).toBe("member");
      expect(row?.scope, want.path).toBe(want.scope);
      expect(row?.tag, want.path).toBe(want.tag);
    }
    const doc = JSON.parse(read("schemas/hub-api.openapi.json")) as { paths: Record<string, Record<string, unknown>> };
    for (const want of ROUTES) {
      const p = want.path.replace(/:(\w+)/g, "{$1}");
      expect(doc.paths[p]?.[want.method.toLowerCase()], `${want.method} ${p} in the OpenAPI document`).toBeDefined();
    }
  });

  it("test_AC34_boundaries", async () => {
    // Process spawning stays out of src/daemon: that is the depcruise rule processes-only-in-adapters,
    // run by `pnpm boundaries` (part of `pnpm check`). This test checks where the new exports live.
    const claude = (await import("../src/claude/index.ts")) as Record<string, unknown>;
    expect(typeof claude.processRunner, "processRunner in src/claude").toBe("object");
    const core = (await import("../src/core/index.ts")) as Record<string, unknown>;
    for (const name of ["redactSecrets", "telemetryFromStream", "renderTail", "compileProfile", "parseProfile", "profileSha256"]) expect(typeof core[name], name).toBe("function");
    expect(Array.isArray(core.BUILTIN_PROFILES)).toBe(true);
  });
});

describe("RL-1 AC-35 docs and skill", () => {
  it("test_AC35_concepts", () => {
    const concepts = read("docs/guide/concepts.md");
    for (const t of ["Headless steps", "Artifacts", "Telemetry"]) expect(concepts, t).toMatch(new RegExp(`^#+ .*${t}`, "m"));
    for (const t of ["read-only", "cannot stop reads", "maxSessions", "mesh/<slug>", "turnsApprox", "mode: headless", "propose-via-branch"]) expect(concepts, t).toContain(t);
  });

  it("test_AC35_howto_install", () => {
    const howto = read("docs/guide/howto.md");
    expect(howto).toMatch(/^#+ .*Run a step headless/m);
    for (const t of ["mesh profile add", "mesh artifact", "claude --resume", "--params"]) expect(howto, t).toContain(t);
    const install = read("docs/guide/install.md");
    for (const t of ["MESH_CLAUDE_BIN", "max_bytes", "per_round", "retention_days"]) expect(install, t).toContain(t);
  });

  it("test_AC35_plan_events", () => {
    const plan = read("docs/plan/implementation-plan.md");
    const s56 = plan.slice(plan.indexOf("### 5.6"), plan.indexOf("\n### ", plan.indexOf("### 5.6") + 1));
    for (const t of ["/v1/profiles", "/v1/profiles/:name", "/v1/steps/:id/artifacts", "/v1/artifacts/:id", "/v1/goals/:id/artifacts", "/v1/steps/:id/run", "v0.1.15"]) expect(s56, t).toContain(t);
    const events = read("docs/events.md");
    for (const t of ["run.started", "run.finished", "step.artifact", "profile.saved"]) expect(events, t).toContain(t);
  });

  it("test_AC35_skill", () => {
    expect(MESH_SKILL).toContain("mesh_artifact");
    expect(MESH_SKILL).toContain("headless");
    expect(read("skills/mesh/SKILL.md")).toBe(MESH_SKILL);
  });
});

// RL-2 AC-31 (version, OpenAPI, routes, boundaries) and AC-30 (docs and skill). Written from the
// spec's contracts only (docs/specs/RL-2.md).
describe("RL-2 AC-31 checks, schema, boundaries", () => {
  const ROUTES = [
    { method: "POST", path: "/v1/steps/:id/review", scope: undefined, tag: "steps" },
    { method: "GET", path: "/v1/steps/:id/reviews", scope: "goals:read", tag: "steps" },
    { method: "GET", path: "/v1/items", scope: "goals:read", tag: "goals" },
  ];

  // The RL-2 version pin (test_AC31_version, 0.1.16) is superseded by RL-3 AC-27 (test_AC27_version below).

  it("test_AC31_openapi_routes", () => {
    for (const want of ROUTES) {
      const row = HUB_API.find((x) => x.method === want.method && x.path === want.path);
      expect(row, `${want.method} ${want.path}`).toBeDefined();
      expect(row?.rule, want.path).toBe("member");
      expect(row?.scope, want.path).toBe(want.scope);
      expect(row?.tag, want.path).toBe(want.tag);
    }
    const doc = JSON.parse(read("schemas/hub-api.openapi.json")) as { paths: Record<string, Record<string, unknown>> };
    for (const want of ROUTES) {
      const p = want.path.replace(/:(\w+)/g, "{$1}");
      expect(doc.paths[p]?.[want.method.toLowerCase()], `${want.method} ${p} in the OpenAPI document`).toBeDefined();
    }
    expect(`${JSON.stringify(hubOpenApi(), null, 2)}\n`).toBe(read("schemas/hub-api.openapi.json"));
  });

  it("test_AC31_core_boundaries", async () => {
    const core = (await import("../src/core/index.ts")) as Record<string, unknown>;
    for (const name of ["fingerprint", "foldItems", "evidenceHash", "whenHolds", "settle", "normPath", "mapRule", "declaredRules", "normalizeRegion", "lineageKey", "ruleSlug"]) expect(typeof core[name], name).toBe("function");
    // The pure functions live in src/core/review.ts and src/core/dag.ts (no hub or store imports there:
    // that is `pnpm boundaries`).
    const review = (await import("../src/core/review.ts" as string)) as Record<string, unknown>;
    for (const name of ["fingerprint", "foldItems", "evidenceHash", "whenHolds"]) expect(typeof review[name], name).toBe("function");
    const dag = (await import("../src/core/dag.ts")) as Record<string, unknown>;
    expect(typeof dag.settle).toBe("function");
  });
});

describe("RL-2 AC-30 docs and skill", () => {
  it("test_AC30_skill_mentions", () => {
    expect(MESH_SKILL).toContain("mesh_review");
    expect(read("skills/mesh/SKILL.md")).toBe(MESH_SKILL);
  });

  it("test_AC30_docs_present", () => {
    const concepts = read("docs/guide/concepts.md");
    expect(concepts).toMatch(/^#+ .*Review records/m);
    for (const t of ["output: review-record", "mesh-rules", "rules.yaml", "other:", "fingerprint", "lineage", "skipped", "consumes", "may_set", "when"]) expect(concepts, t).toContain(t);
    const howto = read("docs/guide/howto.md");
    expect(howto).toMatch(/^#+ .*Review an agent's findings/m);
    for (const t of ["mesh items", "consumes", "may_set"]) expect(howto, t).toContain(t);
    const events = read("docs/events.md");
    for (const t of ["review.recorded", "item.disposed", "step.skipped"]) expect(events, t).toContain(t);
    const plan = read("docs/plan/implementation-plan.md");
    const s56 = plan.slice(plan.indexOf("### 5.6"), plan.indexOf("\n### ", plan.indexOf("### 5.6") + 1));
    for (const t of ["/v1/steps/:id/review", "/v1/steps/:id/reviews", "/v1/items", "v0.1.16"]) expect(s56, t).toContain(t);
  });
});

// RL-3 AC-27 (version, OpenAPI, routes, boundaries) and AC-26 (docs and skill). Written from the
// spec's contracts only (docs/specs/RL-3.md).
describe("RL-3 AC-27 checks, schema, boundaries", () => {
  const ROUTES = [
    { method: "GET", path: "/v1/pulses", scope: "goals:read" },
    { method: "POST", path: "/v1/pulses", scope: undefined },
    { method: "GET", path: "/v1/pulses/:id", scope: "goals:read" },
    { method: "POST", path: "/v1/pulses/:id/update", scope: undefined },
    { method: "POST", path: "/v1/pulses/:id/pause", scope: undefined },
    { method: "POST", path: "/v1/pulses/:id/resume", scope: undefined },
    { method: "POST", path: "/v1/pulses/:id/fire", scope: undefined },
    { method: "POST", path: "/v1/pulses/:id/delete", scope: undefined },
    { method: "POST", path: "/v1/goals/from-preset", scope: "goals:write" },
  ];

  it("test_AC27_version", () => {
    expect((JSON.parse(read("package.json")) as { version: string }).version).toBe("0.1.17");
  });

  it("test_AC27_openapi_routes", () => {
    for (const want of ROUTES) {
      const row = HUB_API.find((x) => x.method === want.method && x.path === want.path);
      expect(row, `${want.method} ${want.path}`).toBeDefined();
      expect(row?.rule, want.path).toBe("member");
      expect(row?.scope, want.path).toBe(want.scope);
      expect(row?.tag, want.path).toBe("goals");
    }
    const goals = HUB_API.find((x) => x.method === "GET" && x.path === "/v1/goals") as { query?: Record<string, string> } | undefined;
    expect(Object.keys(goals?.query ?? {})).toContain("pulses");
    const doc = JSON.parse(read("schemas/hub-api.openapi.json")) as { paths: Record<string, Record<string, { parameters?: { name: string }[] }>> };
    for (const want of ROUTES) {
      const p = want.path.replace(/:(\w+)/g, "{$1}");
      expect(doc.paths[p]?.[want.method.toLowerCase()], `${want.method} ${p} in the OpenAPI document`).toBeDefined();
    }
    expect((doc.paths["/v1/goals"]?.get?.parameters ?? []).map((x) => x.name)).toContain("pulses");
    expect(`${JSON.stringify(hubOpenApi(), null, 2)}\n`).toBe(read("schemas/hub-api.openapi.json"));
  });

  it("test_AC27_core_boundaries", async () => {
    const core = (await import("../src/core/index.ts")) as Record<string, unknown>;
    for (const name of ["parseDurationSpec", "parseCron", "validTimeZone", "nextSlot", "periodMs", "scheduleText", "pulseCandidates", "manualSlot"]) expect(typeof core[name], name).toBe("function");
    // They live in src/core/schedule.ts and src/core/pulse.ts (no hub or store imports there: that is
    // `pnpm boundaries`).
    const schedule = (await import("../src/core/schedule.ts" as string)) as Record<string, unknown>;
    for (const name of ["parseCron", "nextSlot", "periodMs"]) expect(typeof schedule[name], name).toBe("function");
    const pulse = (await import("../src/core/pulse.ts" as string)) as Record<string, unknown>;
    for (const name of ["pulseCandidates", "manualSlot"]) expect(typeof pulse[name], name).toBe("function");
  });
});

describe("RL-3 AC-26 docs and skill", () => {
  it("test_AC26_skill_mentions", () => {
    expect(MESH_SKILL.toLowerCase()).toContain("pulse");
    expect(MESH_SKILL).toContain("mesh pulse");
    expect(MESH_SKILL).toContain("design step");
    expect(read("skills/mesh/SKILL.md")).toBe(MESH_SKILL);
  });

  it("test_AC26_docs_sections", () => {
    const concepts = read("docs/guide/concepts.md");
    expect(concepts).toMatch(/^#+ .*Pulses/m);
    for (const t of ["snapshot", "catch-up-once", "maxGoalAge", "hub_down", "audit-relay", "ingest"]) expect(concepts, t).toContain(t);
    const howto = read("docs/guide/howto.md");
    expect(howto).toContain("Run an agent audit on a schedule");
    expect(howto).toContain("mesh pulse add --preset audit-relay");
    const plan = read("docs/plan/implementation-plan.md");
    const s56 = plan.slice(plan.indexOf("### 5.6"), plan.indexOf("\n### ", plan.indexOf("### 5.6") + 1));
    for (const t of ["/v1/pulses", "/v1/goals/from-preset", "pulses=1", "v0.1.17"]) expect(s56, t).toContain(t);
    const events = read("docs/events.md");
    for (const t of ["pulse.created", "pulse.updated", "pulse.paused", "pulse.resumed", "pulse.deleted", "pulse.fired", "pulse.skipped", "pulse.missed", "pulse.abandoned", "goal.dropped"]) expect(events, t).toContain(t);
  });
});
