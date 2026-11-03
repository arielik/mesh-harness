// Spike harness: a hook recorder, tmux driving, and Claude Code launch helpers.
// Spikes are throwaway research code (plan §10, M0). They never touch ~/.claude/settings.json:
// hooks and MCP are injected per session with --settings and --mcp-config.

import { execFile, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const ROOT = resolve(import.meta.dirname, "..");
export const OUT = join(ROOT, "spikes", "out");
export const KEY = "spike-key";
export const MODEL = "haiku";

export interface Recorded {
  t: number;
  path: string;
  claudePid?: number;
  shPid?: number;
  body: Record<string, unknown>;
}

export type StopReply = (body: Record<string, unknown>) => Promise<object> | object;

export class Recorder {
  events: Recorded[] = [];
  stopReply: StopReply = () => ({});
  private server: Server;
  private file: string;
  port = 0;

  constructor(file: string) {
    this.file = file;
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  async start(): Promise<void> {
    await new Promise<void>((ok) => this.server.listen(0, "127.0.0.1", ok));
    const addr = this.server.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    this.port = addr.port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((ok) => this.server.close(() => ok()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body: Record<string, unknown>;
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      body = { _raw: raw };
    }
    const rec: Recorded = { t: Date.now(), path: req.url ?? "", body };
    const cp = req.headers["x-claude-pid"];
    const sp = req.headers["x-sh-pid"];
    if (typeof cp === "string") rec.claudePid = Number(cp);
    if (typeof sp === "string") rec.shPid = Number(sp);
    if (req.headers["x-mesh-key"] !== KEY) (rec.body as Record<string, unknown>)._badKey = true;
    this.events.push(rec);
    appendFileSync(this.file, JSON.stringify(rec) + "\n");
    let reply: object = {};
    if (req.url === "/hook/stop") reply = await this.stopReply(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(reply));
  }

  of(path: string): Recorded[] {
    return this.events.filter((e) => e.path === path);
  }

  async waitFor(pred: (e: Recorded) => boolean, timeoutMs: number, label: string): Promise<Recorded> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
      await sleep(250);
    }
  }
}

export function hookSettings(port: number, opts: { stopUrlPort?: number; envDumpFile?: string } = {}): object {
  const curl = (path: string) => ({
    type: "command",
    async: true,
    command: `curl -s -m 2 -o /dev/null --data-binary @- -H 'Content-Type: application/json' -H 'X-Mesh-Key: ${KEY}' -H "X-Claude-Pid: \${CLAUDE_PID:-$PPID}" -H "X-Sh-Pid: $$" http://127.0.0.1:${port}${path}`,
  });
  const sessionStart: object[] = [curl("/hook/session-start")];
  if (opts.envDumpFile) {
    sessionStart.push({
      type: "command",
      async: true,
      command: `{ echo "PPID=$PPID"; env | grep -E '^(CLAUDE|MESH)' | sort; } > '${opts.envDumpFile}'`,
    });
  }
  return {
    hooks: {
      SessionStart: [{ hooks: sessionStart }],
      UserPromptSubmit: [{ hooks: [curl("/hook/prompt")] }],
      Notification: [{ hooks: [curl("/hook/notification")] }],
      SessionEnd: [{ hooks: [curl("/hook/session-end")] }],
      Stop: [
        {
          hooks: [
            {
              type: "http",
              url: `http://127.0.0.1:${opts.stopUrlPort ?? port}/hook/stop`,
              timeout: 3,
              headers: { "X-Mesh-Key": KEY },
            },
          ],
        },
      ],
    },
  };
}

/** A minimal stdio MCP server that reports its parent pid (spike S6). */
export function writeMcpShim(dir: string, logFile: string): string {
  const file = join(dir, "mcp-shim.mjs");
  writeFileSync(
    file,
    `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const log = (o) => appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ t: Date.now(), ...o }) + "\\n");
const envKeys = Object.keys(process.env).filter((k) => k.startsWith("CLAUDE") || k.startsWith("MESH"));
log({ event: "start", pid: process.pid, ppid: process.ppid, env: Object.fromEntries(envKeys.map((k) => [k, process.env[k]])) });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  log({ event: "rpc", method: m.method, params: m.params });
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "meshspike", version: "0.0.0" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "whoami", description: "Returns the MCP server's parent pid. Call it when asked for mesh whoami.", inputSchema: { type: "object", properties: {} } }] } });
  else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify({ pid: process.pid, ppid: process.ppid }) }] } });
  else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
});
`,
  );
  return file;
}

export function workdir(name: string): string {
  const dir = join(process.env.MESH_SPIKE_TMP ?? tmpdir(), "mesh-spike", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function outdir(name: string): string {
  const dir = join(OUT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function sh(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}) {
  try {
    const r = await exec(cmd, args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 16 << 20 });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof err.code === "number" ? err.code : 1, stdout: err.stdout ?? "", stderr: err.stderr ?? String(e) };
  }
}

/** Run `claude -p` and measure wall time. */
export async function claudePrint(args: string[], cwd: string, timeoutMs = 180_000) {
  const t0 = Date.now();
  const child = spawn("claude", ["-p", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
  const code = await new Promise<number>((ok) => child.on("close", (c) => ok(c ?? -1)));
  clearTimeout(timer);
  return { code, stdout, stderr, ms: Date.now() - t0 };
}

export async function claudeAgents(): Promise<unknown> {
  const r = await sh("claude", ["agents", "--json", "--all"], { timeoutMs: 30_000 });
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { error: r.stderr || r.stdout };
  }
}

// ---------- tmux (dedicated server so spikes never touch the user's tmux) ----------

export const TMUX_SOCKET = "meshspike";

export async function tmux(...args: string[]) {
  return sh("tmux", ["-L", TMUX_SOCKET, ...args]);
}

export async function capture(target: string): Promise<string> {
  return (await tmux("capture-pane", "-p", "-t", target)).stdout;
}

export async function typeLine(target: string, text: string): Promise<void> {
  await tmux("send-keys", "-t", target, "-l", text);
  await sleep(300);
  await tmux("send-keys", "-t", target, "Enter");
}

export async function paste(target: string, text: string, enter: boolean): Promise<void> {
  const child = spawn("tmux", ["-L", TMUX_SOCKET, "load-buffer", "-b", "meshspike", "-"]);
  child.stdin.end(text);
  await new Promise((ok) => child.on("close", ok));
  await tmux("paste-buffer", "-p", "-d", "-b", "meshspike", "-t", target);
  if (enter) {
    await sleep(300);
    await tmux("send-keys", "-t", target, "Enter");
  }
}

export async function waitScreen(target: string, re: RegExp, timeoutMs: number, label: string): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await capture(target);
    if (re.test(s)) return s;
    if (Date.now() > deadline) throw new Error(`timeout waiting for screen ${label}\n---\n${s}`);
    await sleep(500);
  }
}

export async function panePid(target: string): Promise<number> {
  return Number((await tmux("display-message", "-p", "-t", target, "#{pane_pid}")).stdout.trim());
}

export function sleep(ms: number): Promise<void> {
  return new Promise((ok) => setTimeout(ok, ms));
}

export function note(file: string, line: string): void {
  appendFileSync(file, line + "\n");
  process.stdout.write(line + "\n");
}

export function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
