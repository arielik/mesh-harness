// RL-1 AC-13: redactSecrets (docs/specs/RL-1.md, Core). Secret-looking fixtures are built at run
// time from parts, so no such literal is committed.

import { describe, expect, it } from "vitest";
import * as core from "./index.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- new export, read loosely
const redact = (text: string, literals?: readonly string[]): { text: string; count: number } => (core as any).redactSecrets(text, literals);

const R = "[REDACTED]";
const pem = (kind: string) => `-----BEGIN ${kind} PRIVATE` + ` KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\nKUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQ==\n-----END ${kind} PRIVATE` + " KEY-----";
const alnum = (n: number) => "aB3".repeat(n).slice(0, n);
const upnum = (n: number) => "A7Z".repeat(n).slice(0, n);
const ghp = "gh" + "p_" + alnum(36);

describe("AC-13 redactSecrets", () => {
  it("test_AC13_pem", () => {
    expect(redact(`a\n${pem("RSA")}\nb`)).toStrictEqual({ text: "a\n[REDACTED private key]\nb", count: 1 });
    expect(redact(`a\n${pem("OPENSSH")}\nb`)).toStrictEqual({ text: "a\n[REDACTED private key]\nb", count: 1 });
  });

  it.each([
    ["ghp_", "gh" + "p_" + alnum(36)],
    ["gho_", "gh" + "o_" + alnum(36)],
    ["ghu_", "gh" + "u_" + alnum(40)],
    ["ghs_", "gh" + "s_" + alnum(36)],
    ["ghr_", "gh" + "r_" + alnum(36)],
    ["github_pat_", "github" + "_pat_" + alnum(22)],
    ["glpat-", "glp" + "at-" + alnum(20)],
    ["xoxb-", "xo" + "xb-" + alnum(10)],
    ["xoxp-", "xo" + "xp-" + alnum(12)],
    ["AKIA", "AK" + "IA" + upnum(16)],
    ["sk-ant-", "sk-" + "ant-" + alnum(20)],
    ["sk-", "sk" + "-" + alnum(32)],
    ["AIza", "AI" + "za" + alnum(35)],
  ])("test_AC13_tokens %s", (_name, tok) => {
    expect(redact(`x ${tok} y`)).toStrictEqual({ text: `x ${R} y`, count: 1 });
  });

  it("test_AC13_token_too_short", () => {
    for (const t of ["gh" + "p_" + alnum(35), "AK" + "IA" + upnum(15)]) expect(redact(`x ${t} y`), t).toStrictEqual({ text: `x ${t} y`, count: 0 });
  });

  it("test_AC13_assignments", () => {
    expect(redact('password = "hunter2hunter2"')).toStrictEqual({ text: `password = "${R}"`, count: 1 });
    expect(redact("api_key: abcdef123")).toStrictEqual({ text: `api_key: ${R}`, count: 1 });
    expect(redact("API-KEY=abcdef")).toStrictEqual({ text: `API-KEY=${R}`, count: 1 });
    expect(redact("Token: 'abcdefgh'")).toStrictEqual({ text: `Token: '${R}'`, count: 1 });
    expect(redact("before\nsecret: s3cr3tvalue\nafter")).toStrictEqual({ text: `before\nsecret: ${R}\nafter`, count: 1 });
  });

  it("test_AC13_short_value", () => {
    expect(redact("token: abc")).toStrictEqual({ text: "token: abc", count: 0 });
    expect(redact("the password policy is strict")).toStrictEqual({ text: "the password policy is strict", count: 0 });
    // RL-7 (Compatibility): `token: abcdef` is no longer token-like, so it is unchanged.
    expect(redact("token: abcdef")).toStrictEqual({ text: "token: abcdef", count: 0 });
    // Positive control: the same key with a long enough value is redacted (`=` form, and a value with a digit).
    expect(redact("token=abcdef").count).toBe(1);
    expect(redact("token: abcde1").count).toBe(1);
  });

  it("test_AC13_literals", () => {
    const L = "k".repeat(32);
    expect(redact(`one ${L} two ${L} three`, [L, "", "short"])).toStrictEqual({ text: `one ${R} two ${R} three`, count: 2 });
    expect(redact("a short b", ["short", ""])).toStrictEqual({ text: "a short b", count: 0 });
    expect(redact("a 1234567 b", ["1234567"])).toStrictEqual({ text: "a 1234567 b", count: 0 });
    expect(redact("a 12345678 b", ["12345678"])).toStrictEqual({ text: `a ${R} b`, count: 1 });
    expect(redact(`no literals ${L}`)).toStrictEqual({ text: `no literals ${L}`, count: 0 });
  });

  it("test_AC13_order_and_count", () => {
    const L = "Z".repeat(9) + "lit";
    const akia = "AK" + "IA" + upnum(16);
    const text = `${pem("EC")}\nx ${ghp} y ${akia}\npassword=hunter2hunter2\nlit ${L} end`;
    expect(redact(text, [L])).toStrictEqual({ text: `[REDACTED private key]\nx ${R} y ${R}\npassword=${R}\nlit ${R} end`, count: 5 });
    // A token that is also an assignment value is one secret: counted once (spec, redactSecrets
    // contract; Open question 2026-11-12, diff round 2 B2).
    expect(redact(`token=${ghp}`)).toStrictEqual({ text: `token=${R}`, count: 1 });
  });

  it("test_AC13_assignment_of_a_literal", () => {
    const L = "q".repeat(8) + "Lit42";
    // A literal that is an assignment's value: one secret, counted once.
    expect(redact(`secret=${L}`, [L])).toStrictEqual({ text: `secret=${R}`, count: 1 });
    // A literal that also has a token's form, as an assignment's value: still one secret.
    expect(redact(`secret=${ghp}`, [ghp])).toStrictEqual({ text: `secret=${R}`, count: 1 });
    // A literal followed by more value text: the whole value is redacted, no tail is kept.
    expect(redact(`password=${L}tail\n`, [L])).toStrictEqual({ text: `password=${R}\n`, count: 1 });
  });

  it("test_AC13_identity", () => {
    const para =
      "The function reads the configuration file, merges defaults, and returns a frozen object.\n" +
      "```ts\nconst cfg = load(path);\nfor (const k of Object.keys(cfg)) console.log(k, cfg[k]);\n```\n" +
      "Keys are compared case-insensitively; empty values keep the default. See the guide for more.\n";
    let text = "";
    while (text.length < 10_000) text += para;
    const r = redact(text);
    expect(r.count).toBe(0);
    expect(r.text === text).toBe(true);
  });
});

