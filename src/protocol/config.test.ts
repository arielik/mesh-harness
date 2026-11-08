import { describe, expect, it } from "vitest";
import { DaemonConfig, notifyChannels, notifyMode } from "./config.ts";

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
