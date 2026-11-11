import { describe, expect, it } from "vitest";
import { DaemonConfig, notifyChannels, notifyMode } from "./config.ts";
import * as protocol from "./index.ts";

describe("notify setting", () => {
  it("accepts the old booleans and the new modes", () => {
    const base = { port: 31944, key: "0123456789abcdef" };
    expect(notifyMode(DaemonConfig.parse(base))).toBe("desktop");
    expect(notifyMode(DaemonConfig.parse({ ...base, notify: false }))).toBe("off");
    expect(notifyChannels(DaemonConfig.parse({ ...base, notify: "terminal" }))).toEqual({ desktop: false, terminal: true, any: true });
    expect(notifyChannels(DaemonConfig.parse({ ...base, notify: "both" }))).toEqual({ desktop: true, terminal: true, any: true });
    expect(notifyChannels(DaemonConfig.parse({ ...base, notify: "off" })).any).toBe(false);
    expect(DaemonConfig.safeParse({ ...base, notify: "loud" }).success).toBe(false);
  });
});

// AC-01 (MM-1): three share levels; a config without the field keeps its v0.1.7 meaning (`steps`).
describe("AC-01 share levels", () => {
  const minimal = { port: 31944, key: "0123456789abcdef" };

  it.each(["steps", "me", "all"] as const)("test_AC01_share_levels_parse: %s", (level) => {
    expect(DaemonConfig.parse({ ...minimal, shareSessions: level }).shareSessions).toBe(level);
  });

  it("test_AC01_unknown_level_rejected", () => {
    // Positive control: a valid level parses (so the parser is not rejecting everything).
    expect(DaemonConfig.safeParse({ ...minimal, shareSessions: "me" }).success).toBe(true);
    expect(DaemonConfig.safeParse({ ...minimal, shareSessions: "team" }).success).toBe(false);
    expect(DaemonConfig.safeParse({ ...minimal, shareSessions: true }).success).toBe(false);
  });

  it("test_AC01_missing_field_defaults_to_steps", () => {
    expect(DaemonConfig.parse(minimal).shareSessions).toBe("steps");
  });

  it("test_AC01_ShareLevel_exported", () => {
    const ShareLevel = (protocol as unknown as { ShareLevel?: { options: string[] } }).ShareLevel;
    expect(ShareLevel?.options).toEqual(["steps", "me", "all"]);
  });
});

