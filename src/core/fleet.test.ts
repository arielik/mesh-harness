// AC-17 (MM-1): the text of "my machines" (CLI, MCP tool and TUI panel all use renderFleet).

import { afterEach, describe, expect, it, vi } from "vitest";
import type { FleetMachine, FleetSession, FleetView } from "../protocol/index.ts";
import { filterFleet, renderFleet } from "./fleet.ts";

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
  labels: [],
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

// ---------------------------------------------------------------------------------------------
// MM-2 AC-11: renderFleet with labels.

describe("AC-11 renderFleet with labels", () => {
  const twoRepos = [repo("alpha"), repo("beta")];

  it("test_AC11_machine_labels_current", () => {
    const m = machine("m-0000000c", { hostname: "bob-box", repos: twoRepos, labels: ["perf-lab", "gpu"], current: true });
    expect(renderFleet(view([m]))).toBe("bob-box · online · share me · 2 repos · [gpu, perf-lab] · this machine\n  no sessions");
  });

  it("test_AC11_machine_labels_not_current", () => {
    const m = machine("m-0000000c", { hostname: "bob-box", repos: twoRepos, labels: ["perf-lab", "gpu"], current: false });
    const out = renderFleet(view([m]));
    expect(out).toBe("bob-box · online · share me · 2 repos · [gpu, perf-lab]\n  no sessions");
    expect(out).not.toContain("this machine");
  });

  it("test_AC11_session_labels", () => {
    const m = machine("m-0000000c", {
      hostname: "bob-box",
      sessions: [session("s-1", { repo: "alpha", name: "tune", state: "working", step: "S", labels: ["perf"], lastEventAt: NOW - 45 * S })],
    });
    expect(renderFleet(view([m]))).toBe("bob-box · online · share me · 0 repos\n  alpha · tune · working · S · [perf] · 45s");
  });

  it("test_AC11_session_labels_no_step_sorted", () => {
    const m = machine("m-0000000c", {
      hostname: "bob-box",
      sessions: [session("s-1", { repo: "alpha", name: "tune", labels: ["perf", "gpu"], lastEventAt: NOW - 3 * M })],
    });
    expect(renderFleet(view([m]))).toBe("bob-box · online · share me · 0 repos\n  alpha · tune · idle · no step · [gpu, perf] · 3m");
  });

  it("test_AC11_empty_labels_no_brackets", () => {
    const withKey = machine("m-0000000c", { hostname: "bob-box", labels: [], sessions: [session("s-1", { repo: "r", name: "n" })] });
    const out = renderFleet(view([withKey]));
    expect(out).not.toContain("[");
    expect(out).toBe("bob-box · online · share me · 0 repos\n  r · n · idle · no step · 3m");
    // The MM-1 fixtures (now carrying `labels: []`) render exactly as before.
    expect(renderFleet(view([desk, old]))).toBe(`${DESK_TEXT}\n\n${OLD_TEXT}`);
  });

  it("test_AC11_both_in_one_view", () => {
    const m = machine("m-0000000a", {
      hostname: "bob-desk",
      nickname: "desk",
      repos: [repo("alpha")],
      labels: ["gpu"],
      current: true,
      sessions: [session("s-desk-1", { repo: "alpha", name: "fix-login", state: "working", step: "G3.api", labels: ["dataplane"], lastEventAt: NOW - 45 * S })],
    });
    expect(renderFleet(view([m, old]))).toBe(
      `desk (bob-desk) · online · share me · 1 repo · [gpu] · this machine\n  alpha · fix-login · working · G3.api · [dataplane] · 45s\n\n${OLD_TEXT}`,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// MM-2 AC-12: filterFleet.

describe("AC-12 filterFleet", () => {
  const s = (sid: string, labels: string[]) => session(sid, labels.length ? { labels } : {});
  const M1 = machine("m-00000001", { hostname: "one", labels: ["perf"], sessions: [s("a", []), s("b", ["gpu"])] });
  const M2 = machine("m-00000002", { hostname: "two", sessions: [s("c", ["perf"]), s("d", ["gpu"]), s("e", ["gpu", "perf"])] });
  const M3 = machine("m-00000003", { hostname: "three", current: true, sessions: [s("f", [])] });
  const M4 = machine("m-00000004", { hostname: "four", labels: ["gpu", "perf"], sessions: [s("g", [])] });
  const v = view([M1, M2, M3, M4]);
  const shape = (fv: FleetView) => fv.machines.map((m) => [m.id, m.sessions.map((x) => x.sid)]);

  it("test_AC12_empty_returns_view", () => {
    expect(filterFleet(v, [])).toStrictEqual(v);
  });

  it("test_AC12_single_label", () => {
    expect(shape(filterFleet(v, ["perf"]))).toEqual([
      ["m-00000001", ["a", "b"]],
      ["m-00000002", ["c", "e"]],
      ["m-00000004", ["g"]],
    ]);
  });

  it("test_AC12_two_labels_all_must_match", () => {
    expect(shape(filterFleet(v, ["perf", "gpu"]))).toEqual([
      ["m-00000002", ["e"]],
      ["m-00000004", ["g"]],
    ]);
    // Order of the given labels does not matter.
    expect(shape(filterFleet(v, ["gpu", "perf"]))).toEqual(shape(filterFleet(v, ["perf", "gpu"])));
  });

  it("test_AC12_no_match_empty", () => {
    const out = filterFleet(v, ["nope"]);
    expect(out.machines).toEqual([]);
    expect(out.now).toBe(v.now);
  });

  it("test_AC12_other_fields_and_order", () => {
    for (const labels of [["perf"], ["perf", "gpu"]]) {
      const out = filterFleet(v, labels);
      expect(out.now).toBe(v.now);
      expect(out.user).toStrictEqual(v.user);
      expect(out.machines.length).toBeGreaterThan(0);
      for (const m of out.machines) {
        const src = v.machines.find((x) => x.id === m.id) as FleetMachine;
        const { sessions: _a, ...rest } = m;
        const { sessions: _b, ...srcRest } = src;
        expect(rest).toStrictEqual(srcRest);
        for (const x of m.sessions) expect(x).toStrictEqual(src.sessions.find((y) => y.sid === x.sid));
      }
    }
    // A kept current machine stays current.
    const withCurrent = view([machine("m-00000009", { hostname: "here", current: true, labels: ["perf"] }), M2]);
    const out = filterFleet(withCurrent, ["perf"]);
    expect(out.machines.map((m) => [m.id, m.current])).toEqual([
      ["m-00000009", true],
      ["m-00000002", false],
    ]);
  });

  it("test_AC12_no_mutation", () => {
    const copy = structuredClone(v);
    filterFleet(v, ["perf"]);
    filterFleet(v, ["perf", "gpu"]);
    expect(v).toStrictEqual(copy);
  });
});
