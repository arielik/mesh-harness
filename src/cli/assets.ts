// `mesh assets`: the example SDD kit that ships with mesh-harness (assets/sdd): agents, a programme
// workflow and a spec template. Copied into a repo so a team can start without any other repository.
// Nothing in it needs mesh; with mesh, every run is recorded.

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Command } from "./commands.ts";
import { parseArgs, type CliEnv } from "./context.ts";

/** assets/ next to the build (dist/../assets), or MESH_ASSETS_DIR. */
export function assetsDir(c: Pick<CliEnv, "env" | "self">): string {
  if (c.env.MESH_ASSETS_DIR) return c.env.MESH_ASSETS_DIR;
  const script = c.self[c.self.length - 1] ?? "";
  for (const candidate of [join(dirname(script), "..", "assets"), join(dirname(script), "assets"), join(process.cwd(), "assets")]) if (existsSync(join(candidate, "sdd"))) return resolve(candidate);
  throw new Error("the mesh assets folder was not found (set MESH_ASSETS_DIR)");
}

function files(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, rel)).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(join(root, r)).isDirectory()) out.push(...files(root, r));
    else out.push(r);
  }
  return out;
}

function gitRoot(cwd: string): string | undefined {
  for (let d = resolve(cwd); ; ) {
    if (existsSync(join(d, ".git"))) return d;
    const up = dirname(d);
    if (up === d) return undefined;
    d = up;
  }
}

export function installAssets(kitDir: string, target: string, force: boolean): { copied: string[]; skipped: string[] } {
  const copied: string[] = [];
  const skipped: string[] = [];
  for (const f of files(kitDir).filter((x) => !x.endsWith("README.md"))) {
    const to = join(target, f);
    if (existsSync(to) && !force) {
      skipped.push(f);
      continue;
    }
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(kitDir, f), to);
    copied.push(f);
  }
  return { copied, skipped };
}

export function assetsCommand(c: CliEnv): Command {
  return {
    name: "assets",
    summary: "the example SDD kit (agents, programme workflow, spec template): mesh assets ls | install [--target DIR] [--force]",
    async run(args) {
      const [sub, ...rest] = args;
      const a = parseArgs(rest, ["target", "kit"]);
      const kit = join(assetsDir(c), a.str("kit") ?? "sdd");
      if (!existsSync(kit)) throw new Error(`no kit ${a.str("kit")} in ${assetsDir(c)}`);
      if (sub === "ls" || sub === undefined) {
        for (const f of files(kit)) c.io.out(f);
        return 0;
      }
      if (sub === "install") {
        const target = a.str("target") ? resolve(c.cwd, a.str("target") as string) : gitRoot(c.cwd);
        if (!target) {
          c.io.err("not inside a git checkout; pass --target DIR");
          return 2;
        }
        const r = installAssets(kit, target, a.has("force"));
        for (const f of r.copied) c.io.out(`+ ${f}`);
        for (const f of r.skipped) c.io.out(`= ${f} (exists; --force to overwrite)`);
        c.io.out(
          `\nInstalled into ${target}${relative(c.cwd, target) ? ` (${relative(c.cwd, target)})` : ""}. Run a programme from Claude Code: "Run the workflow .claude/workflows/sdd-programme.js with args {rows: [{key: 'ROW-1', title: '…', brief: '…'}]}". Or run the same cycle as mesh steps: mesh goal plan <G> --preset sdd-split --repo <repo>. See docs/guide/cycle.md.`,
        );
        return 0;
      }
      c.io.err("usage: mesh assets ls | install [--target DIR] [--force] [--kit sdd]");
      return 2;
    },
  };
}
