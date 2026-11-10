// The OpenCode plugin `mesh setup --agent opencode` writes to ~/.config/opencode/plugins/mesh-harness.js
// (OpenCode v2 loads every .js file in that folder). It runs inside each OpenCode server, shared
// (the background service, the desktop app) or private (`opencode --standalone`, one per terminal),
// and:
//   - forwards session events to the mesh daemon (POST /mesh/agent-event/opencode), never prompt text;
//   - registers the mesh MCP server, so no OpenCode config file is edited;
//   - delivers mesh messages (replies to events, and a poll every few seconds) as queued prompts.
// It never throws into OpenCode, keeps requests in order and gives each a short timeout: a daemon
// that is down never slows the agent.

import { OPENCODE_EVENT_TYPES, OPENCODE_PLUGIN_VERSION } from "../protocol/index.ts";

/** First line of every plugin file mesh writes; how mesh recognises its own file. */
export const PLUGIN_MARKER = "// mesh-harness OpenCode plugin";

export interface PluginOptions {
  /** The daemon config file (port and key), read on every request so a new key needs no reinstall. */
  daemonConfigPath: string;
  /** argv of the mesh MCP server (`mesh mcp`). */
  mcpCommand: string[];
}

export function pluginVersionOf(text: string): number | undefined {
  if (!text.startsWith(PLUGIN_MARKER)) return undefined;
  const m = /MESH_OPENCODE_PLUGIN_VERSION=(\d+)/.exec(text);
  return m ? Number(m[1]) : undefined;
}

export function pluginSource(o: PluginOptions): string {
  const j = (v: unknown) => JSON.stringify(v);
  return `${PLUGIN_MARKER}. Managed by \`mesh setup --agent opencode\`: it is overwritten on update,
// and \`mesh setup --agent opencode --uninstall\` removes it. Do not edit.
// MESH_OPENCODE_PLUGIN_VERSION=${OPENCODE_PLUGIN_VERSION}
import { readFileSync } from "node:fs";

const VERSION = ${OPENCODE_PLUGIN_VERSION};
const DAEMON_CONFIG = ${j(o.daemonConfigPath)};
const MCP_COMMAND = ${j(o.mcpCommand)};
const FORWARD = new Set(${j(OPENCODE_EVENT_TYPES)});
const TEXT_MAX = 2000;
const POLL_MS = 5000;

function daemon() {
  try {
    const c = JSON.parse(readFileSync(DAEMON_CONFIG, "utf8"));
    return typeof c.port === "number" && typeof c.key === "string" ? c : undefined;
  } catch {
    return undefined;
  }
}

async function post(path, body) {
  const d = daemon();
  if (!d) return undefined;
  try {
    const r = await fetch("http://127.0.0.1:" + d.port + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mesh-key": d.key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
    return r.ok ? await r.json() : undefined;
  } catch {
    return undefined;
  }
}

const cap = (t) => (typeof t === "string" ? (t.length > TEXT_MAX ? t.slice(0, TEXT_MAX) : t) : undefined);

export default {
  id: "mesh-harness",
  async setup(ctx) {
    const env = process.env;
    // A private server (\`opencode --standalone\`) runs as \`serve --stdio\` under one terminal's
    // TUI: its pane and mesh variables are that terminal's. A shared server has no terminal.
    const standalone = process.argv.includes("--stdio");
    const where = standalone
      ? { pane: env.TMUX_PANE || undefined, tmux: env.TMUX || undefined, step: env.MESH_STEP || undefined, autopilot: env.MESH_AUTOPILOT || undefined }
      : {};
    const rootOf = new Map(); // child session -> root session
    const roots = new Set();
    const text = new Map(); // root -> last assistant text of the turn
    const model = new Map();
    const promptLength = new Map();
    const delivered = new Set(); // roots whose next turn was started by a mesh delivery
    let chain = Promise.resolve();

    const deliver = async (list) => {
      for (const m of Array.isArray(list) ? list : []) {
        if (!m || typeof m.sessionID !== "string" || typeof m.text !== "string") continue;
        delivered.add(m.sessionID);
        try {
          await ctx.session.prompt({ sessionID: m.sessionID, text: m.text, delivery: "queue" });
        } catch {
          delivered.delete(m.sessionID);
        }
      }
    };
    const send = (body) => {
      chain = chain
        .then(() => post("/mesh/agent-event/opencode", body))
        .then((r) => (r && r.deliver ? deliver([r.deliver]) : undefined))
        .catch(() => undefined);
    };

    try {
      await ctx.mcp.transform((d) => {
        if (!d.get("mesh")) d.set("mesh", { type: "local", command: MCP_COMMAND });
      });
    } catch {
      // An OpenCode without ctx.mcp.transform: the session reports to mesh, without the step tools.
    }

    const handle = (e) => {
      const type = e && e.type;
      const d = (e && e.data) || {};
      const form = d.form || {};
      const sid = d.sessionID || form.sessionID || (d.info && d.info.id);
      if (type === "session.created" && sid && d.parentID) rootOf.set(sid, rootOf.get(d.parentID) || d.parentID);
      const root = sid ? rootOf.get(sid) || sid : undefined;
      const child = root !== undefined && root !== sid;
      switch (type) {
        case "session.inbox.enqueued":
          if (!child && d.item && d.item.type === "user" && d.item.payload && typeof d.item.payload.text === "string") promptLength.set(root, d.item.payload.text.length);
          return;
        case "session.step.started":
          if (!child && d.model && d.model.id) model.set(root, (d.model.providerID ? d.model.providerID + "/" : "") + d.model.id);
          return;
        case "session.text.ended":
          if (!child && typeof d.text === "string" && d.text.trim()) text.set(root, d.text);
          return;
      }
      if (!FORWARD.has(type)) return;
      // Of a subagent, only what waits for the person matters (it shows on the root session).
      if (child && !type.startsWith("permission.") && !type.startsWith("form.")) return;
      const body = { v: VERSION, type, pid: process.pid, standalone, at: typeof e.created === "number" ? e.created : Date.now(), ...where };
      const cwd = (e.location && e.location.directory) || (d.location && d.location.directory) || (ctx.location && ctx.location.directory);
      if (cwd) body.cwd = cwd;
      if (root) {
        body.sessionID = root;
        if (child) body.child = true;
        else roots.add(root);
      }
      if (type === "session.execution.started" && !child) {
        text.delete(root);
        if (promptLength.has(root)) body.promptLength = promptLength.get(root);
        if (delivered.delete(root)) body.delivered = true;
      }
      if (type === "session.execution.succeeded" && !child) {
        body.text = cap(text.get(root));
        text.delete(root);
      }
      if (type === "session.execution.failed") body.text = cap((d.error && (d.error.message || d.error.data?.message)) || d.message);
      if (type === "form.created") body.text = cap(Array.isArray(form.fields) && form.fields[0] ? form.fields[0].title || form.title : form.title);
      if (root && model.has(root)) body.model = model.get(root);
      if (type === "session.deleted" && root) roots.delete(root);
      send(body);
    };

    const events = ctx.event.subscribe();
    (async () => {
      try {
        for await (const e of events) {
          try {
            handle(e);
          } catch {
            // never into OpenCode
          }
        }
      } catch {
        // the server is stopping
      }
    })();

    const timer = setInterval(() => {
      if (roots.size === 0) return;
      void post("/mesh/agent-poll/opencode", { sessionIDs: [...roots] }).then((r) => (r ? deliver(r.deliver) : undefined));
    }, POLL_MS);
    if (timer.unref) timer.unref();
    return () => clearInterval(timer);
  },
};
`;
}
