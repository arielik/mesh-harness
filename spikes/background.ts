// Spike C (background sessions): S4 dispatch with --bg from a non-TTY process, agents --json for
// background sessions, delivery with `claude --resume <id> --bg "<msg>"`, and cleanup.
// Uses the folder trusted by the interactive spike (run it first).

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODEL, Recorder, claudeAgents, hookSettings, note, outdir, sh, sleep } from "./lib.ts";

type Agent = { id?: string; sessionId?: string; state?: string; status?: string; waitingFor?: string; kind?: string; name?: string; pid?: number };

export async function runBackground(): Promise<void> {
  const out = outdir("background");
  const dir = join(process.env.MESH_SPIKE_TMP ?? "/tmp", "mesh-spike", "interactive");
  if (!existsSync(dir)) throw new Error(`run the interactive spike first (needs trusted folder ${dir})`);
  const log = join(out, "results.md");
  const rec = new Recorder(join(out, "events.jsonl"));
  await rec.start();
  const settingsFile = join(out, "settings.json");
  writeFileSync(settingsFile, JSON.stringify(hookSettings(rec.port), null, 2));
  const agentsLog: unknown[] = [];
  const find = async (pred: (a: Agent) => boolean, label: string) => {
    const all = (await claudeAgents()) as Agent[];
    agentsLog.push({ t: Date.now(), label, all });
    writeFileSync(join(out, "agents.json"), JSON.stringify(agentsLog, null, 2));
    return Array.isArray(all) ? all.find(pred) : undefined;
  };
  const created: string[] = [];

  try {
    note(log, "## S4 dispatch with --bg (non-TTY)");
    const t0 = Date.now();
    const d = await sh(
      "claude",
      ["--bg", "--name", "mesh-spike-bg", "--model", MODEL, "--permission-mode", "default", "--settings", settingsFile, "Reply with exactly the word: BGHELLO"],
      { cwd: dir, timeoutMs: 60_000 },
    );
    note(log, `exit=${d.code} ms=${Date.now() - t0}\nstdout=${JSON.stringify(d.stdout)}\nstderr=${JSON.stringify(d.stderr.slice(0, 500))}`);
    const shortId = /backgrounded · ([0-9a-f]{6,})/.exec(d.stdout)?.[1];
    note(log, `short id: ${shortId}`);
    if (!shortId) throw new Error("no short id");
    created.push(shortId);

    let entry: Agent | undefined;
    const states: string[] = [];
    for (let i = 0; i < 90; i++) {
      entry = await find((a) => a.id === shortId, "bg-poll");
      const s = `${entry?.state}/${entry?.status ?? "-"}/${entry?.waitingFor ?? "-"}`;
      if (states.at(-1) !== s) states.push(s);
      if (entry?.state === "done" || entry?.state === "failed") break;
      await sleep(1000);
    }
    note(log, `state transitions: ${states.join(" → ")}`);
    note(log, `entry: ${JSON.stringify(entry)}`);
    const stop1 = await rec.waitFor((e) => e.path === "/hook/stop", 30_000, "bg Stop").catch(() => null);
    note(log, `hooks from --settings fired in bg session: ${rec.events.length > 0}; paths=${JSON.stringify(rec.events.map((e) => e.path))}`);
    note(log, `bg Stop last_assistant_message=${JSON.stringify(stop1?.body.last_assistant_message)} session_id=${JSON.stringify(stop1?.body.session_id)}`);
    const sessionId = entry?.sessionId ?? String(stop1?.body.session_id ?? "");

    note(log, "\n## S4 deliver with claude --resume <sessionId> --bg (session idle/done)");
    const t1 = Date.now();
    const r = await sh("claude", ["--resume", sessionId, "--bg", "Reply with exactly the word: PONG"], { cwd: dir, timeoutMs: 60_000 });
    note(log, `exit=${r.code}\nstdout=${JSON.stringify(r.stdout)}\nstderr=${JSON.stringify(r.stderr.slice(0, 500))}`);
    const newShort = /backgrounded · ([0-9a-f]{6,})/.exec(r.stdout)?.[1];
    if (newShort && !created.includes(newShort)) created.push(newShort);
    note(log, `same short id as before: ${newShort === shortId} (new=${newShort})`);
    const stop2 = await rec.waitFor((e) => e.path === "/hook/stop" && e.t > t1, 90_000, "Stop after resume --bg").catch(() => null);
    note(log, `Stop after resume: message=${JSON.stringify(stop2?.body.last_assistant_message)} session_id=${JSON.stringify(stop2?.body.session_id)} same session: ${stop2?.body.session_id === sessionId}`);
    const prompt2 = rec.events.find((e) => e.path === "/hook/prompt" && e.t > t1);
    note(log, `UserPromptSubmit after resume: ${JSON.stringify(prompt2 ? { prompt: prompt2.body.prompt, sid: prompt2.body.session_id } : null)}`);
    await sleep(1500);
    note(log, `agents after resume: ${JSON.stringify(await find((a) => a.id === (newShort ?? shortId), "after-resume"))}`);

    note(log, "\n## S4b stop the idle original first, then claude --resume <sessionId> --bg");
    await sh("claude", ["stop", shortId], { timeoutMs: 30_000 });
    await sleep(2000);
    note(log, `original after stop: ${JSON.stringify(await find((a) => a.id === shortId, "after-stop"))}`);
    const t2 = Date.now();
    const r2 = await sh("claude", ["--resume", sessionId, "--bg", "Reply with exactly the word: INPLACE"], { cwd: dir, timeoutMs: 60_000 });
    note(log, `exit=${r2.code}\nstdout=${JSON.stringify(r2.stdout)}\nstderr=${JSON.stringify(r2.stderr.slice(0, 500))}`);
    const short3 = /backgrounded · ([0-9a-f]{6,})/.exec(r2.stdout)?.[1];
    if (short3 && !created.includes(short3)) created.push(short3);
    const stop3 = await rec.waitFor((e) => e.path === "/hook/stop" && e.t > t2, 90_000, "Stop after in-place resume").catch(() => null);
    note(log, `in place: short id same=${short3 === shortId}; Stop message=${JSON.stringify(stop3?.body.last_assistant_message)} session_id same=${stop3?.body.session_id === sessionId}`);
    await sleep(1500);
    note(log, `agents after in-place resume: ${JSON.stringify(await find((a) => a.id === (short3 ?? shortId), "after-inplace"))}`);

    note(log, "\n## claude logs");
    const l = await sh("claude", ["logs", newShort ?? shortId], { timeoutMs: 30_000 });
    note(log, `exit=${l.code} bytes=${l.stdout.length} (raw terminal output with ANSI escapes; not a structured interface)`);
  } finally {
    for (const id of created) {
      await sh("claude", ["stop", id], { timeoutMs: 30_000 });
      const rm = await sh("claude", ["rm", id], { timeoutMs: 30_000 });
      note(log, `cleanup ${id}: rm exit=${rm.code} ${rm.stderr.trim().slice(0, 200)}`);
    }
    await rec.stop();
  }
}
