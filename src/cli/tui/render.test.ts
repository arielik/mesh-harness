import { describe, expect, it } from "vitest";
import { renderFleet } from "../../core/index.ts";
import type { FleetMachine, FleetSession, FleetView, Session } from "../../protocol/index.ts";
import { age, groupOf, ordered, render, renderMachines } from "./render.ts";

const NOW = 10_000_000;
const base = (sid: string, over: Partial<Session>): Session => ({
  sid,
  claudeSessionIds: [`c-${sid}`],
  cwd: `/w/${sid}`,
  kind: "interactive",
  state: "idle",
  quiet: false,
  startedAt: NOW - 3_600_000,
  lastEventAt: NOW - 60_000,
  turns: 3,
  humanPrompts: 2,
  seenByReconciler: true,
  ...over,
});

const sessions: Session[] = [
  base("a", { repo: { id: "x/frr-dplane-ovs", name: "frr-dplane-ovs" }, state: "needs_you", needs: "permission", lastStopAt: NOW - 120_000, pane: "%3" }),
  base("b", { repo: { id: "x/vpc-node-agent", name: "vpc-node-agent" }, state: "needs_you", needs: "question", lastMessage: "Keep the v4 fallback on by default?", lastStopAt: NOW - 360_000 }),
  base("c", { repo: { id: "x/proto-defs", name: "proto-defs" }, state: "working", turns: 14, lastTurnStartAt: NOW - 180_000, lastEventAt: NOW - 5_000 }),
  base("d", { repo: { id: "x/rust-ovs", name: "rust-ovs" }, state: "working", quiet: true, transcriptMtime: NOW - 25 * 60_000, lastEventAt: NOW - 25 * 60_000 }),
  base("e", { name: "docs-bg", kind: "background", bgId: "93474861", state: "idle", lastMessage: "Docs updated.", lastStopAt: NOW - 30_000 }),
  base("f", { state: "ended", endedReason: "prompt_input_exit", endedAt: NOW - 1000 }),
];

describe("render", () => {
  it("groups and orders sessions", () => {
    expect(ordered(sessions).map((s) => `${groupOf(s)}:${s.sid}`)).toEqual([
      "NEEDS YOU:a",
      "NEEDS YOU:b",
      "WORKING:c",
      "STALLED / QUIET:d",
      "IDLE:e",
      "ENDED:f",
    ]);
  });

  it("renders the list (snapshot)", () => {
    const lines = render({
      sessions,
      messages: [{ id: 1, sid: "c", text: "hi", state: "pending", createdAt: NOW }],
      selected: "b",
      now: NOW,
      width: 100,
      height: 24,
      header: "mesh 0.0.0 · ariel",
      color: false,
    });
    expect(lines.join("\n")).toMatchSnapshot();
  });

  it("shows windows waiting to start and sessions that started before mesh", () => {
    const lines = render({
      sessions: [
        base("t", { name: "mesh-try·G1.design", launching: true, state: "needs_you", needs: "dialog", turns: 0, lastEventAt: NOW - 20_000 }),
        base("s", { name: "web", launching: true, state: "working", turns: 0, lastEventAt: NOW - 3_000 }),
        // Seen only by the reconciler: started 10 days ago, transcript written 2 minutes ago.
        base("p", { name: "old", state: "working", turns: 0, startedAt: NOW - 864_000_000, lastEventAt: NOW - 864_000_000, transcriptMtime: NOW - 120_000 }),
        base("i", { name: "old-idle", state: "idle", turns: 0, lastEventAt: NOW - 864_000_000, transcriptMtime: NOW - 300_000 }),
      ],
      messages: [],
      now: NOW,
      width: 120,
      height: 20,
      header: "mesh",
      color: false,
    });
    const row = (name: string) => lines.find((l) => l.includes(name)) ?? "";
    expect(row("mesh-try")).toContain("accept Claude's folder trust prompt");
    expect(row(" web ")).toContain("starting Claude…");
    expect(row(" old ")).toContain("started before mesh setup");
    expect(row(" old ").trimEnd().endsWith("2m")).toBe(true);
    expect(row("old-idle").trimEnd().endsWith("5m")).toBe(true);
  });

  it("shows the say prompt and status, and an empty state", () => {
    const lines = render({
      sessions: [],
      messages: [],
      now: NOW,
      width: 80,
      height: 10,
      header: "mesh",
      status: "message queued",
      input: { label: "say to x: ", value: "hello" },
      color: false,
    });
    expect(lines.join("\n")).toContain("No Claude Code sessions yet");
    expect(lines.at(-2)).toBe("say to x: hello▌");
    expect(lines.at(-1)?.trim()).toBe("message queued");
    expect(lines).toHaveLength(10);
  });

  it.each([
    [5_000, "5s"],
    [90_000, "2m"],
    [3 * 3_600_000, "3h"],
    [72 * 3_600_000, "3d"],
  ])("age(%d) = %s", (ms, text) => {
    expect(age(ms)).toBe(text);
  });
});

