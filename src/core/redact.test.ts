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
    // Positive control: the same key with a long enough value is redacted.
    expect(redact("token: abcdef").count).toBe(1);
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
