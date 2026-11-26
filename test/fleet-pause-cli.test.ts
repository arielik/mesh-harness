// RL-24 CLI against a World hub: `mesh fleet pause <reason…>` and `mesh fleet resume [reason…]`
// (also as `mesh machines …`), the machine listing kept for every other form, the help, and the
// paused line of `mesh status`. Criterion AC-16. Written from the spec's contracts
// (docs/specs/RL-24.md).

import { afterEach, describe, expect, it } from "vitest";
import { Relay } from "./helpers/relay-kit.ts";
import type { Person } from "./helpers/world.ts";

let r: Relay;
afterEach(async () => {
  await r?.stop();
});

async function cast(): Promise<{ root: Person; bob: Person }> {
  r = await Relay.start(["bob", "root"], { admins: ["root"] });
  const root = await r.w.person("root", "alpha");
  const bob = await r.w.person("bob", "alpha");
  await r.w.flush();
  return { root, bob };
}
const posts = (requests: string[]) => requests.filter((q) => q.startsWith("POST /v1/fleet"));

describe("AC-16 mesh fleet pause and resume", { timeout: 40_000 }, () => {
  it("test_AC16_pause_resume_and_refusal", async () => {
    const { root, bob } = await cast();
    const p = await r.cli(root, ["fleet", "pause", "bad", "agent", "release"]);
    expect(p.code, p.err).toBe(0);
    expect(p.out).toBe("fleet paused: bad agent release (0 headless offer(s) withdrawn)");
    expect(posts(p.requests)).toStrictEqual(["POST /v1/fleet/pause"]);
    const b = await r.cli(bob, ["fleet", "resume"]);
    expect(b.code).toBe(1);
    expect(b.err).toContain("fleet pause and resume are for admins");
    const again = await r.cli(root, ["fleet", "pause", "x"]);
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/^the fleet is already paused since \S+ by root: bad agent release$/);
    const res = await r.cli(root, ["fleet", "resume"]);
    expect(res.code, res.err).toBe(0);
    expect(res.out).toBe("fleet resumed");
    const ev = (await r.allEvents()).filter((e) => e.type === "fleet.resumed");
    expect(ev[0].payload.reason).toBeUndefined();
    const res2 = await r.cli(root, ["fleet", "pause", "two"]);
    expect(res2.code).toBe(0);
    const withReason = await r.cli(root, ["fleet", "resume", "all", "clear"]);
    expect(withReason.out).toBe("fleet resumed");
    expect((await r.allEvents()).filter((e) => e.type === "fleet.resumed").at(-1)?.payload.reason).toBe("all clear");
    const none = await r.cli(root, ["fleet", "pause"]);
    expect(none.code).toBe(2);
    expect(posts(none.requests)).toStrictEqual([]);
  });

  it("test_AC16_machines_alias", async () => {
    const { root } = await cast();
    const p = await r.cli(root, ["machines", "pause", "x"]);
    expect(p.out).toBe("fleet paused: x (0 headless offer(s) withdrawn)");
    const q = await r.cli(root, ["machines", "resume"]);
    expect(q.out).toBe("fleet resumed");
  });

  it("test_AC16_listing_unchanged", async () => {
    const { root } = await cast();
    for (const args of [["fleet"], ["fleet", "--json"], ["fleet", "other"], ["machines"]]) {
      const x = await r.cli(root, args);
      expect(x.code, `${args.join(" ")}: ${x.err}`).toBe(0);
      expect(x.requests).toContain("GET /v1/fleet");
      expect(posts(x.requests)).toStrictEqual([]);
    }
    expect(JSON.parse((await r.cli(root, ["fleet", "--json"])).out).machines.length).toBeGreaterThan(0);
  });

  it("test_AC16_help", async () => {
    const { root } = await cast();
    const fleet = await r.cli(root, ["fleet", "--help"]);
    expect(fleet.out).toContain("mesh fleet pause <reason…>");
    expect(fleet.out).toContain("mesh fleet resume [reason…]");
    const all = await r.cli(root, ["--help"]);
    expect(all.out).toMatch(/fleet .*pause/);
    expect(all.out).toMatch(/fleet .*resume/);
    expect((await r.cli(root, ["machines", "--help"])).out).not.toContain("pause");
  });

  it("test_AC16_status_line", async () => {
    const { root } = await cast();
    expect((await r.cli(root, ["status"])).out).not.toContain("fleet paused");
    const hhmm = new Date(r.w.clock).toISOString().slice(11, 16);
    await r.cli(root, ["fleet", "pause", "bad", "agent", "release"]);
    await r.w.flush();
    const st = await r.cli(root, ["status"]);
    expect(st.out.split("\n")).toContain(`fleet paused since ${hhmm} UTC by @root: bad agent release (no pulses or headless offers; running work goes on)`);
    await r.cli(root, ["fleet", "resume"]);
    await r.w.flush();
    expect((await r.cli(root, ["status"])).out).not.toContain("fleet paused");
  });
});
