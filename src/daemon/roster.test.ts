// RL-5 AC-04: `scanAgents` over temp checkouts. Written from the spec's contracts only
// (docs/specs/RL-5.md). Hashes are computed here (SHA-256 of the text with CRLF turned into LF) and
// checked against `agentFileHash` too.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeCheckout } from "../../test/helpers/git-tree.ts";
import { agentFileHash } from "../core/index.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the new module, read loosely
type Json = any;
type Checkout = { dir: string; repo: { id: string; name: string } | undefined };

const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "mesh-roster-scan-"));
  cleanups.push(d);
  return d;
};
const scan = async (cs: Checkout[]): Promise<Json[]> => {
  const m = (await import("./roster.ts" as string)) as { scanAgents(c: Checkout[]): unknown[] };
  // As sent over the wire (no undefined keys).
  return JSON.parse(JSON.stringify(m.scanAgents(cs)));
};

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const H = (t: string) => sha(t.replace(/\r\n/g, "\n"));
const ALPHA = { id: "git.example.com/team/alpha", name: "alpha" };
const SRC = "git.example.com/team/agents";
const C1 = "c1".repeat(20);
const REV1 = "---\r\ndescription: Reviews code\r\nmodel: sonnet\r\ntools: Read, Grep\r\nmesh-rules: [r.alpha, r.beta]\r\n---\r\n\r\nYou review.\r\n";
const DOC = "---\ndescription: Writes docs\ntools:\n  read: true\n---\nYou document.\n";
const EXTRA = "---\ndescription: Extra\n---\nExtra.\n";

function put(dir: string, rel: string, text: string): void {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

/** Checkout A of alpha (with remote) holding the AC-04 files. */
function checkoutA(root: string): string {
  const dir = fakeCheckout(join(root, "alpha"), "https://git.example.com/team/alpha.git");
  put(dir, ".claude/agents/reviewer.md", REV1);
  put(dir, ".claude/agents/bad name.md", "---\ndescription: bad\n---\nx\n");
  put(dir, ".claude/agents/big.md", `---\ndescription: big\n---\n${"x".repeat(300_000)}\n`);
  put(dir, ".claude/agents/sub/x.md", "---\ndescription: nested\n---\nx\n");
  put(dir, ".opencode/agent/doc.md", DOC);
  return dir;
}
const REVIEWER = {
  repo: ALPHA.id,
  kind: "claude",
  path: ".claude/agents/reviewer.md",
  name: "reviewer",
  hash: H(REV1),
  description: "Reviews code",
  model: "sonnet",
  tools: ["Read", "Grep"],
  rules: ["r.alpha", "r.beta"],
};
const DOC_REPORT = { repo: ALPHA.id, kind: "opencode", path: ".opencode/agent/doc.md", name: "doc", hash: H(DOC), description: "Writes docs" };

describe("RL-5 AC-04 scanAgents", () => {
  it("test_AC04_scan_two_reports", async () => {
    const A = checkoutA(tmp());
    const got = await scan([{ dir: A, repo: ALPHA }]);
    expect(got).toStrictEqual([REVIEWER, DOC_REPORT]);
    expect("tools" in got[1]).toBe(false);
    // The oracle and the code agree.
    expect(H(REV1)).toBe(agentFileHash(REV1));
    expect(H(REV1)).not.toBe(sha(REV1));
  });

  it("test_AC04_skips_and_first_wins", async () => {
    const root = tmp();
    const A = checkoutA(root);
    const second = fakeCheckout(join(root, "alpha2"), "https://git.example.com/team/alpha.git");
    put(second, ".claude/agents/extra.md", EXTRA);
    const noRemote = fakeCheckout(join(root, "loose"));
    put(noRemote, ".claude/agents/loose.md", EXTRA);
    const local = fakeCheckout(join(root, "localrepo"));
    put(local, ".claude/agents/local.md", EXTRA);
    const cs: Checkout[] = [
      { dir: A, repo: ALPHA },
      { dir: second, repo: ALPHA },
      { dir: noRemote, repo: undefined },
      { dir: local, repo: { id: "local/localrepo", name: "localrepo" } },
    ];
    expect(await scan(cs)).toStrictEqual([REVIEWER, DOC_REPORT]);
    // Control: the second checkout first wins with its own agent.
    const rev = await scan([{ dir: second, repo: ALPHA }, { dir: A, repo: ALPHA }]);
    expect(rev.map((x) => x.name)).toStrictEqual(["extra"]);
  });

  it("test_AC04_caps_count", async () => {
    const dir = fakeCheckout(join(tmp(), "many"), "https://git.example.com/team/alpha.git");
    for (let i = 0; i <= 2000; i++) put(dir, `.claude/agents/a${String(i).padStart(4, "0")}.md`, `---\ndescription: n${i}\n---\nx\n`);
    const got = await scan([{ dir, repo: ALPHA }]);
    expect(got).toHaveLength(2000);
    expect(got[0].name).toBe("a0000");
    expect(got.at(-1).name).toBe("a1999");
  });

  it("test_AC04_caps_fields", async () => {
    const dir = fakeCheckout(join(tmp(), "caps"), "https://git.example.com/team/alpha.git");
    const tools = Array.from({ length: 150 }, (_, i) => `T${i}`);
    const rules = Array.from({ length: 250 }, (_, i) => `r${i}`);
    put(dir, ".claude/agents/a.md", `---\ndescription: ${"d".repeat(1500)}\ntools: ${tools.join(", ")}\nmesh-rules: [${rules.join(", ")}]\n---\nx\n`);
    put(dir, ".claude/agents/b.md", `---\ndescription: short\nmesh-rules: [ok1, ${"q".repeat(101)}, ok2]\n---\nx\n`);
    const [a, b] = await scan([{ dir, repo: ALPHA }]);
    expect(a.description).toBe("d".repeat(1000));
    expect(a.tools).toStrictEqual(tools.slice(0, 100));
    expect(a.rules).toStrictEqual(rules.slice(0, 200));
    expect(b.rules).toStrictEqual(["ok1", "ok2"]);
  });

  it("test_AC04_pins", async () => {
    const A = checkoutA(tmp());
    const lock = {
      version: 1,
      agents: [
        { name: "doc", source: SRC, commit: C1, hash: H(DOC) },
        { name: "ghost", source: SRC, commit: C1, hash: H("g") },
        { name: "reviewer", source: SRC, commit: C1, hash: H(REV1) },
      ],
    };
    put(A, ".mesh/agents.lock", `${JSON.stringify(lock, null, 2)}\n`);
    const got = await scan([{ dir: A, repo: ALPHA }]);
    expect(got.map((x) => x.name)).toStrictEqual(["reviewer", "doc"]);
    expect(got[0].pin).toStrictEqual({ source: SRC, commit: C1, hash: H(REV1) });
    // Kind opencode never gets a pin.
    expect("pin" in got[1]).toBe(false);
    // An invalid lock gives no pins (the reports stay).
    put(A, ".mesh/agents.lock", JSON.stringify({ ...lock, version: 2 }));
    const bad = await scan([{ dir: A, repo: ALPHA }]);
    expect(bad.map((x) => x.name)).toStrictEqual(["reviewer", "doc"]);
    for (const x of bad) expect("pin" in x, x.name).toBe(false);
  });
});
