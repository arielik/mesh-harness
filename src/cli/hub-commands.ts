// M2 commands that talk to the hub: login, logout, whoami, goal, next, take, answer, autopilot,
// and `mesh hub init` (writes a starter mesh-hub.yaml).

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stringify, parse as parseYaml } from "yaml";
import { sha256 } from "../auth/index.ts";
import { repoMatches } from "../core/index.ts";
import { PlanInput, type Goal, type GoalDetail, type Step, type TrailFile } from "../protocol/index.ts";
import { DaemonClient } from "./client.ts";
import type { Command } from "./commands.ts";
import { loadConfig, parseArgs, type CliEnv } from "./context.ts";
import { clearCredentials, HubClient, hubFetch, loadCredentials, saveCredentials } from "./hub-client.ts";
import { login } from "./login.ts";
import { renderGoal } from "./show.ts";
import { writeTrailHere } from "./trail-files.ts";

const stepLine = (s: Step) => `${s.id.padEnd(20)} ${s.state.padEnd(8)} ${s.kind.padEnd(9)} ${(s.repo || "-").padEnd(18)} ${s.holderUser ? `@${s.holderUser} ` : ""}${s.title}`;

export function loginCommand(c: CliEnv): Command {
  return {
    name: "login",
    summary: "log in to a mesh hub: mesh login --hub URL [--provider ID] [--token T] [--device]",
    async run(args) {
      const a = parseArgs(args, ["hub", "provider", "token"]);
      const hub = a.str("hub") ?? loadCredentials(c.paths)?.hub ?? c.env.MESH_HUB;
      if (!hub) {
        c.io.err("usage: mesh login --hub https://mesh.example [--provider ID] [--token T] [--device]");
        return 2;
      }
      const ask = async (q: string) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          return await rl.question(q);
        } finally {
          rl.close();
        }
      };
      const r = await login({
        hub,
        provider: a.str("provider"),
        token: a.str("token") ?? c.env.MESH_TOKEN,
        device: a.has("device"),
        noBrowser: a.has("no-browser"),
        io: c.io,
        ...(c.runner ? { runner: c.runner } : {}),
        ask,
      });
      saveCredentials(c.paths, { hub: hub.replace(/\/+$/, ""), token: r.token, user: r.user, ...(r.machine ? { machine: r.machine } : {}) });
      c.io.out(`Logged in to ${hub} as ${r.user.id} (${r.user.roles.join(", ")}). Your running daemon picks this up by itself.`);
      return 0;
    },
  };
}

export function logoutCommand(c: CliEnv): Command {
  return {
    name: "logout",
    summary: "log out of the hub",
    async run() {
      const creds = loadCredentials(c.paths);
      if (!creds) {
        c.io.out("Not logged in.");
        return 0;
      }
      await hubFetch(creds.hub, "POST", "/auth/logout", { token: creds.token }).catch(() => undefined);
      clearCredentials(c.paths);
      c.io.out(`Logged out of ${creds.hub}.`);
      return 0;
    },
  };
}

export function whoamiCommand(c: CliEnv): Command {
  return {
    name: "whoami",
    summary: "show who you are on the hub",
    async run() {
      const hub = HubClient.from(c.paths);
      const me = await hub.get<{ user: { id: string; name: string; roles: string[] }; machine?: string }>("/v1/me");
      c.io.out(`${me.user.id} (${me.user.name}) on ${hub.creds.hub} · roles: ${me.user.roles.join(", ")}${me.machine ? ` · machine ${me.machine}` : ""}`);
      return 0;
    },
  };
}

function readPlan(file: string): PlanInput {
  const text = readFileSync(file, "utf8");
  const raw = file.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  return PlanInput.parse(raw);
}

