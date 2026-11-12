// RL-7 AC-06 (the constant) and AC-07: `HEADLESS_ENV_UNSET`, invalid agent front matter in
// `parseAgentFile`, `agentFront` and `frontMatter`. Written from the spec's contracts only
// (docs/specs/RL-7.md, Environment of a headless run; Agent front matter). New exports and fields are
// read loosely so the file compiles before they exist.

import { describe, expect, it } from "vitest";
import * as core from "./index.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- new exports, read loosely
const C = core as any;

const GOOD = "---\ndescription: Good agent\n---\nYou review.\n";
/** Line 2 of the front matter (`description: Validates: findings`) is not valid YAML. */
const BAD = "---\nname: bad\ndescription: Validates: findings\n---\nYou validate.\n";
const FIELDS = ["name", "description", "tools", "model", "rules"] as const;
const absent = (o: Record<string, unknown>, k: string) => !Object.hasOwn(o, k) || o[k] === undefined;

describe("RL-7 AC-06 HEADLESS_ENV_UNSET", () => {
  it("test_AC06_constant", () => {
    expect(C.HEADLESS_ENV_UNSET).toStrictEqual(["TMUX", "TMUX_PANE", "MESH_AUTOPILOT", "CLAUDE_PID"]);
  });
});

describe("RL-7 AC-07", () => {
  it("test_AC07_invalid_yaml", () => {
    for (const text of [BAD, BAD.replace(/\n/g, "\r\n")]) {
      const a = C.parseAgentFile(text);
      expect(typeof a.invalid, JSON.stringify(a)).toBe("string");
      expect(a.invalid.startsWith("front matter is not valid YAML: "), a.invalid).toBe(true);
      expect(a.invalid).toContain("line 2");
      expect(a.invalid.endsWith(":"), a.invalid).toBe(false);
      expect(a.invalid.includes("\n"), "first line of the parser message only").toBe(false);
      expect(a.invalid.length).toBeLessThanOrEqual(300);
      for (const f of FIELDS) expect(absent(a, f), `${f} absent`).toBe(true);
      expect(a.body.replace(/\r\n/g, "\n")).toBe("You validate.\n");
    }
  });

  it("test_AC07_not_a_mapping", () => {
    const list = C.parseAgentFile("---\n- a\n---\nbody\n");
    expect(list.invalid).toBe("front matter is not a YAML mapping");
    for (const f of FIELDS) expect(absent(list, f), `${f} absent`).toBe(true);
    expect(C.parseAgentFile("---\njust text\n---\nbody\n").invalid).toBe("front matter is not a YAML mapping");
  });

  it("test_AC07_valid_and_empty", () => {
    const empty = C.parseAgentFile("---\n---\nbody\n");
    expect(absent(empty, "invalid")).toBe(true);
    const none = C.parseAgentFile("no block\n");
    expect(absent(none, "invalid")).toBe(true);
    const good = C.parseAgentFile(GOOD);
    expect(absent(good, "invalid")).toBe(true);
    expect(good.description).toBe("Good agent");
    expect(good.body).toBe("You review.\n");
  });

  it("test_AC07_agent_front", () => {
    const inv = C.parseAgentFile(BAD).invalid;
    expect(typeof inv).toBe("string");
    expect(C.agentFront(BAD)).toStrictEqual({ invalid: inv });
    const good = C.agentFront(GOOD);
    expect(absent(good, "invalid")).toBe(true);
    // Control: the valid file's front is read (so absence of `invalid` is not an empty result).
    expect(good.description).toBe("Good agent");
    // `frontMatter` is unchanged: `{}` for an invalid file.
    expect(C.frontMatter(BAD)).toStrictEqual({});
    expect(C.frontMatter(GOOD)).toMatchObject({ description: "Good agent" });
  });
});
