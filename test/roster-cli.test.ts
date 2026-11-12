// RL-5 CLI against a World hub: `mesh agents`, `mesh agent add|outdated|diff|update`,
// `mesh agent source add|ls`, `mesh help`. Criteria AC-12 to AC-17. Written from the spec's contracts
// only (docs/specs/RL-5.md). Expected lines are built here from the documented formats; hashes by the
// test (roster-kit `H`).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/commands.ts";
import type { CliEnv } from "../src/cli/context.ts";
import { meshCommands } from "../src/cli/mesh-commands.ts";
import { resolvePaths } from "../src/protocol/index.ts";
import { type Bare } from "./helpers/pulse-kit.ts";
import { AARD, ALPHA, BETA, C1, C2, C3, GAMMA, H, H1, H2, OTHER, rep, REV1, REV2, Rk, RULE, SRC, SRC_URL, type Json } from "./helpers/roster-kit.ts";
import type { Person } from "./helpers/world.ts";

let k: Rk;
afterEach(async () => {
  vi.restoreAllMocks();
  await k?.stop();
});

interface Run {
  code: number;
  out: string;
  err: string;
  all: string;
  prompts: string[];
}

/** Run a mesh command as on `p`'s machine; `answer` is what the injected `readLine` returns. */
async function cli(p: Person, args: string[], o: { answer?: string } = {}): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const paths = resolvePaths({ MESH_CONFIG_DIR: p.dir, MESH_STATE_DIR: join(p.dir, "state"), CLAUDE_CONFIG_DIR: join(p.dir, "claude") }, p.dir);
  const wr = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    out.push(Buffer.from(chunk as never).toString("utf8"));
    return true;
  }) as typeof process.stdout.write);
  const c: CliEnv = {
    io: { out: (t) => out.push(t.endsWith("\n") ? t.slice(0, -1) : t), err: (t) => err.push(t) },
    paths,
    env: {},
    cwd: p.dir,
    self: ["mesh"],
    version: "0.0.0",
    ...(o.answer !== undefined
      ? {
          readLine: async (prompt: string) => {
            prompts.push(prompt);
            return o.answer as string;
          },
        }
      : {}),
  };
  let code: number;
  try {
    code = await dispatch(args, meshCommands(c), "0.0.0", (t) => out.push(t));
  } catch (e) {
    err.push(`mesh: ${e instanceof Error ? e.message : String(e)}`);
    code = 1;
  } finally {
    wr.mockRestore();
  }
  const o1 = out.join("\n");
  const e1 = err.join("\n");
  return { code, out: o1, err: e1, all: `${o1}\n${e1}`, prompts };
}
const lines = (s: string) => s.split("\n").filter((l) => l.trim() !== "");
const c7 = (c: string) => c.slice(0, 7);

interface Cast {
  ann: Person;
  root: Person;
  pusher: Bare;
  repo: string;
}
/** A catalog SRC with `defs` at C1, ann (member) and root (admin) machines; `repo` = ann's checkout. */
async function cast(defs: Record<string, string> = { rev: REV1, other: OTHER }): Promise<Cast> {
  k = await Rk.start();
  await k.sourceOk();
  const pusher = await k.pusher();
  await k.pushOk(pusher, C1, defs);
  const ann = await k.w.person("ann", "work");
  const root = await k.w.person("root", "admin-work");
  return { ann, root, pusher, repo: ann.repoDir };
}
const lockPath = (repo: string) => join(repo, ".mesh", "agents.lock");
const lockText = (entries: { name: string; source: string; commit: string; hash: string }[]) => `${JSON.stringify({ version: 1, agents: entries.map((e) => ({ name: e.name, source: e.source, commit: e.commit, hash: e.hash })) }, null, 2)}\n`;
const fileOf = (repo: string, name: string) => join(repo, ".claude", "agents", `${name}.md`);

// ---------------------------------------------------------------------------------------------

