// AC-17 (MM-1): the text of "my machines" (CLI, MCP tool and TUI panel all use renderFleet).

import { afterEach, describe, expect, it, vi } from "vitest";
import type { FleetMachine, FleetSession, FleetView } from "../protocol/index.ts";
import { renderFleet } from "./fleet.ts";

const NOW = 1_000_000_000_000;
const S = 1_000;
const M = 60 * S;
const H = 60 * M;

const repo = (name: string) => ({ id: `example.org/team/${name}`, name });

const session = (sid: string, over: Partial<FleetSession> = {}): FleetSession => ({
  sid,
  machine: "m-0000000a",
  user: "bob",
  state: "idle",
  lastEventAt: NOW - 3 * M,
  ...over,
});

const machine = (id: string, over: Partial<FleetMachine> = {}): FleetMachine => ({
  id,
  hostname: `host-${id}`,
  online: true,
  lastSeen: NOW - 10 * S,
  counts: {},
  share: "me",
  repos: [],
  current: false,
  sessions: [],
  ...over,
});

const view = (machines: FleetMachine[], now = NOW): FleetView => ({ now, user: { id: "bob", name: "bob", roles: ["member"] }, machines });

const desk = machine("m-0000000a", {
  hostname: "bob-desk",
  nickname: "desk",
  online: true,
  share: "me",
  repos: [repo("alpha")],
  current: true,
  sessions: [session("s-desk-1", { repo: "alpha", name: "fix-login", state: "working", step: "G3.api", lastEventAt: NOW - 45 * S })],
});

const old: FleetMachine = (() => {
  const m = machine("m-0000000b", { hostname: "bob-old", online: false, lastSeen: NOW - 2 * H, repos: [repo("a"), repo("b"), repo("c")], sessions: [] });
  delete (m as { share?: unknown }).share;
  return m;
})();

const DESK_TEXT = "desk (bob-desk) · online · share me · 1 repo · this machine\n  alpha · fix-login · working · G3.api · 45s";
const OLD_TEXT = "bob-old · last seen 2h ago · share ? · 3 repos\n  no sessions";
const EMPTY = "No machines logged in as you yet. Run mesh login on each machine.";

afterEach(() => {
  vi.useRealTimers();
});

describe("AC-17 renderFleet", () => {
  it("test_AC17_online_nickname_current", () => {
    expect(renderFleet(view([desk]))).toBe(DESK_TEXT);
  });

  it("test_AC17_offline_no_nickname_no_sessions", () => {
    expect(renderFleet(view([old]))).toBe(OLD_TEXT);
  });

  it("test_AC17_session_without_repo_name_step", () => {
    const m = machine("m-0000000c", { hostname: "bob-box", sessions: [session("abcdef1234567", { state: "idle", lastEventAt: NOW - 3 * M })] });
    expect(renderFleet(view([m]))).toBe("bob-box · online · share me · 0 repos\n  - · abcdef12 · idle · no step · 3m");
  });

  it("test_AC17_needs_suffix", () => {
    const m = machine("m-0000000c", {
      hostname: "bob-box",
      sessions: [session("s-1", { repo: "beta", name: "review", state: "needs_you", needs: "permission", lastEventAt: NOW - 2 * H })],
    });
    expect(renderFleet(view([m]))).toBe("bob-box · online · share me · 0 repos\n  beta · review · needs_you (permission) · no step · 2h");
  });

  it.each([
    [59 * S, "59s"],
    [60 * S, "1m"],
    [45 * M, "45m"],
    [60 * M, "1h"],
    [47 * H, "47h"],
    [48 * H, "2d"],
    [72 * H, "3d"],
  ])("test_AC17_age_boundaries: %d ms → %s", (ms, text) => {
    const m = machine("m-0000000c", { hostname: "bob-box", sessions: [session("s-1", { repo: "r", name: "n", lastEventAt: NOW - ms })] });
    expect(renderFleet(view([m]))).toBe(`bob-box · online · share me · 0 repos\n  r · n · idle · no step · ${text}`);
  });

  it("test_AC17_zero_repos_plural", () => {
    const m = machine("m-0000000c", { hostname: "bob-box", share: "all", repos: [] });
    expect(renderFleet(view([m]))).toBe("bob-box · online · share all · 0 repos\n  no sessions");
  });

  it("test_AC17_blocks_separated_by_one_empty_line", () => {
    const out = renderFleet(view([desk, old]));
    expect(out).toBe(`${DESK_TEXT}\n\n${OLD_TEXT}`);
    expect(out.endsWith("\n")).toBe(false);
  });

  it("test_AC17_skipCurrent", () => {
    expect(renderFleet(view([desk, old]), { skipCurrent: true })).toBe(OLD_TEXT);
    // Positive control: without the option the current machine is there.
    expect(renderFleet(view([desk, old]), { skipCurrent: false })).toContain("this machine");
  });

  it("test_AC17_empty_fleet", () => {
    expect(renderFleet(view([]))).toBe(EMPTY);
    expect(renderFleet(view([desk]), { skipCurrent: true })).toBe(EMPTY);
  });

  it("test_AC17_uses_view_now", () => {
    const before = renderFleet(view([desk, old]));
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 365 * 24 * H);
    expect(renderFleet(view([desk, old]))).toBe(before);
    expect(before).toBe(`${DESK_TEXT}\n\n${OLD_TEXT}`);
  });
});
