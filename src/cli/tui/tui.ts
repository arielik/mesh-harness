// The `mesh` terminal UI: a live list of your Claude sessions with jump and say (plan §9).
// Plain ANSI in raw mode; it never shows transcripts.

import { spawn } from "node:child_process";
import { attachCommand } from "../../claude/index.ts";
import { jumpToPane, serverFromEnv } from "../../mux/index.ts";
import type { FleetView, Session, SessionsResponse } from "../../protocol/index.ts";
import type { DaemonClient, DaemonStatus } from "../client.ts";
import { MACHINES_FOOTER, ordered, render, renderGoals, renderMachines, type GoalRow } from "./render.ts";

const ALT_ON = "\x1b[?1049h\x1b[?25l";
const ALT_OFF = "\x1b[?25h\x1b[?1049l";

export interface JumpResult {
  ok: boolean;
  message: string;
}

/** Bring a session to the front: switch tmux to its pane, or attach a background session. */
export async function jump(s: Session, env: Record<string, string | undefined>, beforeAttach?: () => void, afterAttach?: () => void): Promise<JumpResult> {
  if (s.kind === "background" && s.bgId) {
    beforeAttach?.();
    const [cmd, ...args] = attachCommand(s.bgId);
    await new Promise<void>((resolve) => {
      const child = spawn(cmd as string, args, { stdio: "inherit" });
      child.on("close", () => resolve());
      child.on("error", () => resolve());
    });
    afterAttach?.();
    return { ok: true, message: `back from ${s.bgId}` };
  }
  if (!s.pane) return { ok: false, message: "this session isn't in tmux; switch to its terminal yourself" };
  const mine = serverFromEnv(env.TMUX);
  if (!mine) {
    const server = s.tmuxSocket ? `-S ${s.tmuxSocket} ` : "";
    return { ok: false, message: `not inside tmux; run: tmux ${server}attach \\; switch-client -t ${s.pane}` };
  }
  if (s.tmuxSocket && mine.socketPath && s.tmuxSocket !== mine.socketPath) {
    return { ok: false, message: `that session runs on another tmux server (${s.tmuxSocket})` };
  }
  const ok = await jumpToPane(s.pane, mine);
  return { ok, message: ok ? "" : `could not switch to ${s.pane}` };
}

/** The hub's state for the TUI header: Solo, offline (working locally), or nothing when all is well. */
export function hubLabel(st: DaemonStatus): string {
  if (st.mode === "solo") return " · solo (local hub)";
  if (st.hub === "offline") {
    const since = st.offlineSince ? ` since ${new Date(st.offlineSince).toISOString().slice(11, 16)} UTC` : "";
    const queued = (st.queued ?? 0) + st.outbox;
    return ` · hub offline${since}, working locally${queued ? ` (${queued} waiting)` : ""}`;
  }
  if (st.hub === "auth-failed") return " · hub login expired (mesh login)";
  return "";
}