// AC-22 (MM-1): the "My machines" panel.
describe("AC-22 renderMachines", () => {
  const now = 1_000_000_000_000;
  const session = (sid: string, over: Partial<FleetSession> = {}): FleetSession => ({ sid, machine: "m-x", user: "bob", state: "idle", lastEventAt: now - 60_000, ...over });
  const machine = (id: string, over: Partial<FleetMachine> = {}): FleetMachine => ({
    id,
    hostname: `host-${id}`,
    online: true,
    lastSeen: now - 5_000,
    counts: {},
    share: "me",
    repos: [],
    labels: [],
    current: false,
    sessions: [],
    ...over,
  });
  const here = machine("m-0000000a", { hostname: "bob-here", nickname: "here", current: true, sessions: [session("s-here", { repo: "alpha", name: "local-work" })] });
  const other = machine("m-0000000b", { hostname: "bob-desk", nickname: "desk", sessions: [session("s-desk", { repo: "beta", name: "remote-work", step: "G2.api" })] });
  const fleet = (machines: FleetMachine[]): FleetView => ({ now, user: { id: "bob", name: "bob", roles: ["member"] }, machines });
  const FOOTER = "m back to sessions · g goals · details: mesh machines";
  // eslint-disable-next-line no-control-regex -- ANSI escapes
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

  it("test_AC22_first_lines", () => {
    const lines = renderMachines(fleet([here, other]), { width: 100, height: 20, header: "mesh 0.1.9 · bob" });
    expect(stripAnsi(lines[0] ?? "").trimEnd()).toBe("mesh 0.1.9 · bob");
    expect(stripAnsi(lines[1] ?? "").trim()).toBe("");
    expect(stripAnsi(lines[2] ?? "").trimEnd()).toBe("MY MACHINES");
  });

  it("test_AC22_skips_current", () => {
    const f = fleet([here, other]);
    const lines = renderMachines(f, { width: 120, height: 20, header: "mesh" }).map((l) => stripAnsi(l).trimEnd());
    const text = lines.join("\n");
    expect(text).not.toContain("bob-here");
    expect(text).not.toContain("local-work");
    expect(text).toContain("bob-desk");
    expect(text).toContain("remote-work");
    // The other machine's lines are renderFleet's, each indented by two spaces.
    const expected = renderFleet(f, { skipCurrent: true })
      .split("\n")
      .map((l) => (l ? `  ${l}` : l));
    const start = lines.indexOf(expected[0] as string);
    expect(start).toBeGreaterThan(2);
    expect(lines.slice(start, start + expected.length)).toEqual(expected);
  });

  it("test_AC22_only_current_empty_text", () => {
    const lines = renderMachines(fleet([here]), { width: 100, height: 12, header: "mesh" }).map((l) => stripAnsi(l).trimEnd());
    expect(lines).toContain("  No other machines. Run mesh login on your other machines.");
    expect(lines.join("\n")).not.toContain("bob-here");
    // Positive control: with another machine the empty text is gone.
    expect(renderMachines(fleet([here, other]), { width: 100, height: 12, header: "mesh" }).join("\n")).not.toContain("No other machines");
  });

  it("test_AC22_footer_last", () => {
    for (const status of [undefined, "fetch failed"]) {
      const lines = renderMachines(fleet([here, other]), { width: 100, height: 15, header: "mesh", ...(status ? { status } : {}) });
      expect(stripAnsi(lines.at(-1) ?? "").trim()).toBe(FOOTER);
    }
  });

  it("test_AC22_status_above_footer", () => {
    const height = 15;
    const lines = renderMachines(fleet([here, other]), { width: 100, height, header: "mesh", status: "fetch failed" });
    expect(stripAnsi(lines[height - 2] ?? "").trim()).toBe("fetch failed");
    expect(lines.filter((l) => l.includes("fetch failed"))).toHaveLength(1);
  });

  it.each([10, 40])("test_AC22_height_exact (%d)", (height) => {
    expect(renderMachines(fleet([here, other]), { width: 100, height, header: "mesh" })).toHaveLength(height);
    expect(renderMachines(fleet([here]), { width: 100, height, header: "mesh", status: "x" })).toHaveLength(height);
  });

  it("test_AC22_width_limit", () => {
    const long = machine("m-0000000c", {
      hostname: "a-very-long-hostname-for-a-build-machine.example.org",
      nickname: "build-box-with-a-long-name",
      repos: [{ id: "example.org/team/r", name: "r" }],
      sessions: [session("s-long", { repo: "a-repository-with-a-long-name", name: "a session name that goes on and on", step: "G12.some-long-step", state: "needs_you", needs: "permission" })],
    });
    const lines = renderMachines(fleet([here, other, long]), {
      width: 30,
      height: 20,
      header: "\x1b[1mmesh 0.1.9 · bob with a long header line\x1b[0m",
      status: "\x1b[31ma status line that is longer than thirty\x1b[0m",
    });
    expect(lines).toHaveLength(20);
    expect(lines.join("\n")).toContain("desk"); // positive control: content is there
    for (const l of lines) expect(stripAnsi(l).length).toBeLessThanOrEqual(30);
  });

  it("test_AC22_session_footer_has_m", () => {
    const lines = render({ sessions, messages: [], now: NOW, width: 160, height: 20, header: "mesh", color: false });
    expect(lines.join("\n")).toContain("m machines");
  });
});

