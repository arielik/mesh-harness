// RL-2 AC-03 to AC-07 (unit): path normalisation, fingerprint, repo name, declared rules and rule
// mapping, the evidence hash, `foldItems` and `whenHolds` (src/core/review.ts). Written from the
// spec's contracts only (docs/specs/RL-2.md). New exports are read loosely so the file compiles
// before they exist; a missing export fails the test that needs it.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as core from "./index.ts";

// The new module first (src/core/suggest.ts has an older `repoName` of its own), then the index.
const REVIEW = "./review.ts";
const review: Record<string, unknown> = await import(/* @vite-ignore */ REVIEW).catch(() => ({}));
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- new exports, read loosely
const C = { ...core, ...review } as any;

const H = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function base32(buf: Buffer): string {
  let bits = 0;
  let v = 0;
  let out = "";
  for (const b of buf) {
    v = (v << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(v >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(v << (5 - bits)) & 31];
  return out;
}
/** The documented formula, test-side, for already normalised inputs. */
const formula = (rule: string, path = "", symbol = "") => base32(createHash("sha256").update(`${rule}\n${path}\n${symbol}`, "utf8").digest()).slice(0, 16);
const VECTOR = "5zynkhff5nebyzbe";

// ---------------------------------------------------------------------------------------------

describe("AC-03 identity", () => {
  it.each([
    ["./a//b/", undefined, "a/b"],
    ["a\\b", undefined, "a/b"],
    ["/r/a/b", "/r", "a/b"],
    ["././a/b", undefined, "a/b"],
    ["/r", "/r", ""],
    ["/r/./a//b/", "/r", "a/b"],
  ])("test_AC03_normPath %s (root %s)", (p, root, want) => {
    expect(C.normPath(p, root)).toBe(want);
  });

  it("test_AC03_normPath_outside_root", () => {
    expect(C.normPath("/x/a", "/r")).toBe("/x/a");
    expect(C.normPath("/rr/a", "/r")).toBe("/rr/a");
    // Control: under the root it is made relative.
    expect(C.normPath("/r/a", "/r")).toBe("a");
  });

  it("test_AC03_fp_vector", () => {
    expect(formula("I-03", "src/a.ts", "f")).toBe(VECTOR);
    expect(C.fingerprint({ rule: "I-03", path: "src/a.ts", symbol: "f" })).toBe(VECTOR);
    expect(C.fingerprint({ rule: "I-03" })).toBe("zwzusnix4km7grsg");
    expect(C.fingerprint({ rule: "I-03" })).toBe(formula("I-03"));
    for (const x of [C.fingerprint({ rule: "I-03", path: "src/a.ts", symbol: "f" }), C.fingerprint({ rule: "x" })]) expect(x).toMatch(/^[a-z2-7]{16}$/);
  });

  it("test_AC03_fp_variants_equal", () => {
    for (const path of ["./src//a.ts/", "src\\a.ts", "src/a.ts"]) expect(C.fingerprint({ rule: "I-03", path, symbol: "f" }), path).toBe(VECTOR);
    expect(C.fingerprint({ rule: "  I-03 ", path: "src/a.ts", symbol: " f " })).toBe(VECTOR);
  });

  it("test_AC03_fp_differs", () => {
    const fps = [
      C.fingerprint({ rule: "I-03", path: "src/a.ts", symbol: "f" }),
      C.fingerprint({ rule: "I-04", path: "src/a.ts", symbol: "f" }),
      C.fingerprint({ rule: "I-03", path: "src/b.ts", symbol: "f" }),
      C.fingerprint({ rule: "I-03", path: "src/a.ts", symbol: "g" }),
      C.fingerprint({ rule: "I-03", path: "src/a.ts" }),
    ];
    expect(new Set(fps).size).toBe(fps.length);
    expect(fps[4]).toBe(formula("I-03", "src/a.ts", ""));
  });

  it("test_AC03_fp_ignores_rest", () => {
    const k = { rule: "I-03", path: "src/a.ts", symbol: "f", title: "T", severity: "S1", evidence: [{ path: "x", lines: [1, 2] }], lines: [4, 5] };
    expect(C.fingerprint(k)).toBe(VECTOR);
    expect(C.fingerprint({ ...k, title: "other", severity: "S4", lines: [9, 9] })).toBe(VECTOR);
  });

  it.each(["/src/alpha/", "git@host:team/alpha.git", "alpha", "/src/alpha.git/", "https://host/team/alpha.git"])("test_AC03_repoName %s", (repo) => {
    expect(C.repoName(repo)).toBe("alpha");
  });

  it("test_AC03_lineageKey", () => {
    expect(C.lineageKey({ preset: "-", repo: "r", agent: "a" })).toBe("-|r|a");
    expect(C.lineageKey({ preset: "p", repo: "/src/alpha", agent: "auditor" })).toBe("p|/src/alpha|auditor");
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-04 rules", () => {
  const SET = new Set(["I-03", "secrets"]);
  const agent = (front: string) => `---\nname: a\ndescription: d\n${front}---\nbody\n`;

  it("test_AC04_front_matter_list", () => {
    expect(C.declaredRules(agent("mesh-rules: [I-03, secrets]\n"))).toStrictEqual(SET);
    expect(C.declaredRules(agent("mesh-rules:\n  - I-03\n  - secrets\n"))).toStrictEqual(SET);
  });

  it("test_AC04_front_matter_string", () => {
    expect(C.declaredRules(agent('mesh-rules: "I-03, secrets"\n'))).toStrictEqual(SET);
  });

  it("test_AC04_rules_yaml_list_and_map", () => {
    expect(C.declaredRules(agent(""), "- I-03\n- secrets\n")).toStrictEqual(SET);
    expect(C.declaredRules(agent(""), "I-03: desc\nsecrets: x\n")).toStrictEqual(SET);
    // Control: neither source gives nothing.
    expect(C.declaredRules(agent(""))).toStrictEqual(new Set());
  });

  it("test_AC04_union", () => {
    expect(C.declaredRules(agent("mesh-rules: [I-03]\n"), '- secrets\n- " "\n')).toStrictEqual(SET);
    expect(C.declaredRules(agent("mesh-rules: \" I-03 , , secrets \"\n"))).toStrictEqual(SET);
  });

  it("test_AC04_invalid_yaml", () => {
    expect(C.declaredRules(agent("mesh-rules: [I-03]\n"), "a: [\n")).toStrictEqual(new Set(["I-03"]));
    expect(C.declaredRules("---\nname: a\nmesh-rules: [I-03\n---\nbody\n", "- secrets\n")).toStrictEqual(new Set(["secrets"]));
  });

  it("test_AC04_mapRule", () => {
    const D = new Set(["I-03"]);
    expect(C.mapRule("I-03", D)).toStrictEqual({ rule: "I-03", undeclared: false });
    expect(C.mapRule(" I-03 ", D)).toStrictEqual({ rule: "I-03", undeclared: false });
    expect(C.mapRule("Hard Coded Secret!", D)).toStrictEqual({ rule: "other:hard-coded-secret", undeclared: true });
    expect(C.mapRule("I-03", new Set())).toStrictEqual({ rule: "other:i-03", undeclared: true });
    expect(C.mapRule("other:Foo", D)).toStrictEqual({ rule: "other:foo", undeclared: true });
  });

  it("test_AC04_ruleSlug", () => {
    expect(C.ruleSlug("!!!")).toBe("unnamed");
    expect(C.ruleSlug("A__b")).toBe("a-b");
    expect(C.ruleSlug("a".repeat(50))).toBe("a".repeat(40));
    expect(C.ruleSlug("--Hard Coded Secret!--")).toBe("hard-coded-secret");
  });

  it("test_AC04_parseAgentFile_rules", () => {
    const withRules = C.parseAgentFile("---\nname: auditor\ndescription: Audits\nmesh-rules: [I-03]\n---\nYou audit.\n");
    expect(withRules.rules).toStrictEqual(["I-03"]);
    const listed = C.parseAgentFile('---\nname: auditor\ndescription: Audits\nmesh-rules: "I-03, secrets"\n---\nYou audit.\n');
    expect(listed.rules).toStrictEqual(["I-03", "secrets"]);
    const without = C.parseAgentFile("---\nname: plain\n---\nYou are plain.\n");
    expect(without.rules).toBeUndefined();
    // Control: the RL-1 fields are still parsed.
    expect(withRules.description).toBe("Audits");
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-05 evidenceHash", () => {
  it("test_AC05_empty", () => {
    expect(C.evidenceHash([])).toBeUndefined();
  });

  it("test_AC05_formula", () => {
    expect(C.evidenceHash(["const x = 1;", null])).toBe("b787f2ac3313de91025c37ca534d69043b5d4afde287826a24ff1bfc2b28ec4a");
    expect(C.evidenceHash(["const x = 1;", null])).toBe(H(`${H("const x = 1;")}\nmissing`));
    expect(C.evidenceHash([null])).toBe(H("missing"));
  });

  it("test_AC05_whitespace", () => {
    expect(C.evidenceHash(["const  x =\n\t1;  "])).toBe(C.evidenceHash(["const x = 1;"]));
    expect(C.evidenceHash(["\n  const x = 1;\r\n"])).toBe(C.evidenceHash(["const x = 1;"]));
    expect(C.normalizeRegion(" a \n\n b ")).toBe("a b");
  });

  it("test_AC05_token_change", () => {
    const one = C.evidenceHash(["const x = 1;"]);
    expect(typeof one).toBe("string");
    expect(C.evidenceHash(["const x = 2;"])).not.toBe(one);
    expect(C.evidenceHash(["constx = 1;"])).not.toBe(one);
  });

  it("test_AC05_order", () => {
    expect(C.evidenceHash(["a", "b"])).not.toBe(C.evidenceHash(["b", "a"]));
    expect(C.evidenceHash([null])).not.toBe(C.evidenceHash(["missing"]));
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-06 foldItems", () => {
  const today = "2026-11-12";
  type Row = { state: string; dismissedEh?: string; until?: string };
  const fold = (o: { items: { fp: string; eh?: string }[]; complete?: boolean; previous?: string[] | undefined; rows?: Record<string, Row> }) =>
    C.foldItems({ items: o.items, complete: o.complete ?? true, previous: o.previous, rows: new Map(Object.entries(o.rows ?? {})), today });

  it("test_AC06_new", () => {
    const f = fold({ items: [{ fp: "a" }] });
    expect(f.marks.get("a")).toBe("new");
    expect(f.states.get("a")).toBe("open");
    expect(f.fold).toStrictEqual({ new: 1, repeat: 0, regression: 0, resolved: 0, carried: 0 });
    expect(f.resolved).toStrictEqual([]);
    expect(f.carried).toStrictEqual([]);
  });

  it.each(["open", "confirmed", "accepted"])("test_AC06_repeat_unchanged %s", (state) => {
    const f = fold({ items: [{ fp: "a" }], previous: ["a"], rows: { a: { state } } });
    expect(f.marks.get("a")).toBe("repeat");
    expect(f.states.get("a")).toBe(state);
    expect(f.carried).toStrictEqual([]);
    expect(f.fold).toStrictEqual({ new: 0, repeat: 1, regression: 0, resolved: 0, carried: 0 });
  });

  it("test_AC06_dismissed_same_eh", () => {
    for (const [eh, dismissedEh] of [
      ["e1", "e1"],
      [undefined, undefined],
    ] as const) {
      const f = fold({ items: [{ fp: "a", ...(eh ? { eh } : {}) }], previous: ["a"], rows: { a: { state: "dismissed", ...(dismissedEh ? { dismissedEh } : {}) } } });
      expect(f.marks.get("a"), String(eh)).toBe("repeat");
      expect(f.states.get("a")).toBe("dismissed");
      expect(f.carried).toStrictEqual(["a"]);
      expect(f.fold.carried).toBe(1);
      expect(f.fold.repeat).toBe(1);
    }
  });

  it("test_AC06_dismissed_other_eh", () => {
    for (const [eh, dismissedEh] of [
      ["e2", "e1"],
      ["e1", undefined],
      [undefined, "e1"],
    ] as const) {
      const f = fold({ items: [{ fp: "a", ...(eh ? { eh } : {}) }], previous: ["a"], rows: { a: { state: "dismissed", ...(dismissedEh ? { dismissedEh } : {}) } } });
      expect(f.marks.get("a"), `${eh} vs ${dismissedEh}`).toBe("regression");
      expect(f.states.get("a")).toBe("open");
      expect(f.carried).toStrictEqual([]);
      expect(f.fold.regression).toBe(1);
    }
  });

  it("test_AC06_resolved_regression", () => {
    const f = fold({ items: [{ fp: "a" }], previous: [], rows: { a: { state: "resolved" } } });
    expect(f.marks.get("a")).toBe("regression");
    expect(f.states.get("a")).toBe("open");
    expect(f.fold).toStrictEqual({ new: 0, repeat: 0, regression: 1, resolved: 0, carried: 0 });
  });

  it("test_AC06_deferred", () => {
    const at = (until: string) => fold({ items: [{ fp: "a" }], previous: ["a"], rows: { a: { state: "deferred", until } } });
    for (const [until, want] of [
      ["2026-11-13", "deferred"],
      ["2026-11-12", "open"],
      ["2026-11-01", "open"],
    ] as const) {
      const f = at(until);
      expect(f.marks.get("a"), until).toBe("repeat");
      expect(f.states.get("a"), until).toBe(want);
    }
  });

  it.each(["open", "confirmed", "dismissed", "deferred", "accepted", "resolved"])("test_AC06_resolve_complete from %s", (state) => {
    const f = fold({ items: [{ fp: "a" }], previous: ["a", "b"], rows: { a: { state: "open" }, b: { state, until: "2027-01-01" } } });
    expect(f.resolved).toStrictEqual(["b"]);
    expect(f.states.get("b")).toBe("resolved");
    expect(f.marks.has("b")).toBe(false);
    expect(f.fold.resolved).toBe(1);
  });

  it("test_AC06_partial", () => {
    const f = fold({ items: [{ fp: "a" }], complete: false, previous: ["a", "b"], rows: { a: { state: "open" }, b: { state: "open" } } });
    expect(f.resolved).toStrictEqual([]);
    expect(f.states.has("b")).toBe(false);
    expect(f.fold.resolved).toBe(0);
    // Control: the fold ran (a is marked).
    expect(f.marks.get("a")).toBe("repeat");
    expect(f.states.get("a")).toBe("open");
  });

  it("test_AC06_no_previous", () => {
    const f = fold({ items: [{ fp: "a" }], complete: true, previous: undefined, rows: { b: { state: "open" } } });
    expect(f.resolved).toStrictEqual([]);
    expect(f.states.has("b")).toBe(false);
    expect(f.marks.get("a")).toBe("new");
  });

  it("test_AC06_counts", () => {
    const f = fold({
      items: [{ fp: "n" }, { fp: "r1" }, { fp: "r2", eh: "e" }, { fp: "g" }],
      previous: ["r1", "r2", "x"],
      rows: { r1: { state: "confirmed" }, r2: { state: "dismissed", dismissedEh: "e" }, g: { state: "resolved" }, x: { state: "open" } },
    });
    expect(f.fold).toStrictEqual({ new: 1, repeat: 2, regression: 1, resolved: 1, carried: 1 });
    expect([...f.states.keys()].sort()).toStrictEqual(["g", "n", "r1", "r2", "x"]);
    expect(Object.fromEntries(f.marks)).toStrictEqual({ n: "new", r1: "repeat", r2: "repeat", g: "regression" });
    expect(f.carried).toStrictEqual(["r2"]);
    expect(f.resolved).toStrictEqual(["x"]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-07 whenHolds", () => {
  it("test_AC07_whenHolds", () => {
    const it1 = (state: string, severity: string) => [{ state, severity }];
    expect(C.whenHolds({ open: true }, ["open"], it1("open", "S3"))).toBe(true);
    expect(C.whenHolds({ min_severity: "S2" }, ["open"], it1("open", "S3"))).toBe(false);
    expect(C.whenHolds({ min_severity: "S2" }, ["open"], it1("open", "S1"))).toBe(true);
    expect(C.whenHolds({ min_severity: "S2" }, ["open"], it1("open", "S2"))).toBe(true);
    expect(C.whenHolds({ open: true, min_severity: "S2" }, ["open"], it1("confirmed", "S1"))).toBe(false);
    expect(C.whenHolds({ open: true, min_severity: "S2" }, ["open", "confirmed"], it1("confirmed", "S1"))).toBe(true);
    expect(C.whenHolds({}, ["open"], it1("open", "S4"))).toBe(true);
    expect(C.whenHolds({ open: true }, ["open"], [])).toBe(false);
    expect(C.whenHolds({ open: true }, ["accepted"], [{ state: "open", severity: "S1" }, { state: "accepted", severity: "S4" }])).toBe(true);
  });
});
