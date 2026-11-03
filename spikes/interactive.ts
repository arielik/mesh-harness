// Spike B (interactive claude in a dedicated tmux server):
// S2/S3 hook payloads, S6 pid binding, S7 agents --json for interactive sessions,
// S8 bracketed paste vs an open permission dialog, S9 session ids across /clear, /compact, --resume,
// and S1 (Stop additionalContext) in an interactive session.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MODEL,
  Recorder,
  capture,
  claudeAgents,
  hookSettings,
  note,
  outdir,
  panePid,
  paste,
  q,
  sleep,
  tmux,
  typeLine,
  waitScreen,
  workdir,
  writeMcpShim,
} from "./lib.ts";

const T = "s:0";

export async function runInteractive(): Promise<void> {
  const out = outdir("interactive");
  const dir = workdir("interactive");
  const log = join(out, "results.md");
  const rec = new Recorder(join(out, "events.jsonl"));
  await rec.start();
  const agentsLog: unknown[] = [];
  const snap = async (label: string) => {
    const a = await claudeAgents();
    agentsLog.push({ t: Date.now(), label, agents: a });
    writeFileSync(join(out, "agents.json"), JSON.stringify(agentsLog, null, 2));
    return a;
  };
  const screens: Record<string, string> = {};
  const shot = async (label: string) => {
    screens[label] = await capture(T);
    writeFileSync(join(out, "screens.json"), JSON.stringify(screens, null, 2));
  };

  type Agent = { pid: number; status?: string; waitingFor?: string; sessionId?: string };
  const findAgent = async (pid: number): Promise<Agent | undefined> => {
    const a = (await claudeAgents()) as Agent[];
    return Array.isArray(a) ? a.find((x) => x.pid === pid) : undefined;
  };
  /** Wait until the session's prompt is ready; dismiss startup notices (dialog open) with Escape. */
  const waitReady = async (pid: number, label: string) => {
    const t0 = Date.now();
    let dialogSince = 0;
    for (;;) {
      const a = await findAgent(pid);
      if (a?.status === "idle") return;
      if (a?.waitingFor === "dialog open") {
        dialogSince ||= Date.now();
        if (Date.now() - dialogSince > 3000) {
          await shot(`dialog-${label}-${Date.now() - t0}`);
          note(log, `(${label}) dismissing an open dialog with Escape`);
          await tmux("send-keys", "-t", T, "Escape");
          dialogSince = 0;
        }
      }
      if (Date.now() - t0 > 60_000) throw new Error(`session not ready (${label}): ${JSON.stringify(a)}`);
      await sleep(700);
    }
  };

  const settingsFile = join(out, "settings.json");
  writeFileSync(settingsFile, JSON.stringify(hookSettings(rec.port, { envDumpFile: join(out, "env-hook.txt") }), null, 2));
  const mcpLog = join(out, "mcp.jsonl");
  const shim = writeMcpShim(out, mcpLog);
  const mcpFile = join(out, "mcp.json");
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: { meshspike: { type: "stdio", command: "node", args: [shim] } } }));
  const claudeCmd = (extra: string) =>
    `claude --model ${MODEL} --permission-mode default --settings ${q(settingsFile)} --strict-mcp-config --mcp-config ${q(mcpFile)} ${extra}`;

  await tmux("kill-server");
  await tmux("new-session", "-d", "-s", "s", "-x", "200", "-y", "50", "-c", dir, claudeCmd(""));

  try {
    // Trust dialog for a fresh folder.
    const first = await waitScreen(T, /trust this folder|for shortcuts|\? for/i, 45_000, "trust or prompt");
    await shot("startup");
    if (/trust/i.test(first)) {
      note(log, "trust dialog shown for new folder (default option is 'No, exit'); selecting 'Yes' with Down+Enter");
      await sleep(1000);
      await tmux("send-keys", "-t", T, "Down");
      await sleep(500);
      await tmux("send-keys", "-t", T, "Enter");
      note(log, `SessionStart events before trust accepted: ${rec.of("/hook/session-start").length}`);
    }
    const start = await rec.waitFor((e) => e.path === "/hook/session-start", 45_000, "SessionStart");
    await sleep(2000);
    const pane = await panePid(T);
    const mcpStart = existsSync(mcpLog) ? readFileSync(mcpLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    note(log, `## S6 pid binding`);
    note(log, `pane_pid=${pane} hook X-Claude-Pid=${start.claudePid} sh=${start.shPid}`);
    note(log, `env-hook.txt:\n${existsSync(join(out, "env-hook.txt")) ? readFileSync(join(out, "env-hook.txt"), "utf8") : "(missing)"}`);
    note(log, `mcp shim start: ${JSON.stringify(mcpStart.find((m) => m.event === "start"))}`);
    const sid1 = String(start.body.session_id);
    note(log, `session_id=${sid1} source=${String(start.body.source)}`);
    await snap("after-start");
    await waitReady(pane, "startup");
    await snap("ready");

    // Turn 1: simple reply; sample agents --json while busy.
    note(log, `\n## Turn 1 (simple)`);
    await typeLine(T, "Reply with exactly the word: READY");
    let busySeen: unknown = null;
    for (let i = 0; i < 20 && rec.of("/hook/stop").length === 0; i++) {
      const a = await snap(`turn1-poll-${i}`);
      if (!busySeen) busySeen = a;
      await sleep(400);
    }
    await rec.waitFor((e) => e.path === "/hook/stop", 60_000, "Stop turn1");
    note(log, `first agents sample during turn: ${JSON.stringify(busySeen)}`);
    await sleep(1000);
    note(log, `agents after turn1: ${JSON.stringify(await snap("after-turn1"))}`);

    // Turn 2: permission dialog (S2 permission_prompt, S7 waitingFor, S8 paste guard).
    note(log, `\n## Turn 2 (permission dialog)`);
    const notifBefore = rec.of("/hook/notification").length;
    await waitReady(pane, "turn2");
    await typeLine(T, "Use the Bash tool to run exactly this command: touch spike-marker.txt  (do not ask me, just run it)");
    await waitScreen(T, /Do you want|proceed|Yes, and|❯ 1\./i, 60_000, "permission dialog");
    await shot("permission-dialog");
    const t0 = Date.now();
    const samples: unknown[] = [];
    while (Date.now() - t0 < 14_000) {
      samples.push({ dt: Date.now() - t0, agents: await snap("permission-poll") });
      if (rec.of("/hook/notification").length > notifBefore) break;
      await sleep(1000);
    }
    const notif = rec.of("/hook/notification").slice(notifBefore);
    note(log, `notifications during dialog: ${JSON.stringify(notif.map((n) => ({ dt: n.t - t0, body: n.body })))}`);
    note(log, `agents samples during dialog: ${JSON.stringify(samples.slice(-2))}`);

    note(log, `\n## S8 bracketed paste into an open permission dialog (no Enter)`);
    await paste(T, "hello from mesh", false);
    await sleep(1500);
    await shot("permission-dialog-after-paste");
    note(log, `screen after paste (tail):\n${screens["permission-dialog-after-paste"]?.split("\n").filter((l) => l.trim()).slice(-14).join("\n")}`);
    const markerAfterPaste = existsSync(join(dir, "spike-marker.txt"));
    note(log, `marker file exists after paste: ${markerAfterPaste}`);
    // Approve properly so the turn finishes: option 1.
    await tmux("send-keys", "-t", T, "Escape");
    await sleep(1500);
    await shot("after-escape");
    note(log, `screen after Escape (tail):\n${screens["after-escape"]?.split("\n").filter((l) => l.trim()).slice(-8).join("\n")}`);
    await rec.waitFor((e) => e.path === "/hook/stop" && e.t > t0, 60_000, "Stop turn2").catch((e) => note(log, String(e)));
    await sleep(1000);
    note(log, `marker file exists at end of turn 2: ${existsSync(join(dir, "spike-marker.txt"))}`);
    note(log, `agents after turn2: ${JSON.stringify(await snap("after-turn2"))}`);

    // Turn 3: the agent asks a question.
    note(log, `\n## Turn 3 (agent asks a question)`);
    await waitReady(pane, "turn3");
    const t3 = Date.now();
    await typeLine(T, "Ask me one short yes/no question about my favourite colour, then stop and wait for my answer. Do not use any tools.");
    const stop3 = await rec.waitFor((e) => e.path === "/hook/stop" && e.t > t3, 60_000, "Stop turn3").catch(() => null);
    await sleep(1500);
    await shot("question");
    note(log, `last_assistant_message=${JSON.stringify(stop3?.body.last_assistant_message)}`);
    note(log, `agents after question: ${JSON.stringify(await snap("after-question"))}`);
    if (/Esc to cancel|Enter to select|❯ 1\./.test(screens.question ?? "")) {
      note(log, "a question dialog is open; pressing Escape");
      await tmux("send-keys", "-t", T, "Escape");
      await sleep(1500);
    }

    // S1 interactive: Stop additionalContext.
    note(log, `\n## S1 interactive Stop additionalContext`);
    let delivered = false;
    rec.stopReply = (body) => {
      if (delivered || body.stop_hook_active === true) return {};
      delivered = true;
      return { hookSpecificOutput: { hookEventName: "Stop", additionalContext: "MESH MESSAGE: now reply with exactly the word SECOND." } };
    };
    await waitReady(pane, "s1");
    const t4 = Date.now();
    await typeLine(T, "no. Now reply with exactly the word: FIRST");
    await rec.waitFor((e) => e.path === "/hook/stop" && e.t > t4 && e.body.stop_hook_active === true, 60_000, "Stop with stop_hook_active").catch((e) => note(log, String(e)));
    rec.stopReply = () => ({});
    await sleep(1500);
    await shot("s1-interactive");
    note(log, `stops: ${JSON.stringify(rec.of("/hook/stop").filter((e) => e.t > t4).map((e) => [e.body.stop_hook_active, e.body.last_assistant_message]))}`);
    note(log, `screen (tail):\n${screens["s1-interactive"]?.split("\n").filter((l) => l.trim()).slice(-10).join("\n")}`);

    // Paste into an idle prompt with Enter.
    note(log, `\n## S8 bracketed paste into idle prompt (+ Enter)`);
    await waitReady(pane, "paste");
    const t5 = Date.now();
    await paste(T, "Reply with exactly the word: PASTED", true);
    const p5 = await rec.waitFor((e) => e.path === "/hook/prompt" && e.t > t5, 30_000, "prompt after paste").catch(() => null);
    const s5 = await rec.waitFor((e) => e.path === "/hook/stop" && e.t > t5, 60_000, "stop after paste").catch(() => null);
    note(log, `prompt=${JSON.stringify(p5?.body.prompt)} reply=${JSON.stringify(s5?.body.last_assistant_message)}`);

    // idle_prompt notification while detached.
    note(log, `\n## idle_prompt`);
    const t6 = Date.now();
    const idle = await rec
      .waitFor((e) => e.path === "/hook/notification" && e.t > t6, 80_000, "idle notification")
      .catch(() => null);
    note(log, `notification within 80 s of idle: ${JSON.stringify(idle ? { dt: idle.t - t6, body: idle.body } : null)}`);
    note(log, `agents when idle: ${JSON.stringify(await snap("idle"))}`);

    // S9: /clear.
    note(log, `\n## S9 /clear`);
    await waitReady(pane, "clear");
    const t7 = Date.now();
    const mcpStartsBefore = readFileSync(mcpLog, "utf8").split("\n").filter((l) => l.includes('"start"')).length;
    await typeLine(T, "/clear");
    const end7 = await rec.waitFor((e) => e.path === "/hook/session-end" && e.t > t7, 30_000, "SessionEnd clear").catch(() => null);
    const start7 = await rec.waitFor((e) => e.path === "/hook/session-start" && e.t > t7, 30_000, "SessionStart clear").catch(() => null);
    await sleep(1500);
    const mcpStartsAfter = readFileSync(mcpLog, "utf8").split("\n").filter((l) => l.includes('"start"')).length;
    note(log, `end: ${JSON.stringify(end7 && { sid: end7.body.session_id, reason: end7.body.reason, pid: end7.claudePid })}`);
    note(log, `start: ${JSON.stringify(start7 && { sid: start7.body.session_id, source: start7.body.source, pid: start7.claudePid })}`);
    note(log, `mcp shim restarted on /clear: ${mcpStartsAfter > mcpStartsBefore}`);
    note(log, `agents after clear: ${JSON.stringify(await snap("after-clear"))}`);
    const sid2 = String(start7?.body.session_id ?? sid1);

    // S9: /compact (needs some conversation first).
    note(log, `\n## S9 /compact`);
    await waitReady(pane, "compact-pre");
    const t8a = Date.now();
    await typeLine(T, "Reply with exactly the word: AFTERCLEAR");
    await rec.waitFor((e) => e.path === "/hook/stop" && e.t > t8a, 60_000, "Stop afterclear").catch(() => null);
    await waitReady(pane, "compact");
    const t8 = Date.now();
    await typeLine(T, "/compact");
    const start8 = await rec.waitFor((e) => e.path === "/hook/session-start" && e.t > t8, 120_000, "SessionStart compact").catch(() => null);
    await sleep(1500);
    note(log, `compact SessionStart: ${JSON.stringify(start8 && { sid: start8.body.session_id, source: start8.body.source, pid: start8.claudePid })}`);
    note(log, `events since /compact: ${JSON.stringify(rec.events.filter((e) => e.t > t8).map((e) => [e.path, e.body.session_id, e.body.source ?? e.body.reason]))}`);

    // /exit.
    note(log, `\n## /exit`);
    await waitReady(pane, "exit");
    const t9 = Date.now();
    await typeLine(T, "/exit");
    const end9 = await rec.waitFor((e) => e.path === "/hook/session-end" && e.t > t9, 30_000, "SessionEnd exit").catch(() => null);
    note(log, `exit SessionEnd: ${JSON.stringify(end9 && { sid: end9.body.session_id, reason: end9.body.reason })}`);
    await sleep(2000);

    // S9: --resume.
    note(log, `\n## S9 --resume ${sid2}`);
    const t10 = Date.now();
    await tmux("kill-server");
    await tmux("new-session", "-d", "-s", "s", "-x", "200", "-y", "50", "-c", dir, claudeCmd(`--resume ${sid2}`));
    const start10 = await rec.waitFor((e) => e.path === "/hook/session-start" && e.t > t10, 45_000, "SessionStart resume").catch(() => null);
    note(log, `resume SessionStart: ${JSON.stringify(start10 && { sid: start10.body.session_id, source: start10.body.source, pid: start10.claudePid })}`);
    await sleep(2000);
    await shot("resumed");
    await waitReady(await panePid(T), "resumed");
    const t11 = Date.now();
    await typeLine(T, "Reply with exactly the word: RESUMED");
    const p11 = await rec.waitFor((e) => e.path === "/hook/prompt" && e.t > t11, 30_000, "prompt after resume").catch(() => null);
    await rec.waitFor((e) => e.path === "/hook/stop" && e.t > t11, 60_000, "stop after resume").catch(() => null);
    note(log, `first prompt after resume carries session_id=${JSON.stringify(p11?.body.session_id)}`);
    note(log, `agents while resumed: ${JSON.stringify(await snap("resumed"))}`);
    await typeLine(T, "/exit");
    await sleep(3000);
  } finally {
    await shot("final").catch(() => undefined);
    await tmux("kill-server");
    await rec.stop();
  }
}