export function goalCommand(c: CliEnv): Command {
  const usage = [
    "usage:",
    '  mesh goal new "<title>" [--repo R] [--repos a,b] [--refs spec=771,backlog=NA-1054] [--issue URL] [--priority 0-9]',
    "  mesh goal ls",
    "  mesh goal show <G>",
    "  mesh goal plan <G> --file plan.yaml [--no-approve]",
    '  mesh goal approve <G> [--comment "…"]',
    '  mesh goal revise <G> "<comment>"',
    '  mesh goal replan <G> ["<comment>"]',
    "  mesh goal files <G> [--write]",
  ].join("\n");
  return {
    name: "goal",
    summary: "goals and plans: new, ls, show, plan, approve, revise",
    async run(args) {
      const [sub, ...rest] = args;
      const a = parseArgs(rest, ["repo", "repos", "refs", "issue", "priority", "file", "comment"]);
      const hub = () => HubClient.from(c.paths);
      switch (sub) {
        case "new": {
          const title = a.positional.join(" ");
          if (!title) break;
          const g = await hub().post<Goal>("/v1/goals", {
            title,
            ...(a.str("repo") ? { primaryRepo: a.str("repo") } : {}),
            ...(a.str("repos") ? { repos: (a.str("repos") as string).split(",").map((r) => r.trim()).filter(Boolean) } : {}),
            ...(a.str("refs") ? { refs: Object.fromEntries((a.str("refs") as string).split(",").map((kv) => kv.split("=").map((x) => x.trim())).filter((kv) => kv.length === 2 && kv[0] && kv[1])) } : {}),
            ...(a.str("issue") ? { issueUrl: a.str("issue") } : {}),
            ...(a.str("priority") ? { priority: Number(a.str("priority")) } : {}),
          });
          c.io.out(`Created ${g.id} "${g.title}". Start the design with: mesh run --design ${g.id}`);
          return 0;
        }
        case "ls": {
          const { goals } = await hub().get<{ goals: Goal[] }>("/v1/goals");
          if (goals.length === 0) c.io.out("No goals yet. Create one: mesh goal new \"<title>\"");
          for (const g of goals) c.io.out(`${g.id.padEnd(5)} ${g.state.padEnd(18)} @${g.ownerId.padEnd(12)} ${g.title}`);
          return 0;
        }
        case "show": {
          const id = a.positional[0];
          if (!id) break;
          const d = await hub().get<GoalDetail>(`/v1/goals/${encodeURIComponent(id)}`);
          c.io.out(renderGoal(d, { color: process.stdout.isTTY === true }));
          return 0;
        }
        case "plan": {
          const id = a.positional[0];
          const file = a.str("file");
          if (!id || !file) break;
          const plan = readPlan(file);
          const r = await hub().post<{ plan: { version: number }; detail?: GoalDetail }>(`/v1/goals/${encodeURIComponent(id)}/plan`, { ...plan, approve: !a.has("no-approve") });
          c.io.out(r.detail ? `Plan v${r.plan.version} approved; ${r.detail.steps.filter((s) => s.state === "ready").length} step(s) ready.` : `Plan v${r.plan.version} proposed; waiting for approval.`);
          return 0;
        }
        case "approve": {
          const id = a.positional[0];
          if (!id) break;
          const d = await hub().post<GoalDetail>(`/v1/goals/${encodeURIComponent(id)}/approve`, a.str("comment") ? { comment: a.str("comment") } : {});
          c.io.out(`${d.goal.id} approved; ready: ${d.steps.filter((s) => s.state === "ready").map((s) => s.id).join(", ") || "none"}`);
          return 0;
        }
        case "revise": {
          const [id, ...words] = a.positional;
          if (!id || words.length === 0) break;
          await hub().post(`/v1/goals/${encodeURIComponent(id)}/revise`, { comment: words.join(" ") });
          c.io.out(`Asked for changes to ${id}; the design session gets your comment.`);
          return 0;
        }
        case "replan": {
          const [id, ...words] = a.positional;
          if (!id) break;
          await hub().post(`/v1/goals/${encodeURIComponent(id)}/replan`, words.length ? { comment: words.join(" ") } : {});
          c.io.out(`${id}.design is open again. Continue the design with: mesh run --design ${id}`);
          return 0;
        }
        case "files": {
          const id = a.positional[0];
          if (!id) break;
          const { files } = await hub().get<{ files: TrailFile[] }>(`/v1/goals/${encodeURIComponent(id)}/files`);
          if (a.has("write")) {
            const w = writeTrailHere(c.cwd, files);
            c.io.out(w.length ? `Wrote ${w.join(", ")}` : "Not inside a git checkout; nothing written.");
          } else for (const f of files) c.io.out(`# ${f.path}\n${f.text}`);
          return 0;
        }
      }
      c.io.err(usage);
      return 2;
    },
  };
}

export function showCommand(c: CliEnv): Command {
  return {
    name: "show",
    summary: "a goal and its step DAG: mesh show <goal>",
    async run(args) {
      const [id] = args;
      if (!id) {
        c.io.err("usage: mesh show <goal>");
        return 2;
      }
      const d = await HubClient.from(c.paths).get<GoalDetail>(`/v1/goals/${encodeURIComponent(id)}`);
      c.io.out(renderGoal(d, { color: process.stdout.isTTY === true }));
      return 0;
    },
  };
}

