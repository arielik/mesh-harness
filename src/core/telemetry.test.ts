// RL-1 AC-15, AC-16, AC-17: telemetryFromStream and renderTail (docs/specs/RL-1.md, Core). The
// complete-stream case uses the spike's sample stream (docs/analysis/2026-11-12-claude-cli-spike.md §2).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as core from "./index.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- new exports, read loosely
const C = core as any;
type Run = { durationMs: number; exitCode: number | undefined; killedForBudget: boolean; stoppedAfterDone?: boolean };
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- telemetry fields, read loosely
const tele = (stream: string, run: Run): any => C.telemetryFromStream(stream, run);
const tail = (stream: string, stderr: string, exit: string): string => C.renderTail(stream, stderr, exit);

const SAMPLE = readFileSync(join(import.meta.dirname, "..", "..", "test", "fixtures", "claude", "stream", "spike-sample.jsonl"), "utf8");
const lines = (...objs: unknown[]) => objs.map((o) => (typeof o === "string" ? o : JSON.stringify(o))).join("\n") + "\n";
const usage = (i: number, o: number, r: number, w: number) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: r, cache_creation_input_tokens: w });
const result = (over: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 2,
  duration_ms: 500,
  total_cost_usd: 0.5,
  usage: usage(1, 2, 3, 4),
  permission_denials: [],
  ...over,
});
const assistant = (id: string, content: unknown[], u = usage(1, 1, 0, 0), model = "m-a") => ({ type: "assistant", message: { model, id, role: "assistant", content, usage: u } });
const text = (t: string) => ({ type: "text", text: t });

describe("AC-15 with result", () => {
  it("test_AC15_spike_sample", () => {
    const initTools = (JSON.parse(SAMPLE.split("\n")[2] as string) as { tools: string[] }).tools;
    const t = tele(SAMPLE, { durationMs: 99_999, exitCode: 0, killedForBudget: false });
    expect(t).toMatchObject({
      exit: "success",
      turns: 1,
      turnsApprox: false,
      tokensIn: 2,
      tokensOut: 4,
      cacheRead: 11382,
      cacheWrite: 12236,
      costUsdEstimate: 0.00256322,
      durationMs: 1425,
      model: "claude-haiku-5-5",
      sessionId: "85ad50b7-…",
      mcpServers: ["mesh", "claude.ai Claude Docs"],
      permissionDenials: { count: 0, tools: [] },
    });
    expect(t.tools).toStrictEqual(initTools);
    // rate_limit_event is never used: no field carries its data.
    expect(JSON.stringify(t)).not.toContain("seven_day");
    expect(JSON.stringify(t)).not.toContain("0.81");
  });

  it("test_AC15_exit1_with_result", () => {
    const s = lines({ type: "system", subtype: "init", session_id: "s1", model: "m1", tools: [], mcp_servers: [] }, result({ subtype: "error_max_turns", is_error: true, num_turns: 6 }));
    const t = tele(s, { durationMs: 10, exitCode: 1, killedForBudget: false });
    expect(t.exit).toBe("error_max_turns");
    expect(t.turnsApprox).toBe(false);
    expect(t.turns).toBe(6);
  });

  it("test_AC15_last_result_counts", () => {
    const s = lines(result({ subtype: "success", num_turns: 1 }), result({ subtype: "error_during_execution", num_turns: 3 }));
    const t = tele(s, { durationMs: 10, exitCode: 0, killedForBudget: false });
    expect(t.exit).toBe("error_during_execution");
    expect(t.turns).toBe(3);
  });

  it("test_AC15_denials", () => {
    const d = (tool_name: string) => ({ tool_name, tool_use_id: "t", tool_input: {} });
    const s = lines(result({ permission_denials: [d("Bash"), d("Edit"), d("Bash")] }));
    expect(tele(s, { durationMs: 1, exitCode: 0, killedForBudget: false }).permissionDenials).toStrictEqual({ count: 3, tools: ["Bash", "Edit"] });
  });

  it("test_AC15_model_fallback", () => {
    const s = lines(assistant("m1", [text("hi")], usage(1, 1, 0, 0), "m-x"), result());
    const t = tele(s, { durationMs: 1, exitCode: 0, killedForBudget: false });
    expect(t.model).toBe("m-x");
    expect(t.sessionId).toBeUndefined();
  });
});