describe("AC-12 mesh agents", { timeout: 30_000 }, () => {
  const RV = (n: number) => REV1.replace("You review.", `You review ${n}.`);
  const [R1, R2, R3] = [RV(1), RV(2), RV(3)];
  const pin = { source: SRC, commit: C1, hash: H(R1) };
  async function roster(): Promise<Person> {
    k = await Rk.start();
    await k.sourceOk();
    const p = await k.pusher();
    await k.pushOk(p, C1, { reviewer: R1 });
    await k.pushOk(p, C3, { reviewer: R3 });
    const m1 = await k.k.bare("ann", "ann-box", { repos: [ALPHA, BETA, GAMMA, AARD] });
    await k.report(
      m1,
      [
        rep(ALPHA, "reviewer", R1, { pin }),
        rep(BETA, "reviewer", R2, { pin }),
        rep(GAMMA, "reviewer", R2),
        rep(GAMMA, "reviewer", R2, { kind: "opencode", path: ".opencode/agent/reviewer.md" }),
        rep(AARD, "reviewer", R3, { description: "Aard copy" }),
      ],
      { share: "all" },
    );
    const m2 = await k.k.bare("bob", "bob-box", { repos: [ALPHA] });
    await k.report(m2, [rep(ALPHA, "reviewer", R1, { pin })], { share: "all" });
    return k.w.person("ann", "work");
  }

  it("test_AC12_lines", async () => {
    const ann = await roster();
    const res = await cli(ann, ["agents"]);
    expect(res.code, res.all).toBe(0);
    const h12 = (t: string) => H(t).slice(0, 12);
    expect(lines(res.out)).toStrictEqual([
      "reviewer  versions 3  copies 6  diverged  pinned  behind  modified",
      `  ${h12(R2)}  -`,
      `    beta/reviewer  repo  pin ${c7(C1)}  behind  modified`,
      "    gamma/reviewer  repo",
      "    gamma/reviewer  repo",
      `  ${h12(R3)}  Reviews code`,
      `    agents/reviewer  catalog ${c7(C3)}`,
      "    aardvark/reviewer  repo",
      `  ${h12(R1)}  -`,
      `    alpha/reviewer  repo  pin ${c7(C1)}  behind`,
    ]);
  });

  it("test_AC12_name_json_empty", async () => {
    const ann = await roster();
    await k.report(await k.k.bare("ann", "ann-box2", { repos: [ALPHA] }), [rep(ALPHA, "zeta", OTHER)], { share: "all" });
    const all = await cli(ann, ["agents"]);
    expect(all.out).toContain("zeta  versions 1  copies 1");
    const named = await cli(ann, ["agents", "--name", "reviewer"]);
    expect(named.code, named.all).toBe(0);
    expect(named.out).toContain("reviewer  versions 3");
    expect(named.out).not.toContain("zeta");
    const json = await cli(ann, ["agents", "--json"]);
    expect(json.code, json.all).toBe(0);
    const viaHub = await k.call("ann", "GET", "/v1/agents");
    expect(JSON.parse(json.out)).toStrictEqual(viaHub.json);
    expect(json.out.trimEnd()).toBe(JSON.stringify(viaHub.json, null, 2));
  });

  it("test_AC12_empty", async () => {
    k = await Rk.start();
    const ann = await k.w.person("ann", "work");
    const res = await cli(ann, ["agents"]);
    expect(res.code, res.all).toBe(0);
    expect(lines(res.out)).toStrictEqual(["No agents on the roster."]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-13 mesh agent add", { timeout: 30_000 }, () => {
  it("test_AC13_install_bytes_and_lock", async () => {
    const f = await cast();
    mkdirSync(join(f.repo, "sub", "dir"), { recursive: true });
    const res = await cli(f.ann, ["agent", "add", "agents/rev", "--repo", join(f.repo, "sub", "dir")]);
    expect(res.code, res.all).toBe(0);
    expect(lines(res.out)).toStrictEqual([`Installed agents/rev@${c7(C1)} into .claude/agents/rev.md (hash ${H1.slice(0, 12)}); pinned in .mesh/agents.lock.`]);
    const bytes = readFileSync(fileOf(f.repo, "rev"));
    expect(bytes.equals(Buffer.from(REV1, "utf8"))).toBe(true);
    expect(H(bytes.toString("utf8"))).toBe(H1);
    expect(readFileSync(lockPath(f.repo), "utf8")).toBe(lockText([{ name: "rev", source: SRC, commit: C1, hash: H1 }]));
    expect(existsSync(join(f.repo, "sub", "dir", ".claude"))).toBe(false);
  });

  it("test_AC13_second_agent_sorted", async () => {
    const f = await cast();
    expect((await cli(f.ann, ["agent", "add", "agents/rev", "--repo", f.repo])).code).toBe(0);
    const res = await cli(f.ann, ["agent", "add", "agents/other", "--repo", f.repo]);
    expect(res.code, res.all).toBe(0);
    expect(readFileSync(lockPath(f.repo), "utf8")).toBe(
      lockText([
        { name: "other", source: SRC, commit: C1, hash: H(OTHER) },
        { name: "rev", source: SRC, commit: C1, hash: H1 },
      ]),
    );
    expect(readFileSync(fileOf(f.repo, "other"), "utf8")).toBe(OTHER);
  });

  it("test_AC13_existing_differs", async () => {
    const f = await cast();
    // Control: an existing equal file is fine without --force.
    mkdirSync(join(f.repo, ".claude", "agents"), { recursive: true });
    writeFileSync(fileOf(f.repo, "rev"), REV1);
    expect((await cli(f.ann, ["agent", "add", "agents/rev", "--repo", f.repo])).code).toBe(0);
    const lockBefore = readFileSync(lockPath(f.repo));
    writeFileSync(fileOf(f.repo, "rev"), "x");
    const res = await cli(f.ann, ["agent", "add", "agents/rev", "--repo", f.repo]);
    expect(res.code, res.all).toBe(1);
    expect(res.all).toContain(`${f.repo}/.claude/agents/rev.md exists and differs from agents/rev@${c7(C1)}; use --force to replace it`);
    expect(readFileSync(fileOf(f.repo, "rev"), "utf8")).toBe("x");
    expect(readFileSync(lockPath(f.repo)).equals(lockBefore)).toBe(true);
    const forced = await cli(f.ann, ["agent", "add", "agents/rev", "--repo", f.repo, "--force"]);
    expect(forced.code, forced.all).toBe(0);
    expect(readFileSync(fileOf(f.repo, "rev"), "utf8")).toBe(REV1);
  });

  it("test_AC13_errors", async () => {
    const f = await cast();
    const notRepo = join(f.ann.dir, "not-a-repo");
    mkdirSync(notRepo);
    const a = await cli(f.ann, ["agent", "add", "agents/rev", "--repo", notRepo]);
    expect(a.code, a.all).toBe(2);
    expect(a.all).toContain(`not in a git checkout: ${notRepo}`);
    const b = await cli(f.ann, ["agent", "add", "rev", "--repo", f.repo]);
    expect(b.code, b.all).toBe(2);
    expect(b.all).toContain(RULE);
    const c = await cli(f.ann, ["agent", "add", "agents/nope", "--repo", f.repo]);
    expect(c.code, c.all).toBe(1);
    expect(c.all).toContain(`no agent nope in catalog source ${SRC}`);
    expect(existsSync(join(f.repo, ".mesh"))).toBe(false);
    expect(existsSync(join(f.repo, ".claude"))).toBe(false);
    // Control: a valid add writes.
    expect((await cli(f.ann, ["agent", "add", "agents/rev", "--repo", f.repo])).code).toBe(0);
    expect(existsSync(lockPath(f.repo))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-14 mesh agent outdated", { timeout: 40_000 }, () => {
  const T = (n: string, v = 1) => `---\ndescription: Agent ${n}\n---\nYou are ${n} v${v}.\n`;
  async function fixture(): Promise<Cast> {
    const f = await cast(Object.fromEntries(["a", "b", "c", "d", "e", "f"].map((n) => [n, T(n)])));
    for (const n of ["a", "b", "c", "d", "e", "f"]) expect((await cli(f.ann, ["agent", "add", `agents/${n}`, "--repo", f.repo])).code, n).toBe(0);
    await k.pushOk(f.pusher, C2, { a: T("a"), b: T("b"), c: T("c", 2), d: T("d", 2), e: T("e") });
    writeFileSync(fileOf(f.repo, "b"), T("b", 9));
    writeFileSync(fileOf(f.repo, "d"), T("d", 9));
    rmSync(fileOf(f.repo, "e"));
    return f;
  }

  it("test_AC14_statuses", async () => {
    const f = await fixture();
    const res = await cli(f.ann, ["agent", "outdated", "--repo", f.repo]);
    expect(res.code, res.all).toBe(1);
    expect(lines(res.out)).toStrictEqual([
      `a  agents/a@${c7(C1)}  ok`,
      `b  agents/b@${c7(C1)}  modified`,
      `c  agents/c@${c7(C1)}  behind  latest ${c7(C2)}`,
      `d  agents/d@${c7(C1)}  modified,behind  latest ${c7(C2)}`,
      `e  agents/e@${c7(C1)}  missing`,
      `f  agents/f@${c7(C1)}  gone`,
    ]);
  });

  it("test_AC14_all_ok_and_no_lock", async () => {
    const f = await cast();
    const none = await cli(f.ann, ["agent", "outdated", "--repo", f.repo]);
    expect(none.code, none.all).toBe(0);
    expect(lines(none.out)).toStrictEqual([`No pinned agents in ${f.repo}.`]);
    expect((await cli(f.ann, ["agent", "add", "agents/rev", "--repo", f.repo])).code).toBe(0);
    const ok = await cli(f.ann, ["agent", "outdated", "--repo", f.repo]);
    expect(ok.code, ok.all).toBe(0);
    expect(lines(ok.out)).toStrictEqual([`rev  agents/rev@${c7(C1)}  ok`]);
  });

  it("test_AC14_json", async () => {
    const f = await fixture();
    const res = await cli(f.ann, ["agent", "outdated", "--repo", f.repo, "--json"]);
    expect(res.code, res.all).toBe(1);
    const j = JSON.parse(res.out);
    const status = Object.fromEntries((j.agents as Json[]).map((a) => [a.name, a.status]));
    expect(status).toStrictEqual({ a: "ok", b: "modified", c: "behind", d: "modified,behind", e: "missing", f: "gone" });
    const T2 = (n: string) => H(T(n, 2));
    for (const a of j.agents as Json[]) {
      expect(a, a.name).toMatchObject({ name: a.name, source: SRC, commit: C1, hash: H(T(a.name)) });
      // Verify c1 AC-14: latest is present whenever the entry resolved (any status), absent when not (gone).
      if (a.name === "c" || a.name === "d") expect(a.latest, a.name).toStrictEqual({ hash: T2(a.name), commit: C2 });
      else if (a.name === "f") expect("latest" in a, a.name).toBe(false);
      else expect(a.latest, a.name).toStrictEqual({ hash: H(T(a.name)), commit: C2 });
    }
  });

  it("test_AC14_hub_failures", async () => {
    const f = await fixture();
    const STATUS = /^\S+ {2}\S+ {2}(ok|gone|missing|modified|behind)/m;
    await k.w.stopHub();
    const down = await cli(f.ann, ["agent", "outdated", "--repo", f.repo]);
    expect(down.code, down.all).toBe(1);
    expect(down.all.trim()).not.toBe("");
    expect(down.out).not.toMatch(STATUS);
    expect(down.all).not.toContain("gone");
    await k.w.startHubAgain();
    // 401: a token the hub does not know.
    const creds = readFileSync(f.ann.credentialsPath, "utf8");
    writeFileSync(f.ann.credentialsPath, JSON.stringify({ ...JSON.parse(creds), token: "mh_d_not-a-real-token" }));
    const unauth = await cli(f.ann, ["agent", "outdated", "--repo", f.repo]);
    expect(unauth.code, unauth.all).toBe(1);
    expect(unauth.out).not.toMatch(STATUS);
    expect(unauth.all).not.toContain("gone");
    writeFileSync(f.ann.credentialsPath, creds);
    // Control: the status lines return.
    const back = await cli(f.ann, ["agent", "outdated", "--repo", f.repo]);
    expect(back.out).toMatch(STATUS);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-15 mesh agent diff", { timeout: 30_000 }, () => {
  it("test_AC15_diff", async () => {
    const f = await cast();
    expect((await cli(f.ann, ["agent", "add", "agents/rev", "--repo", f.repo])).code).toBe(0);
    await k.pushOk(f.pusher, C2, { rev: REV2, other: OTHER });
    const core = (await import("../src/core/index.ts")) as unknown as { unifiedDiff(a: string, b: string, la: string, lb: string): string };
    const res = await cli(f.ann, ["agent", "diff", "rev", "--repo", f.repo]);
    expect(res.code, res.all).toBe(0);
    const want = core.unifiedDiff(REV1, REV2, ".claude/agents/rev.md", `agents/rev@${c7(C2)}`);
    expect(res.out.trimEnd()).toBe(want.trimEnd());
    expect(lines(res.out).slice(0, 2)).toStrictEqual(["--- .claude/agents/rev.md", `+++ agents/rev@${c7(C2)}`]);
    expect(lines(res.out)).toContain("-You review.");
    expect(lines(res.out)).toContain("+You review carefully.");
    // Missing file: a diff from "".
    rmSync(fileOf(f.repo, "rev"));
    const gone = await cli(f.ann, ["agent", "diff", "rev", "--repo", f.repo]);
    expect(gone.code, gone.all).toBe(0);
    expect(gone.out.trimEnd()).toBe(core.unifiedDiff("", REV2, ".claude/agents/rev.md", `agents/rev@${c7(C2)}`).trimEnd());
    // Identical.
    writeFileSync(fileOf(f.repo, "rev"), REV2);
    const same = await cli(f.ann, ["agent", "diff", "rev", "--repo", f.repo]);
    expect(same.code, same.all).toBe(0);
    expect(lines(same.out)).toStrictEqual([`rev: no difference from agents/rev@${c7(C2)}`]);
    const ghost = await cli(f.ann, ["agent", "diff", "ghost", "--repo", f.repo]);
    expect(ghost.code).toBe(1);
    expect(ghost.all).toContain(`ghost is not pinned in ${f.repo}/.mesh/agents.lock`);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-16 mesh agent update", { timeout: 30_000 }, () => {
  const PROMPT = `Replace .claude/agents/rev.md with agents/rev@${c7(C2)}? [y/N] `;
  async function behind(): Promise<Cast> {
    const f = await cast();
    expect((await cli(f.ann, ["agent", "add", "agents/rev", "--repo", f.repo])).code).toBe(0);
    await k.pushOk(f.pusher, C2, { rev: REV2, other: OTHER });
    return f;
  }
  const snapshot = (repo: string) => ({ file: readFileSync(fileOf(repo, "rev")), lock: readFileSync(lockPath(repo)) });

  it("test_AC16_up_to_date", async () => {
    const f = await cast();
    expect((await cli(f.ann, ["agent", "add", "agents/rev", "--repo", f.repo])).code).toBe(0);
    const before = snapshot(f.repo);
    const res = await cli(f.ann, ["agent", "update", "rev", "--repo", f.repo], { answer: "y" });
    expect(res.code, res.all).toBe(0);
    expect(lines(res.out)).toStrictEqual([`rev is up to date (agents/rev@${c7(C1)}).`]);
    expect(res.prompts).toStrictEqual([]);
    const after = snapshot(f.repo);
    expect(after.file.equals(before.file)).toBe(true);
    expect(after.lock.equals(before.lock)).toBe(true);
  });

  it("test_AC16_confirm_yes", async () => {
    const f = await behind();
    const res = await cli(f.ann, ["agent", "update", "rev", "--repo", f.repo], { answer: "Y" });
    expect(res.code, res.all).toBe(0);
    expect(res.out).toContain("+You review carefully.");
    expect([...res.prompts, res.out].join("\n")).toContain(PROMPT);
    expect(lines(res.out).at(-1)).toBe(`Updated rev to agents/rev@${c7(C2)} (hash ${H2.slice(0, 12)}).`);
    expect(readFileSync(fileOf(f.repo, "rev"), "utf8")).toBe(REV2);
    expect(readFileSync(lockPath(f.repo), "utf8")).toBe(lockText([{ name: "rev", source: SRC, commit: C2, hash: H2 }]));
  });

  it.each([["n"], [""]])("test_AC16_confirm_no (%j)", async (answer) => {
    const f = await behind();
    const before = snapshot(f.repo);
    const res = await cli(f.ann, ["agent", "update", "rev", "--repo", f.repo], { answer });
    expect(res.code, res.all).toBe(1);
    expect([...res.prompts, res.out].join("\n")).toContain(PROMPT);
    expect(lines(res.out).at(-1)).toBe("Not updated.");
    const after = snapshot(f.repo);
    expect(after.file.equals(before.file)).toBe(true);
    expect(after.lock.equals(before.lock)).toBe(true);
  });

  it("test_AC16_no_terminal", async () => {
    const f = await behind();
    const before = snapshot(f.repo);
    const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      const res = await cli(f.ann, ["agent", "update", "rev", "--repo", f.repo]);
      expect(res.code, res.all).toBe(1);
      expect(res.all).toContain("Not updated: run with --yes to confirm without a terminal.");
      const after = snapshot(f.repo);
      expect(after.file.equals(before.file)).toBe(true);
      expect(after.lock.equals(before.lock)).toBe(true);
      const yes = await cli(f.ann, ["agent", "update", "rev", "--repo", f.repo, "--yes"]);
      expect(yes.code, yes.all).toBe(0);
      expect(yes.out).not.toContain("[y/N]");
      expect(lines(yes.out).at(-1)).toBe(`Updated rev to agents/rev@${c7(C2)} (hash ${H2.slice(0, 12)}).`);
      expect(readFileSync(fileOf(f.repo, "rev"), "utf8")).toBe(REV2);
    } finally {
      if (tty) Object.defineProperty(process.stdin, "isTTY", tty);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });

  it("test_AC16_modified_only", async () => {
    const f = await cast();
    expect((await cli(f.ann, ["agent", "add", "agents/rev", "--repo", f.repo])).code).toBe(0);
    writeFileSync(fileOf(f.repo, "rev"), "edited\n");
    const res = await cli(f.ann, ["agent", "update", "rev", "--repo", f.repo], { answer: "yes" });
    expect(res.code, res.all).toBe(0);
    expect(res.out).not.toContain("is up to date");
    expect(readFileSync(fileOf(f.repo, "rev"), "utf8")).toBe(REV1);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-17 mesh agent source and help", { timeout: 30_000 }, () => {
  it("test_AC17_source_add_ls", async () => {
    k = await Rk.start();
    const root = await k.w.person("root", "admin-work");
    const ann = await k.w.person("ann", "work");
    const empty = await cli(ann, ["agent", "source", "ls"]);
    expect(empty.code, empty.all).toBe(0);
    expect(lines(empty.out)).toStrictEqual(["No catalog sources."]);
    const add = await cli(root, ["agent", "source", "add", SRC_URL, "--folder", "agents", "--calibrator", "carol"]);
    expect(add.code, add.all).toBe(0);
    expect(lines(add.out)).toStrictEqual([`Saved catalog source ${SRC} (folder agents).`]);
    const refused = await cli(ann, ["agent", "source", "add", "https://git.example.com/zed/agents.git", "--folder", "agents"]);
    expect(refused.code, refused.all).toBe(1);
    expect(refused.all.trim()).not.toBe("");
    expect((await cli(root, ["agent", "source", "add", "https://git.example.com/zed/agents.git", "--folder", "agents"])).code).toBe(0);
    await k.pushOk(await k.pusher(), C1, { rev: REV1, other: OTHER });
    const ls = await cli(ann, ["agent", "source", "ls"]);
    expect(ls.code, ls.all).toBe(0);
    expect(lines(ls.out)).toStrictEqual([`${SRC}  agents  2 agent(s)  ${c7(C1)}  calibrator carol`, "git.example.com/zed/agents  agents  0 agent(s)  -"]);
    const json = await cli(ann, ["agent", "source", "ls", "--json"]);
    expect(JSON.parse(json.out)).toStrictEqual((await k.call("ann", "GET", "/v1/catalog-sources")).json);
    const usage = await cli(root, ["agent", "source", "add", SRC_URL]);
    expect(usage.code).toBe(2);
  });

  it("test_AC17_help", async () => {
    k = await Rk.start();
    const ann = await k.w.person("ann", "work");
    const res = await cli(ann, ["help"]);
    expect(res.code).toBe(0);
    expect(res.all).toMatch(/^\s+agents\b/m);
    expect(res.all).toMatch(/^\s+agent\b/m);
  });
});
