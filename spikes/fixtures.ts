// Extract curated, sanitized fixtures from spike output into test/fixtures/claude/.
// Usage: node spikes/fixtures.ts <claude-version-of-print-and-interactive> <claude-version-of-background>

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { OUT, ROOT } from "./lib.ts";

const [vMain = "unknown", vBg = vMain] = process.argv.slice(2);
const DEST = join(ROOT, "test", "fixtures", "claude");
const tmpRoot = process.env.MESH_SPIKE_TMP ?? tmpdir();

function sanitize<T>(value: T): T {
  let s = JSON.stringify(value);
  const swaps: [string, string][] = [
    [join(tmpRoot, "mesh-spike"), "/work"],
    [tmpRoot.replace(/^\/private/, ""), "/tmp"],
    [homedir(), "/home/dev"],
    ["/private/tmp/claude-501", "/tmp/claude-1000"],
  ];
  for (const [from, to] of swaps) s = s.split(from).join(to);
  // Claude project dir names encode the cwd with dashes; normalise them too.
  s = s.replace(/-private-var-folders-[A-Za-z0-9-]+?-mesh-spike-/g, "-work-");
  s = s.replace(/"CLAUDE_CODE_MESSAGING_TOKEN":"[0-9a-f]+"/g, '"CLAUDE_CODE_MESSAGING_TOKEN":"<redacted>"');
  return JSON.parse(s) as T;
}

interface Rec {
  path: string;
  claudePid?: number;
  body: Record<string, unknown>;
}

function events(spike: string): Rec[] {
  const f = join(OUT, spike, "events.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Rec);
}

function variant(r: Rec): string {
  const b = r.body;
  const event = String(b.hook_event_name ?? r.path);
  const sub = b.source ?? b.reason ?? b.notification_type ?? (event === "Stop" ? (b.stop_hook_active ? "continued" : "first") : undefined);
  return sub === undefined ? event : `${event}.${String(sub)}`;
}

rmSync(DEST, { recursive: true, force: true });
mkdirSync(join(DEST, "hooks"), { recursive: true });
mkdirSync(join(DEST, "agents"), { recursive: true });

const written: string[] = [];
for (const [spike, mode, version] of [
  ["interactive", "interactive", vMain],
  ["print", "print", vMain],
  ["background", "background", vBg],
] as const) {
  const seen = new Set<string>();
  for (const r of events(spike)) {
    if (!r.body.hook_event_name) continue;
    const name = `${mode}.${variant(r)}`;
    if (seen.has(name)) continue;
    seen.add(name);
    const fixture = sanitize({ claudeCodeVersion: version, mode, claudePidHeaderPresent: r.claudePid !== undefined, input: r.body });
    if (typeof fixture.input.prompt === "string") fixture.input.prompt = "<prompt text>";
    writeFileSync(join(DEST, "hooks", `${name}.json`), JSON.stringify(fixture, null, 2) + "\n");
    written.push(`hooks/${name}.json`);
  }
}

// agents --json samples: one per distinct (kind, status, state, waitingFor).
for (const [spike, version] of [
  ["interactive", vMain],
  ["background", vBg],
] as const) {
  const f = join(OUT, spike, "agents.json");
  if (!existsSync(f)) continue;
  const log = JSON.parse(readFileSync(f, "utf8")) as { agents?: unknown; all?: unknown }[];
  const seen = new Set<string>();
  for (const entry of log) {
    const list = (entry.agents ?? entry.all) as Record<string, unknown>[] | undefined;
    if (!Array.isArray(list)) continue;
    for (const a of list) {
      const key = [a.kind, a.status ?? "noproc", a.state ?? "-", a.waitingFor ?? "-"].join(".").replace(/\s+/g, "-");
      if (seen.has(key)) continue;
      seen.add(key);
      const fixture = sanitize({ claudeCodeVersion: version, entry: a });
      writeFileSync(join(DEST, "agents", `${key}.json`), JSON.stringify(fixture, null, 2) + "\n");
      written.push(`agents/${key}.json`);
    }
  }
}

process.stdout.write(written.sort().join("\n") + "\n");