// RL-7 AC-11: the `:` assignment form (docs/specs/RL-7.md, `redactSecrets`). An unquoted colon value
// is redacted only when token-like: at least 6 characters, no `://`, and a digit or 20+ characters,
// after stripping trailing `.,;:!?)]}` (kept in the output).
describe("RL-7 AC-11 colon rule", () => {
  it.each([
    ["### 1. secret: hardcoded API token", "### 1. secret: hardcoded API token", 0],
    ["password: correcthorse", "password: correcthorse", 0],
    ["token: abcdef", "token: abcdef", 0],
    ["api_key: abcdef123", `api_key: ${R}`, 1],
    ["secret: s3cr3tvalue", `secret: ${R}`, 1],
    ["password: hunter2.", `password: ${R}.`, 1],
    ["password: P@ssw0rd1", `password: ${R}`, 1],
    ["secret: S3cr3t#42", `secret: ${R}`, 1],
    ["token: abcdefghijklmnopqrstuv", `token: ${R}`, 1],
    ["Token: 'abcdefgh'", `Token: '${R}'`, 1],
    ["token=abcdef", `token=${R}`, 1],
    [`token: ${ghp}`, `token: ${R}`, 1],
    ["token: https://example.invalid/x1", "token: https://example.invalid/x1", 0],
  ])("test_AC11_examples %s", (input, text, count) => {
    expect(redact(input)).toStrictEqual({ text, count });
  });

  it("test_AC11_boundaries", () => {
    const n19 = "abcdefghijklmnopqrs";
    const n20 = "abcdefghijklmnopqrst";
    expect(n19).toHaveLength(19);
    expect(n20).toHaveLength(20);
    expect(redact(`token: ${n19}`)).toStrictEqual({ text: `token: ${n19}`, count: 0 });
    expect(redact(`token: ${n20}`)).toStrictEqual({ text: `token: ${R}`, count: 1 });
    expect(redact("secret: abcde1")).toStrictEqual({ text: `secret: ${R}`, count: 1 });
    expect(redact("password: hunter2),")).toStrictEqual({ text: `password: ${R}),`, count: 1 });
    expect(redact("token: http://a.b/c1")).toStrictEqual({ text: "token: http://a.b/c1", count: 0 });
    expect(redact("token: http-a.b/c1")).toStrictEqual({ text: `token: ${R}`, count: 1 });
  });

  it("test_AC11_prose", () => {
    const text = "## Findings\n### 1. secret: hardcoded API token\nToken: see below\napi_key=abcdef123\nend\n";
    expect(redact(text)).toStrictEqual({ text: `## Findings\n### 1. secret: hardcoded API token\nToken: see below\napi_key=${R}\nend\n`, count: 1 });
  });
});
