// The `mesh` terminal UI: a live list of your Claude sessions with jump and say (plan §9).
// Plain ANSI in raw mode; it never shows transcripts.

import { spawn } from "node:child_process";
import { attachCommand } from "../../claude/index.ts";
import { jumpToPane, serverFromEnv } from "../../mux/index.ts";
import type { Session, SessionsResponse } from "../../protocol/index.ts";
import type { DaemonClient } from "../client.ts";
import { ordered, render } from "./render.ts";

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

export async function runTui(client: DaemonClient, opts: { header: string; env: Record<string, string | undefined> }): Promise<number> {
  const out = process.stdout;
  const input = process.stdin;
  if (!input.isTTY || !out.isTTY) throw new Error("the mesh TUI needs a terminal; use `mesh ls` instead");

  let data: SessionsResponse = { sessions: [], messages: [] };
  let selected: string | undefined;
  let status: string | undefined = undefined;
  let prompt: { label: string; value: string; target: string } | undefined;
  let paused = false;
  let stopped = false;

  const draw = () => {
    if (paused || stopped) return;
    const list = ordered(data.sessions);
    if (!list.some((s) => s.sid === selected)) selected = list[0]?.sid;
    const lines = render({
      sessions: data.sessions,
      messages: data.messages,
      selected,
      now: Date.now(),
      width: out.columns ?? 100,
      height: out.rows ?? 30,
      header: opts.header,
      status,
      input: prompt ? { label: prompt.label, value: prompt.value } : undefined,
      color: true,
    });
    out.write(`\x1b[H${lines.map((l) => `${l}\x1b[K`).join("\n")}\x1b[J`);
  };

  const refresh = async (reconcile = false) => {
    try {
      data = reconcile ? await client.reconcile() : await client.sessions();
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

  return new Promise<number>((resolve) => {
    const timer = setInterval(() => void refresh(), 1_000);
    const onResize = () => draw();
    const quit = () => {
      stopped = true;
      clearInterval(timer);
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