// MM-2 AC-17: labels in the session list and the machines panel.
describe("AC-17 labels in the TUI", () => {
  const labelled = [
    base("e", { name: "docs-bg", kind: "background", bgId: "93474861", state: "idle", lastMessage: "Docs updated.", lastStopAt: NOW - 30_000, labels: ["gpu", "perf"] }),
    base("c", { repo: { id: "x/proto-defs", name: "proto-defs" }, state: "working", turns: 14, lastTurnStartAt: NOW - 180_000, lastEventAt: NOW - 5_000, labels: ["perf"] }),
    base("u", { name: "plain-one", state: "idle", lastMessage: "All good.", lastStopAt: NOW - 30_000 }),
  ];
  const lines = () => render({ sessions: labelled, messages: [], now: NOW, width: 120, height: 24, header: "mesh", color: false });
  const row = (name: string) => lines().find((l) => l.includes(name)) ?? "";

  it("test_AC17_labelled_row", () => {
    expect(row("docs-bg")).toContain("docs-bg");
    expect(row("docs-bg")).toContain("[gpu, perf] done: Docs updated.");
    expect(row("proto-defs")).toContain("[perf] working · turn 14");
  });

  it("test_AC17_footer_L_labels", () => {
    expect(lines().join("\n")).toContain("L labels");
    // The same footer at the snapshot width.
    const narrow = render({ sessions, messages: [], now: NOW, width: 160, height: 20, header: "mesh", color: false });
    expect(narrow.join("\n")).toContain("L labels");
  });

  it("test_AC17_unlabelled_rows_unchanged", () => {
    // Positive control first: a labelled row has brackets.
    expect(row("docs-bg")).toContain("[");
    const plain = row("plain-one");
    expect(plain).toContain("done: All good.");
    expect(plain).not.toContain("[");
    // The same session rendered alone, without any labelled neighbour, gives the same row.
    const alone = render({ sessions: [labelled[2] as Session], messages: [], now: NOW, width: 120, height: 24, header: "mesh", color: false }).find((l) => l.includes("plain-one"));
    expect(plain).toBe(alone);
  });

  it("test_AC17_machines_view_labels", () => {
    const now = 1_000_000_000_000;
    const fleet: FleetView = {
      now,
      user: { id: "bob", name: "bob", roles: ["member"] },
      machines: [
        {
          id: "m-0000000b",
          hostname: "bob-desk",
          online: true,
          lastSeen: now - 5_000,
          counts: {},
          share: "me",
          repos: [],
          labels: ["perf-lab", "gpu"],
          current: false,
          sessions: [{ sid: "s-desk", machine: "m-0000000b", user: "bob", state: "idle", lastEventAt: now - 60_000, repo: "beta", name: "remote-work", labels: ["perf"] }],
        },
      ],
    };
    const text = renderMachines(fleet, { width: 120, height: 20, header: "mesh" }).join("\n");
    expect(text).toContain("[gpu, perf-lab]");
    expect(text).toContain("[perf]");
    expect(renderFleet(fleet, { skipCurrent: true })).toContain("bob-desk · online · share me · 0 repos · [gpu, perf-lab]");
  });
});
