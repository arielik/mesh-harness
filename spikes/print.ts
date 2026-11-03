// Spike A (claude -p): S1 Stop additionalContext and timeouts; hook payloads in print mode.

import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { MODEL, Recorder, claudePrint, hookSettings, note, outdir, workdir } from "./lib.ts";

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const addr = s.address();
  await new Promise<void>((ok) => s.close(() => ok()));
  if (addr === null || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

export async function runPrint(): Promise<void> {
  const out = outdir("print");
  const dir = workdir("print");
  const log = join(out, "results.md");
  const rec = new Recorder(join(out, "events.jsonl"));
  await rec.start();

  const settingsFile = join(out, "settings.json");
  writeFileSync(settingsFile, JSON.stringify(hookSettings(rec.port, { envDumpFile: join(out, "env-hook.txt") }), null, 2));
  const base = ["--model", MODEL, "--settings", settingsFile, "--strict-mcp-config"];

  // 1. Baseline: no Stop reply.
  rec.stopReply = () => ({});
  const r1 = await claudePrint([...base, "Reply with exactly the word: FIRST"], dir);
  note(log, `## A1 baseline\nexit=${r1.code} ms=${r1.ms} stdout=${JSON.stringify(r1.stdout.trim())}`);
  await new Promise((ok) => setTimeout(ok, 1500));
  note(log, `hook paths seen: ${JSON.stringify(rec.events.map((e) => e.path))}`);

  // 2. Stop returns additionalContext once (when stop_hook_active is false).
  rec.events.length = 0;
  let replies = 0;
  rec.stopReply = (body) => {
    if (body.stop_hook_active === true) return {};
    replies++;
    return {
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: "MESH MESSAGE: now reply with exactly the word SECOND and nothing else.",
      },
    };
  };
  const r2 = await claudePrint([...base, "Reply with exactly the word: FIRST"], dir);
  await new Promise((ok) => setTimeout(ok, 1500));
  const stops = rec.of("/hook/stop").map((e) => ({
    stop_hook_active: e.body.stop_hook_active,
    last_assistant_message: e.body.last_assistant_message,
  }));
  note(log, `\n## A2 Stop additionalContext\nexit=${r2.code} ms=${r2.ms} stdout=${JSON.stringify(r2.stdout.trim())} replies=${replies}`);
  note(log, `stops=${JSON.stringify(stops)}`);

  // 3. Stop returns decision:block once, for comparison.
  rec.events.length = 0;
  rec.stopReply = (body) =>
    body.stop_hook_active === true ? {} : { decision: "block", reason: "MESH MESSAGE: now reply with exactly the word THIRD." };
  const r3 = await claudePrint([...base, "Reply with exactly the word: FIRST"], dir);
  await new Promise((ok) => setTimeout(ok, 1500));
  note(log, `\n## A3 Stop decision:block\nexit=${r3.code} ms=${r3.ms} stdout=${JSON.stringify(r3.stdout.trim())}`);
  note(log, `stops=${JSON.stringify(rec.of("/hook/stop").map((e) => [e.body.stop_hook_active, e.body.last_assistant_message]))}`);

  // 4. Daemon down: all hook URLs point at a closed port.
  const dead = await freePort();
  const deadSettings = join(out, "settings-dead.json");
  writeFileSync(deadSettings, JSON.stringify(hookSettings(dead), null, 2));
  const r4 = await claudePrint(["--model", MODEL, "--settings", deadSettings, "--strict-mcp-config", "Reply with exactly the word: OK"], dir);
  note(log, `\n## A4 daemon down (closed port)\nexit=${r4.code} ms=${r4.ms} stdout=${JSON.stringify(r4.stdout.trim())} stderr=${JSON.stringify(r4.stderr.trim().slice(0, 400))}`);

  // 5. Daemon hung: Stop handler sleeps 10 s (timeout is 3 s).
  rec.events.length = 0;
  rec.stopReply = async () => {
    await new Promise((ok) => setTimeout(ok, 10_000));
    return {};
  };
  const r5 = await claudePrint([...base, "Reply with exactly the word: OK"], dir);
  note(log, `\n## A5 daemon hung on Stop (10 s, timeout 3 s)\nexit=${r5.code} ms=${r5.ms} stdout=${JSON.stringify(r5.stdout.trim())} stderr=${JSON.stringify(r5.stderr.trim().slice(0, 400))}`);

  // Payload fixtures (from A1/A2 runs are in events.jsonl).
  await rec.stop();
  note(log, `\nevents file: ${join(out, "events.jsonl")}`);
}