// ---------------------------------------------------------------------------------------------
// MM-3 AC-01: accept rules, accept policy, parseAccept, DaemonConfig.accept/assignments, Session.accept.
describe("accept", () => {
  // Copied from the spec, not imported, so a changed text turns the tests red.
  const RULE = "an accept rule is self, off, user:<id> or machine:<nickname or id>";
  const OFF_ALONE = "off cannot be combined with other rules";
  // The new names are read off the module namespace (they do not exist before MM-3).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- new exports, read loosely
  const P = protocol as any;
  const parseAccept = (x: string | readonly string[]) => P.parseAccept(x);
  const users = (n: number) => Array.from({ length: n }, (_, i) => `user:u${String(i + 1).padStart(2, "0")}`);
  const minimal = { port: 31944, key: "0123456789abcdef" };
  const minimalSession = {
    sid: "s1",
    claudeSessionIds: ["c-s1"],
    cwd: "/w",
    kind: "interactive",
    state: "idle",
    quiet: false,
    startedAt: 1,
    lastEventAt: 2,
    turns: 0,
    humanPrompts: 0,
    seenByReconciler: true,
  };

  it("test_AC01_parse_split_trim_dedupe_keep_order", () => {
    expect(parseAccept("self, user:bob,self")).toStrictEqual({ accept: ["self", "user:bob"] });
  });

  it("test_AC01_parse_array_input", () => {
    expect(parseAccept(["user:bob", "self"])).toStrictEqual({ accept: ["user:bob", "self"] });
  });

  it("test_AC01_parse_off", () => {
    expect(parseAccept("off")).toStrictEqual({ accept: ["off"] });
  });

  it("test_AC01_parse_off_combined", () => {
    expect(parseAccept("off,self")).toStrictEqual({ error: OFF_ALONE });
    expect(parseAccept("self,off")).toStrictEqual({ error: OFF_ALONE });
  });

  it("test_AC01_parse_empty", () => {
    for (const x of ["", " , ", []]) expect(parseAccept(x), JSON.stringify(x)).toStrictEqual({ error: "give at least one rule, or off" });
  });

  it("test_AC01_parse_bad_rule_text", () => {
    expect(parseAccept("bob")).toStrictEqual({ error: `not an accept rule: bob (${RULE})` });
    expect(parseAccept("self,user:,bob")).toStrictEqual({ error: `not an accept rule: user: (${RULE})` });
  });

  it("test_AC01_parse_21_rules", () => {
    expect(parseAccept(users(20).join(","))).toStrictEqual({ accept: users(20) });
    expect(parseAccept(users(21).join(","))).toStrictEqual({ error: "at most 20 accept rules" });
    // Repeats are removed before counting.
    expect(parseAccept([...users(20), "user:u01"])).toStrictEqual({ accept: users(20) });
  });

  it("test_AC01_rule_regex_edges", () => {
    const ok = ["self", "off", "user:x", "machine:m-0a1b", `user:${"a".repeat(100)}`];
    const bad = [`user:${"a".repeat(101)}`, "user:a b", "user:a,b", "SELF", "machine:"];
    for (const r of ok) expect(P.AcceptRule.safeParse(r).success, r).toBe(true);
    for (const r of bad) {
      const res = P.AcceptRule.safeParse(r);
      expect(res.success, r).toBe(false);
      expect(res.error.issues[0].message, r).toBe(RULE);
    }
  });

  it("test_AC01_policy_schema", () => {
    expect(P.AcceptPolicy.safeParse(["self"]).success).toBe(true);
    expect(P.AcceptPolicy.safeParse([]).success).toBe(false);
    expect(P.AcceptPolicy.safeParse(users(21)).success).toBe(false);
    const both = P.AcceptPolicy.safeParse(["off", "self"]);
    expect(both.success).toBe(false);
    expect(both.error.issues.map((i: { message: string }) => i.message)).toContain(OFF_ALONE);
  });

  it("test_AC01_rule_text_const", () => {
    expect(P.ACCEPT_RULE_TEXT).toBe(RULE);
  });

  it("test_AC01_daemon_config_defaults", () => {
    // An MM-2 daemon.json: no accept, no assignments.
    const mm2 = { ...minimal, notify: true, workspaceRoots: ["/w"], autopilot: "nudge", shareSessions: "me" };
    const c = DaemonConfig.parse(mm2) as Record<string, unknown>;
    expect(c.accept).toStrictEqual(["self"]);
    expect(c.assignments).toBe("deliver");
    // Every MM-2 field parses as before.
    expect(c).toMatchObject({ port: 31944, key: "0123456789abcdef", notify: true, workspaceRoots: ["/w"], autopilot: "nudge", shareSessions: "me" });
  });

  it("test_AC01_daemon_config_values", () => {
    const c = DaemonConfig.parse({ ...minimal, accept: ["user:bob"], assignments: "launch" }) as Record<string, unknown>;
    expect(c.accept).toStrictEqual(["user:bob"]);
    expect(c.assignments).toBe("launch");
    expect(DaemonConfig.safeParse({ ...minimal, assignments: "x" }).success).toBe(false);
    expect(DaemonConfig.safeParse({ ...minimal, accept: ["off", "self"] }).success).toBe(false);
  });

  it("test_AC01_session_accept_field", () => {
    const S = P.Session;
    expect(S.parse({ ...minimalSession, accept: ["user:x"] }).accept).toStrictEqual(["user:x"]);
    expect(S.safeParse({ ...minimalSession, accept: ["off", "self"] }).success).toBe(false);
    expect(S.safeParse({ ...minimalSession, accept: [] }).success).toBe(false);
    expect(Object.hasOwn(S.parse(minimalSession), "accept")).toBe(false);
  });
});

// MM-4 AC-14: `maxSessions` (absent = no limit; an integer 1–1000).
describe("maxSessions", () => {
  const minimal = { port: 31944, key: "0123456789abcdef" };
  const mm3 = { ...minimal, notify: true, workspaceRoots: ["/w"], autopilot: "nudge", shareSessions: "me", accept: ["user:bob"], assignments: "launch" };

  it("test_AC14_parse_absent", () => {
    const c = DaemonConfig.parse(mm3) as Record<string, unknown>;
    expect(Object.hasOwn(c, "maxSessions")).toBe(false);
    expect(c).toMatchObject({ port: 31944, key: "0123456789abcdef", notify: true, workspaceRoots: ["/w"], autopilot: "nudge", shareSessions: "me", accept: ["user:bob"], assignments: "launch" });
    // The same file with the field parses to the same config plus the field.
    const withField = DaemonConfig.parse({ ...mm3, maxSessions: 3 }) as Record<string, unknown>;
    expect(withField.maxSessions).toBe(3);
    const rest = { ...withField };
    delete rest.maxSessions;
    expect(rest).toStrictEqual(c);
  });

  it("test_AC14_parse_values", () => {
    for (const n of [1, 3, 1000]) expect((DaemonConfig.parse({ ...minimal, maxSessions: n }) as Record<string, unknown>).maxSessions, String(n)).toBe(n);
    for (const bad of [0, 1001, 2.5, "3", -1, null]) expect(DaemonConfig.safeParse({ ...minimal, maxSessions: bad }).success, String(bad)).toBe(false);
  });
});
