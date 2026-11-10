// `mesh mcp`: a stdio MCP server Claude Code starts per session (plan §5.2). It knows its parent
// pid (the Claude process, spike S6) and forwards each tool call to the local daemon, which maps
// the pid to the current session. MCP's own CLAUDE_CODE_SESSION_ID goes stale after /clear.
// OpenCode starts one shim per server, shared by all its sessions, and names the session in each
// call (`_meta["ai.opencode/sessionID"]`); the shim forwards that id instead.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { DaemonConfig, KEY_HEADER, MESH_MCP_INSTRUCTIONS, TOOL_NAMES, TOOLS, type ToolName, type ToolResult } from "../protocol/index.ts";

export interface ShimOptions {
  daemonConfigPath: string;
  claudePid: number;
  version: string;
  fetch?: typeof fetch;
}

/** Call the daemon; retries network errors with the same idempotency key. */
/** The OpenCode session a tool call came from, from the request's `_meta`. */
export const OPENCODE_SESSION_META = "ai.opencode/sessionID";

export function agentSessionIdOf(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const v = (meta as Record<string, unknown>)[OPENCODE_SESSION_META];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export async function forward(opts: ShimOptions, tool: ToolName, args: Record<string, unknown>, agentSessionId?: string): Promise<ToolResult> {
  if (!existsSync(opts.daemonConfigPath)) return { text: "mesh is not set up on this machine (run: mesh setup).", isError: true };
  const config = DaemonConfig.parse(JSON.parse(readFileSync(opts.daemonConfigPath, "utf8")));
  const doFetch = opts.fetch ?? fetch;
  const key = randomUUID();
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await doFetch(`http://127.0.0.1:${config.port}/local/mcp/${tool}`, {
        method: "POST",
        headers: { [KEY_HEADER]: config.key, "content-type": "application/json" },
        body: JSON.stringify({ pid: opts.claudePid, args, key, ...(agentSessionId ? { agentSessionId } : {}) }),
        signal: AbortSignal.timeout(30_000),
      });
      const json = (await res.json().catch(() => ({}))) as ToolResult & { error?: string };
      if (!res.ok) return { text: json.error ?? `mesh daemon returned ${res.status}`, isError: true };
      return { text: json.text, ...(json.isError ? { isError: true } : {}) };
    } catch (e) {
      lastError = String(e);
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  return { text: `the mesh daemon is not reachable (run: mesh up). ${lastError}`, isError: true };
}

export function buildServer(opts: ShimOptions): McpServer {
  const server = new McpServer({ name: "mesh", version: opts.version }, { instructions: MESH_MCP_INSTRUCTIONS });
  for (const name of TOOL_NAMES) {
    const def = TOOLS[name];
    server.registerTool(name, { description: def.description, inputSchema: def.input }, async (args: Record<string, unknown>, extra: { _meta?: unknown } | undefined) => {
      const r = await forward(opts, name, args ?? {}, agentSessionIdOf(extra?._meta));
      return { content: [{ type: "text" as const, text: r.text }], ...(r.isError ? { isError: true } : {}) };
    });
  }
  return server;
}

export async function runShim(opts: ShimOptions, transport: Transport = new StdioServerTransport()): Promise<void> {
  const server = buildServer(opts);
  await server.connect(transport);
}
