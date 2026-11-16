import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exitQuietlyOnClosedPipe } from "../src/cli/pipes.ts";

const MAIN = join(import.meta.dirname, "..", "src", "main.ts");

/** Runs the CLI entry with the given stream's reader closed before mesh writes to it. */
function runClosed(args: string[], closed: "stdout" | "stderr"): Promise<{ code: number | null; other: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [MAIN, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MESH_CONFIG_DIR: "/nonexistent/mesh-cfg" } });
    child[closed].destroy();
    let other = "";
    child[closed === "stdout" ? "stderr" : "stdout"].on("data", (d: Buffer) => (other += d.toString()));
    child.on("error", fail);
    child.on("close", (code) => done({ code, other }));
  });
}

describe("output to a pipe its reader closed (`mesh … | head -1`)", () => {
  it("stdout closed: exits 0 without a stack trace", async () => {
    const r = await runClosed(["--help"], "stdout");
    expect(r.other).toBe("");
    expect(r.code).toBe(0);
  });

  it("stderr closed: keeps the command's exit code, no stack trace", async () => {
    const r = await runClosed(["say"], "stderr");
    expect(r.other).toBe("");
    expect(r.code).toBe(2);
  });

  it("other stream errors still throw", () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const exits: number[] = [];
    exitQuietlyOnClosedPipe({ stdout, stderr, exitCode: 3, exit: ((c: number) => void exits.push(c)) as (c?: number) => never });
    stdout.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    stderr.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    expect(exits).toEqual([0, 3]);
    expect(() => stdout.emit("error", Object.assign(new Error("boom"), { code: "EIO" }))).toThrow("boom");
  });
});
