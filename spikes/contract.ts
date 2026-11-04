// pnpm test:claude (M4, 4.3 / T6): re-check, against the installed Claude Code, every behaviour
// mesh relies on. Fails (non-zero) when Claude Code changed under us. Uses haiku on your
// subscription; never changes ~/.claude settings (hooks come in with --settings), and removes the
// session history of its scratch folder afterwards.
//
//   hooks:     SessionStart.model · Stop.effort/permission_mode · SubagentStart/Stop (id, type, transcript)
//   files:     workflow journal (label, phase, typed result) · agent meta (model) · run json (timing)
//   backfill:  scanWorkflowRuns finds every agent with its cwd
//   status:    `claude agents --json` still answers

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { agentPaths, compareVersions, claudeVersion, MIN_CLAUDE_VERSION, readAgentFiles, scanWorkflowRuns } from "../src/claude/index.ts";
import { parseLabel } from "../src/core/index.ts";
import { MODEL, Recorder, claudeAgents, claudePrint, forgetProject, hookSettings, note, outdir, sh, sleep, workdir, writeProgramme } from "./lib.ts";

export async function runContract(): Promise<void> {
  const out = outdir("contract");
  const dir = workdir("contract");
  const log = join(out, "results.md");
  const failures: string[] = [];
  const check = (label: string, ok: boolean, detail = "") => {
    note(log, `${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures.push(label);
  };

  const version = await claudeVersion();
  check(`Claude Code version ${version ?? "?"} ≥ ${MIN_CLAUDE_VERSION}`, !!version && compareVersions(version, MIN_CLAUDE_VERSION) >= 0);

  await sh("git", ["init", "-q"], { cwd: dir });
  writeProgramme(dir, "CT-1");
  const rec = new Recorder(join(out, "hooks.jsonl"));
  await rec.start();
  const settings = join(out, "settings.json");
  writeFileSync(settings, JSON.stringify(hookSettings(rec.port), null, 2));
  const since = Date.now() - 60_000;
  try {
    const r = await claudePrint(
      ["--model", MODEL, "--settings", settings, "--strict-mcp-config", "--allowedTools", "Workflow", "--output-format", "text", "Run the workflow script ./programme.js with the Workflow tool, wait for it to finish, then reply with the single word DONE."],
      dir,
      600_000,
    );
    check("claude -p ran a workflow programme", r.code === 0, `exit ${r.code}, ${Math.round(r.ms / 1000)} s`);
    await sleep(3_000);

    const start = rec.of("/hook/session-start")[0]?.body;
    // Print mode never sent the model on SessionStart (M0 fixture print.SessionStart.startup.json);
    // interactive and background sessions do. Subagents' models come from the workflow files.
    check("SessionStart fires (print mode: no model field, as recorded in M0)", start !== undefined, start?.model ? `model ${String(start.model)}` : "no model (print mode)");
    const stop = rec.of("/hook/stop").at(-1)?.body;
    check("Stop carries permission_mode", typeof stop?.permission_mode === "string", String(stop?.permission_mode));
    check("Stop carries effort.level (optional)", true, JSON.stringify(stop?.effort ?? "absent"));
    const starts = rec.of("/hook/subagent-start").map((e) => e.body);
    const stops = rec.of("/hook/subagent-stop").map((e) => e.body);
    check("SubagentStart fires per agent() call with agent_id and agent_type", starts.length === 5 && starts.every((b) => typeof b.agent_id === "string" && typeof b.agent_type === "string"), `${starts.length} starts: ${starts.map((b) => b.agent_type).join(", ")}`);
    check("SubagentStop fires with agent_transcript_path", stops.length === 5 && stops.every((b) => typeof b.agent_transcript_path === "string"), `${stops.length} stops`);

    let typed = 0;
    for (const b of stops) {
      const id = String(b.agent_id);
      const path = String(b.agent_transcript_path);
      const f = readAgentFiles(path, id);
      const p = parseLabel(f.label, f.roleFromMeta);
      const ok = !!p && p.key === "CT-1" && !!f.model && !!f.workflowRun && f.startedAt !== undefined && f.durationMs !== undefined;
      if (f.result && typeof f.result === "object") typed++;
      check(`files for ${String(b.agent_type)}: label, model, run, timing`, ok, `${f.label} · ${f.model} · ${f.workflowRun} · ${f.durationMs} ms · paths ${JSON.stringify(agentPaths(path, id))}`);
    }
    check("the journal holds each agent's typed result", typed === 5, `${typed}/5 typed results`);

    const runs = scanWorkflowRuns(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), since).filter((x) => parseLabel(x.label)?.key === "CT-1");
    check("backfill scan finds every agent with its cwd", runs.length === 5 && runs.every((x) => x.cwd.endsWith("contract")), `${runs.length} agents, cwd ${runs[0]?.cwd ?? "?"}`);

    const agents = await claudeAgents();
    check("claude agents --json answers", Array.isArray(agents) || (typeof agents === "object" && agents !== null && !("error" in agents)), JSON.stringify(agents).slice(0, 120));
  } finally {
    await rec.stop();
    forgetProject(dir);
  }
  note(log, failures.length ? `\n${failures.length} check(s) failed: Claude Code changed something mesh relies on.` : "\nAll checks passed.");
  if (failures.length) {
    process.exitCode = 1;
    throw new Error(`contract: ${failures.length} check(s) failed: ${failures.join("; ")}`);
  }
}
