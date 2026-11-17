// RL-9 AC-17 (unit): the finding-step id and the cut title rule. Written from the spec's contracts
// only (docs/specs/RL-9.md, "Finding step" and rule 2).
//
// Expected module and exports (the spec names no function; the developer matches these):
//   src/core/finding-step.ts
//     findingStepId(lineage: string, fp: string): string
//       → "f-" + the first 16 characters of the lowercase base32 (RFC 4648 alphabet, no padding)
//         SHA-256 of `<lineage>|<fp>` (the encoding `fingerprint()` uses); 18 characters.
//     cutTitle(severity: string, title: string): string
//       → `[<severity>] <title>`, cut to 200 characters; when cut, the last kept character (the
//         200th) is replaced by `…` (so: the first 199 characters + "…").
//
// The module is read loosely so this file compiles before it exists; a missing export fails the
// test that needs it.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

const MODULE = "./finding-step.ts";
const mod: Record<string, unknown> = await import(/* @vite-ignore */ MODULE).catch(() => ({}));
const fn = <T extends (...a: never[]) => unknown>(name: string): T => {
  const f = mod[name];
  expect(typeof f, `${MODULE} exports ${name}`).toBe("function");
  return f as T;
};
const findingStepId = (lineage: string, fp: string) => fn<(l: string, f: string) => string>("findingStepId")(lineage, fp);
const cutTitle = (severity: string, title: string) => fn<(s: string, t: string) => string>("cutTitle")(severity, title);

/** Test-side formula (lowercase RFC 4648 base32 of the SHA-256), independent of the implementation. */
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
const fid = (lineage: string, fp: string) => `f-${base32(createHash("sha256").update(`${lineage}|${fp}`, "utf8").digest()).slice(0, 16)}`;

const FP = "aaaaaaaaaaaaaaaa";

describe("RL-9 AC-17 finding step helpers", () => {
  it("test_AC17_id_fixed", () => {
    const id = findingStepId("relay|r|audit", FP);
    // Pinned once from the documented formula (and checked against the test-side formula below).
    expect(id).toBe("f-j2w4alurb4q5hfap");
    expect(id).toBe(fid("relay|r|audit", FP));
    expect(id).toMatch(/^f-[a-z2-7]{16}$/);
    expect(id).toHaveLength(18);
  });

  it("test_AC17_id_other_lineage", () => {
    const a = findingStepId("relay|r|audit", FP);
    const b = findingStepId("relay2|r|audit", FP);
    expect(b).toBe("f-nqlxlwozynsfzu6q");
    expect(b).not.toBe(a);
    // `<lineage>|<fp>`, not `<fp>|<lineage>`.
    expect(a).not.toBe(fid(FP, "relay|r|audit"));
  });

  it("test_AC17_title_cut", () => {
    // `[S1] ` is 5 characters: a title of n characters gives a full title of n + 5.
    const t194 = "t".repeat(194);
    const t195 = "t".repeat(195);
    const t196 = "t".repeat(196);
    expect(cutTitle("S1", t194)).toBe(`[S1] ${t194}`);
    expect(cutTitle("S1", t194)).toHaveLength(199);
    expect(cutTitle("S1", t195)).toBe(`[S1] ${t195}`);
    expect(cutTitle("S1", t195)).toHaveLength(200);
    const cut = cutTitle("S1", t196);
    expect(cut).toHaveLength(200);
    expect(cut).toBe(`${`[S1] ${t196}`.slice(0, 199)}…`);
    // A short title is just prefixed.
    expect(cutTitle("S3", "Leak")).toBe("[S3] Leak");
  });
});