export function nextCommand(c: CliEnv): Command {
  return {
    name: "next",
    summary: "list ready steps (all repos, or --repo R)",
    async run(args) {
      const a = parseArgs(args, ["repo", "goal"]);
      const q = new URLSearchParams({ ready: "1", ...(a.str("goal") ? { goal: a.str("goal") as string } : {}) });
      let { steps } = await HubClient.from(c.paths).get<{ steps: Step[] }>(`/v1/steps?${q}`);
      const repo = a.str("repo");
      if (repo) steps = steps.filter((s) => !s.repo || repoMatches({ id: s.repo, name: s.repo.split("/").at(-1) ?? s.repo }, repo));
      if (steps.length === 0) c.io.out("No ready steps.");
      for (const s of steps) c.io.out(stepLine(s));
      return 0;
    },
  };
}

export function takeCommand(c: CliEnv): Command {
  return {
    name: "take",
    summary: "take over a paused or stalled step: mesh take <step>",
    async run(args) {
      const [id] = args;
      if (!id) {
        c.io.err("usage: mesh take <step>");
        return 2;
      }
      const s = await HubClient.from(c.paths).post<Step>(`/v1/steps/${encodeURIComponent(id)}/take`, {});
      c.io.out(`You hold ${s.id} now. Continue with: mesh run ${s.repo || "<repo>"} --step ${s.id}`);
      return 0;
    },
  };
}

export function answerCommand(c: CliEnv): Command {
  return {
    name: "answer",
    summary: "answer an agent's question: mesh answer <id> <text>",
    async run(args) {
      const [id, ...words] = args;
      if (!id || words.length === 0) {
        c.io.err("usage: mesh answer <question id> <text>");
        return 2;
      }
      await HubClient.from(c.paths).post(`/v1/questions/${encodeURIComponent(id)}/answer`, { text: words.join(" ") });
      c.io.out("Answer sent; it reaches the session as a message.");
      return 0;
    },
  };
}

export function autopilotCommand(c: CliEnv): Command {
  return {
    name: "autopilot",
    summary: "set a session's autopilot: mesh autopilot <session> off|nudge|chain",
    async run(args) {
      const [target, level] = args;
      if (!target || (level !== "off" && level !== "nudge" && level !== "chain")) {
        c.io.err("usage: mesh autopilot <session> off|nudge|chain");
        return 2;
      }
      const s = await new DaemonClient(loadConfig(c.paths)).autopilot(target, level);
      c.io.out(`${s.name ?? s.repo?.name ?? s.sid.slice(0, 8)}: autopilot ${level}`);
      return 0;
    },
  };
}

/** `mesh hub init`: a starter config with a token provider and freshly generated tokens. */
export function hubInit(path: string, users: string[], listen: string): { tokens: Record<string, string>; text: string } {
  if (existsSync(path)) throw new Error(`${path} already exists`);
  const tokens: Record<string, string> = {};
  for (const u of users) tokens[u] = randomBytes(24).toString("base64url");
  const config = {
    listen,
    url: `http://${listen}`,
    db: "mesh-hub.db",
    auth: {
      providers: [
        {
          id: "team",
          kind: "token",
          users: users.map((u) => ({ name: u, token_sha256: sha256(tokens[u] as string) })),
          roles: { approver: [], admin: [] },
        },
      ],
      bootstrap_admins: users.slice(0, 1).map((u) => `team:${u}`),
    },
    thresholds: { takeover_after: "4h", pause_grace: "2m", machine_offline: "15m" },
  };
  const header = [
    "# mesh hub configuration. Docs: docs/plan/implementation-plan.md §4.",
    "# To add OIDC (Kanidm, Keycloak, …) append a provider like:",
    "#   - id: kanidm",
    "#     kind: oidc",
    "#     preset: kanidm",
    "#     issuer: https://idm.example/oauth2/openid/mesh",
    "#     client_id: mesh",
    "#     client_secret_env: MESH_KANIDM_SECRET",
    "#     roles: { approver: [mesh-approvers], admin: [mesh-admins] }",
    "",
  ].join("\n");
  const text = header + stringify(config);
  writeFileSync(path, text, { mode: 0o600 });
  return { tokens, text };
}

export function hubCommands(c: CliEnv): Command[] {
  return [loginCommand(c), logoutCommand(c), whoamiCommand(c), goalCommand(c), showCommand(c), nextCommand(c), takeCommand(c), answerCommand(c), autopilotCommand(c)];
}
