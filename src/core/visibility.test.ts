// AC-08 (MM-1): who sees a session in /v1/live and /v1/fleet.

import { describe, expect, it } from "vitest";
import type { ShareLevel } from "../protocol/index.ts";
import * as core from "./index.ts";
import { sessionVisible } from "./visibility.ts";

const SHARES: (ShareLevel | undefined)[] = ["steps", "me", "all", undefined];

describe("AC-08 sessionVisible", () => {
  it.each(SHARES)("test_AC08_owner_always (share %s)", (share) => {
    expect(sessionVisible("alice", { userId: "alice" }, share)).toBe(true);
  });

  it.each(SHARES)("test_AC08_step_visible_to_anyone (share %s)", (share) => {
    expect(sessionVisible("alice", { userId: "bob", step: "G1.a" }, share)).toBe(true);
  });

  it("test_AC08_nostep_all_visible", () => {
    expect(sessionVisible("alice", { userId: "bob" }, "all")).toBe(true);
  });

  it("test_AC08_nostep_steps_hidden", () => {
    expect(sessionVisible("alice", { userId: "bob" }, "steps")).toBe(false);
  });

  it("test_AC08_nostep_me_hidden", () => {
    expect(sessionVisible("alice", { userId: "bob" }, "me")).toBe(false);
  });

  it("test_AC08_nostep_absent_hidden", () => {
    expect(sessionVisible("alice", { userId: "bob" }, undefined)).toBe(false);
  });

  it("test_AC08_step_key_undefined", () => {
    expect(sessionVisible("alice", { userId: "bob", step: undefined }, "me")).toBe(false);
    // Positive control: the same record with a step is visible.
    expect(sessionVisible("alice", { userId: "bob", step: "G2.b" }, "me")).toBe(true);
  });

  it("test_AC08_exported_from_core_index", () => {
    expect(typeof (core as unknown as { sessionVisible?: unknown }).sessionVisible).toBe("function");
  });
});