describe("AC-16 partial", () => {
  const ids = ["m1", "m2", "m3", "m4"];
  const per: Record<string, ReturnType<typeof usage>> = { m1: usage(10, 1, 5, 7), m2: usage(20, 2, 5, 7), m3: usage(30, 3, 5, 7), m4: usage(40, 4, 5, 7) };
  const events = (): unknown[] => [
    { type: "system", subtype: "init", session_id: "sid-1", model: "m-init", tools: ["Read"], mcp_servers: [{ name: "mesh", status: "connected" }] },
    ...ids.flatMap((id) => [assistant(id, [text(`a ${id}`)], per[id]), assistant(id, [{ type: "tool_use", id: "t", name: "Read", input: {} }], per[id])]),
    { type: "system", subtype: "permission_denied" },
    { type: "system", subtype: "permission_denied" },
  ];

  it("test_AC16_distinct_ids", () => {
    const t = tele(lines(...events()), { durationMs: 4321, exitCode: 0, killedForBudget: false });
    expect(t).toMatchObject({ turns: 4, turnsApprox: true, tokensIn: 100, tokensOut: 10, cacheRead: 20, cacheWrite: 28, durationMs: 4321, permissionDenials: { count: 2, tools: [] } });
    expect("costUsdEstimate" in t).toBe(false);
    expect(t.model).toBe("m-init");
    expect(t.sessionId).toBe("sid-1");
    expect(t.mcpServers).toStrictEqual(["mesh"]);
  });

  it.each([
    [{ killedForBudget: true, exitCode: 143 }, "killed_budget"],
    [{ killedForBudget: true, exitCode: 0 }, "killed_budget"],
    [{ killedForBudget: false, exitCode: 0 }, "no_result"],
    [{ killedForBudget: false, exitCode: 143 }, "crashed"],
    [{ killedForBudget: false, exitCode: 1 }, "crashed"],
    [{ killedForBudget: false, exitCode: undefined }, "crashed"],
    // RL-1: ended by the daemon after its accepted mesh_done: not a crash, not a budget kill.
    [{ killedForBudget: false, exitCode: 143, stoppedAfterDone: true }, "no_result"],
    [{ killedForBudget: false, exitCode: 137, stoppedAfterDone: true }, "no_result"],
  ])("test_AC16_exit_mapping %j", (run, exit) => {
    expect(tele(lines(...events()), { durationMs: 1, ...run }).exit).toBe(exit);
  });

  it("test_AC16_empty_crashed", () => {
    const t = tele("", { durationMs: 7, exitCode: 1, killedForBudget: false });
    expect(t).toMatchObject({ exit: "crashed", turns: 0, turnsApprox: true, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, durationMs: 7 });
  });

  it("test_AC16_noise_ignored", () => {
    const clean = tele(lines(...events()), { durationMs: 4321, exitCode: 0, killedForBudget: false });
    const ev = events();
    const noisy = [
      "not json",
      ...ev.slice(0, 3),
      "[1,2]",
      '"str"',
      { type: "weird", message: { id: "m9", usage: usage(1000, 1000, 0, 0) } },
      ...ev.slice(3, 6),
      { type: "system", subtype: "thinking_tokens", tokens: 5 },
      { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", utilization: 0.81 } },
      ...ev.slice(6),
      "",
      "{broken",
    ];
    const t = tele(lines(...noisy), { durationMs: 4321, exitCode: 0, killedForBudget: false });
    expect(t).toStrictEqual(clean);
    // Positive control: the clean stream is not empty telemetry.
    expect(clean.turns).toBe(4);
  });
});

describe("AC-17 renderTail", () => {
  const isJsonObject = (l: string): boolean => {
    try {
      const v: unknown = JSON.parse(l);
      return typeof v === "object" && v !== null && !Array.isArray(v);
    } catch {
      return false;
    }
  };

  it("test_AC17_sections", () => {
    const ev: unknown[] = [];
    for (let i = 1; i <= 7; i++) {
      ev.push(assistant(`m${i}`, [text(`t${i}`)]));
      if (i === 6) ev.push(assistant("tu", [{ type: "tool_use", id: "x", name: "Read", input: {} }]));
    }
    ev.push(result({ subtype: "error_max_turns", errors: ["e1", "e2"] }));
    const stderr = Array.from({ length: 25 }, (_, i) => `s${i + 1}`).join("\n") + "\n";
    const out = tail(lines(...ev), stderr, "error_max_turns").split("\n");
    expect(out[0]).toBe("Run ended: error_max_turns");
    const a = out.indexOf("--- last assistant messages ---");
    const e = out.indexOf("--- errors ---");
    const s = out.indexOf("--- stderr (last 20 lines) ---");
    expect(a).toBeGreaterThan(0);
    expect(e).toBeGreaterThan(a);
    expect(s).toBeGreaterThan(e);
    const pick = (from: number, to: number | undefined, re: RegExp) => out.slice(from, to).flatMap((l) => l.match(re) ?? []);
    expect(pick(a + 1, e, /\bt\d\b/g)).toStrictEqual(["t3", "t4", "t5", "t6", "t7"]);
    expect(pick(e + 1, s, /\be\d\b/g)).toStrictEqual(["e1", "e2"]);
    expect(pick(s + 1, undefined, /\bs\d+\b/g)).toStrictEqual(Array.from({ length: 20 }, (_, i) => `s${i + 6}`));
    expect(out.join("\n")).not.toMatch(/\bt[12]\b/);
  });

  it("test_AC17_cut", () => {
    const long = "abcdefghij".repeat(500);
    const out = tail(lines(assistant("m1", [text(long)])), "", "no_result");
    const kept = out.match(/abcdefghij/g)?.length ?? 0;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThanOrEqual(200);
    expect(out.split("\n")[1]).toBe("--- last assistant messages ---");
  });

  it("test_AC17_empty_sections", () => {
    expect(tail("", "", "crashed")).toBe("Run ended: crashed");
  });

  it("test_AC17_stderr_only", () => {
    const out = tail("", "boom\n", "crashed").split("\n");
    expect(out[0]).toBe("Run ended: crashed");
    expect(out).toContain("--- stderr (last 20 lines) ---");
    expect(out).toContain("boom");
    expect(out).not.toContain("--- last assistant messages ---");
    expect(out).not.toContain("--- errors ---");
  });

  it("test_AC17_no_json_line", () => {
    const out = tail(lines(assistant("m1", [text('{"type":"result","x":1}')])), '{"a":1}\n', "no_result");
    for (const l of out.split("\n")) expect(isJsonObject(l), l).toBe(false);
    expect(out).toContain("type");
    expect(out).toContain('"a"');
  });
});

// =============================================================================================
// RL-11 AC-01, AC-02: toolsUsed and denied (docs/specs/RL-11.md, "Telemetry from the stream")
// =============================================================================================

const use = (name: unknown) => ({ type: "tool_use", id: "t", ...(name === undefined ? {} : { name }), input: {} });
const sub = (id: string, content: unknown[]) => ({ ...assistant(id, content), parent_tool_use_id: "toolu_parent" });
const RUN: Run = { durationMs: 10, exitCode: 0, killedForBudget: false };

describe("RL-11 AC-01 toolsUsed", () => {
  const blocks = [assistant("a1", [use("Read"), use("Bash")]), assistant("a2", [use("Read"), use(""), use(undefined)]), sub("s1", [use("Grep")])];

  it("test_AC01_with_result", () => {
    const t = tele(lines(...blocks, result()), RUN);
    expect(t.toolsUsed).toStrictEqual(["Bash", "Grep", "Read"]);
  });

  it("test_AC01_partial", () => {
    const t = tele(lines(...blocks), RUN);
    expect(t.turnsApprox).toBe(true);
    expect(t.toolsUsed).toStrictEqual(["Bash", "Grep", "Read"]);
  });

  it("test_AC01_none", () => {
    const t = tele(lines(assistant("a1", [text("hi")]), result()), RUN);
    expect("toolsUsed" in t).toBe(false);
  });

  it("test_AC01_cut_and_cap", () => {
    const long = "x".repeat(250);
    expect(tele(lines(assistant("a1", [use(long)]), result()), RUN).toolsUsed).toStrictEqual(["x".repeat(200)]);
    const names = Array.from({ length: 205 }, (_, i) => `T${String(i).padStart(3, "0")}`);
    const t = tele(lines(assistant("a1", [...names].reverse().map(use)), result()), RUN);
    expect(t.toolsUsed).toStrictEqual(names.slice(0, 200));
  });
});

describe("RL-11 AC-02 denied", () => {
  const bash = (command: unknown) => ({ tool_name: "Bash", tool_use_id: "x", tool_input: command === undefined ? {} : { command } });
  it("test_AC02_grouping", () => {
    const denials = [bash("FOO=1 /usr/bin/git push origin x"), bash("FOO=1 /usr/bin/git push origin x"), bash("cargo test"), { tool_name: "Write", tool_input: { file_path: "/etc/x", content: "secret" } }, bash(undefined), { tool_input: { command: "rm -rf /" } }];
    const t = tele(lines(result({ permission_denials: denials })), RUN);
    expect(t.denied).toStrictEqual([
      { tool: "Bash", command: "git", count: 2 },
      { tool: "Bash", count: 1 },
      { tool: "Bash", command: "cargo", count: 1 },
      { tool: "Write", count: 1 },
    ]);
    expect(t.permissionDenials.count).toBe(6);
    expect(JSON.stringify(t.denied)).not.toMatch(/push|origin|test|secret|etc|rm/);
  });

  it("test_AC02_no_word", () => {
    const t = tele(lines(result({ permission_denials: [bash("A=1 B=2")] })), RUN);
    expect(t.denied).toStrictEqual([{ tool: "Bash", count: 1 }]);
  });

  it("test_AC02_none", () => {
    expect("denied" in tele(lines(result()), RUN)).toBe(false);
    expect("denied" in tele(lines(assistant("a1", [text("x")])), RUN)).toBe(false);
  });

  it("test_AC02_cap", () => {
    const denials = Array.from({ length: 60 }, (_, i) => bash(`cmd${i} arg`));
    const t = tele(lines(result({ permission_denials: denials })), RUN);
    expect(t.denied).toHaveLength(50);
    expect(t.permissionDenials.count).toBe(60);
    // All counts are 1: ordered by command in UTF-16 code-unit order, the first 50 kept.
    const words = Array.from({ length: 60 }, (_, i) => `cmd${i}`).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(t.denied).toStrictEqual(words.slice(0, 50).map((command) => ({ tool: "Bash", command, count: 1 })));
  });

  it("test_AC02_passes_hub_validation", async () => {
    const { RunTelemetry } = await import("../protocol/index.ts");
    const many = Array.from({ length: 60 }, (_, i) => bash(`cmd${i}`));
    const names = Array.from({ length: 205 }, (_, i) => `T${i}`).map(use);
    for (const stream of [
      lines(assistant("a1", [use("x".repeat(250)), ...names]), result({ permission_denials: [...many, bash("A=1"), { tool_name: "W".repeat(300) }] })),
      lines(assistant("a1", [use("Read")])),
    ]) {
      const t = tele(stream, RUN);
      const full = { ...t, runId: "r", profile: "read-only", profileHash: "f".repeat(64), undeclaredRules: 0, redactions: 0 };
      expect(RunTelemetry.safeParse(full).success, JSON.stringify(RunTelemetry.safeParse(full).error?.issues)).toBe(true);
    }
  });
});