export async function runTui(client: DaemonClient, opts: { header: string; env: Record<string, string | undefined> }): Promise<number> {
  const out = process.stdout;
  const input = process.stdin;
  if (!input.isTTY || !out.isTTY) throw new Error("the mesh TUI needs a terminal; use `mesh ls` instead");

  let data: SessionsResponse = { sessions: [], messages: [] };
  let selected: string | undefined;
  let status: string | undefined = undefined;
  let prompt: { label: string; value: string; target: string } | undefined;
  let paused = false;
  let goals: GoalRow[] | undefined;
  /** MM-1: the My machines panel (`m`) is open; `fleet` is its data, refreshed every 5 s. */
  let machines = false;
  let fleet: FleetView | undefined;
  let fleetTimer: NodeJS.Timeout | undefined;
  let stopped = false;
  let hubTag = "";
  let ticks = 0;

  const draw = () => {
    if (paused || stopped) return;
    if (machines) {
      const v = { width: out.columns ?? 100, height: out.rows ?? 30, header: opts.header + hubTag, status };
      const lines = fleet ? renderMachines(fleet, v) : [v.header, "", "MY MACHINES", "  loading…", ...(status ? [status] : []), MACHINES_FOOTER];
      out.write(`\x1b[H${lines.map((l) => `${l}\x1b[K`).join("\n")}\x1b[J`);
      return;
    }
    if (goals) {
      const lines = renderGoals(goals, { width: out.columns ?? 100, height: out.rows ?? 30, header: opts.header + hubTag, status });
      out.write(`\x1b[H${lines.map((l) => `${l}\x1b[K`).join("\n")}\x1b[J`);
      return;
    }
    const list = ordered(data.sessions);
    if (!list.some((s) => s.sid === selected)) selected = list[0]?.sid;
    const lines = render({
      sessions: data.sessions,
      messages: data.messages,
      selected,
      now: Date.now(),
      width: out.columns ?? 100,
      height: out.rows ?? 30,
      header: opts.header + hubTag,
      status,
      input: prompt ? { label: prompt.label, value: prompt.value } : undefined,
      color: true,
    });
    out.write(`\x1b[H${lines.map((l) => `${l}\x1b[K`).join("\n")}\x1b[J`);
  };

  const refresh = async (reconcile = false) => {
    try {
      data = reconcile ? await client.reconcile() : await client.sessions();
      if (ticks++ % 5 === 0) hubTag = hubLabel(await client.status());
      if (status?.startsWith("daemon")) status = undefined;
    } catch (e) {
      status = `daemon: ${e instanceof Error ? e.message : String(e)}`;
    }
    draw();
  };

  const enter = () => {
    input.setRawMode(true);
    input.resume();
    out.write(ALT_ON);
    paused = false;
    draw();
  };
  const leave = () => {
    paused = true;
    out.write(ALT_OFF);
    input.setRawMode(false);
  };

  const move = (delta: number) => {
    const list = ordered(data.sessions);
    if (list.length === 0) return;
    const i = Math.max(0, list.findIndex((s) => s.sid === selected));
    selected = list[Math.min(list.length - 1, Math.max(0, i + delta))]?.sid;
    draw();
  };

  const current = () => data.sessions.find((s) => s.sid === selected);

  const loadFleet = async () => {
    try {
      fleet = await client.fleet();
      status = undefined;
    } catch (e) {
      status = e instanceof Error ? e.message : String(e);
    }
    draw();
  };
  const closeMachines = () => {
    machines = false;
    fleet = undefined;
    if (fleetTimer) clearInterval(fleetTimer);
    fleetTimer = undefined;
  };

  return new Promise<number>((resolve) => {
    const timer = setInterval(() => void refresh(), 1_000);
    const onResize = () => draw();
    const quit = () => {
      stopped = true;
      clearInterval(timer);
      if (fleetTimer) clearInterval(fleetTimer);
      out.off("resize", onResize);
      input.off("data", onData);
      leave();
      input.pause();
      resolve(0);
    };

    const onData = (b: Buffer) => void onKey(b);
    const onKey = async (buf: Buffer) => {
      const key = buf.toString("utf8");
      if (prompt) {
        if (key === "\r") {
          const p = prompt;
          prompt = undefined;
          if (p.value.trim()) {
            try {
              const r = await client.say(p.target, p.value.trim());
              status = `message ${r.message.state === "delivered" ? "delivered" : "queued"} for ${p.label.replace(/^say to |: $/g, "")}`;
            } catch (e) {
              status = e instanceof Error ? e.message : String(e);
            }
          }
          await refresh();
        } else if (key === "\x1b" || key === "\x03") {
          prompt = undefined;
          draw();
        } else if (key === "\x7f" || key === "\b") {
          prompt.value = prompt.value.slice(0, -1);
          draw();
        } else if (!key.startsWith("\x1b") && key >= " ") {
          prompt.value += key;
          draw();
        }
        return;
      }
      if (key === "q" || key === "\x03") return quit();
      if (key === "m") {
        if (machines) {
          closeMachines();
          return draw();
        }
        goals = undefined;
        machines = true;
        draw();
        await loadFleet();
        if (machines && !fleetTimer) fleetTimer = setInterval(() => void (machines ? loadFleet() : undefined), 5_000);
        return;
      }
      if (key === "g") {
        if (machines) closeMachines();
        if (goals) goals = undefined;
        else {
          try {
            goals = await client.goals();
            status = undefined;
          } catch (e) {
            status = e instanceof Error ? e.message : String(e);
          }
        }
        return draw();
      }
      if (goals || machines) return;
      if (key === "\x1b[A" || key === "k") return move(-1);
      if (key === "\x1b[B" || key === "j") return move(1);
      if (key === "r") {
        status = "refreshing…";
        return void refresh(true);
      }
      const s = current();
      if (!s) return;
      if (key === "\r") {
        const r = await jump(s, opts.env, leave, enter);
        status = r.message || undefined;
        draw();
      } else if (key === "a") {
        const order = ["nudge", "chain", "off"] as const;
        const cur = s.autopilot ?? "nudge";
        const next = order[(order.indexOf(cur) + 1) % order.length] as "off" | "nudge" | "chain";
        try {
          await client.autopilot(s.sid, next);
          status = `autopilot ${next} for ${s.name ?? s.repo?.name ?? s.sid.slice(0, 8)}`;
        } catch (e) {
          status = e instanceof Error ? e.message : String(e);
        }
        await refresh();
      } else if (key === "n") {
        status = "looking for a ready step…";
        draw();
        try {
          status = (await client.next(s.sid)).message;
        } catch (e) {
          status = e instanceof Error ? e.message : String(e);
        }
        await refresh();
      } else if (key === "s") {
        prompt = { label: `say to ${s.name ?? s.repo?.name ?? s.sid.slice(0, 8)}: `, value: "", target: s.sid };
        draw();
      }
    };

    input.on("data", onData);
    out.on("resize", onResize);
    enter();
    void refresh(true);
  });
}
