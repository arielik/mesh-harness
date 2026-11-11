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
