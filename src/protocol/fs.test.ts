import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeFileAtomic } from "./fs.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "mesh-fs-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  it("creates folders and leaves no temporary file behind", () => {
    const d = tmp();
    const p = join(d, "a", "b", "c.json");
    writeFileAtomic(p, "{}\n");
    expect(readFileSync(p, "utf8")).toBe("{}\n");
    expect(readdirSync(join(d, "a", "b"))).toEqual(["c.json"]);
  });

  it("sets an explicit mode exactly, and keeps the replaced file's mode otherwise", () => {
    const d = tmp();
    const secret = join(d, "creds.json");
    writeFileAtomic(secret, "x", { mode: 0o600 });
    expect(statSync(secret).mode & 0o777).toBe(0o600);
    const other = join(d, "other");
    writeFileSync(other, "old");
    chmodSync(other, 0o640);
    writeFileAtomic(other, "new");
    expect(statSync(other).mode & 0o777).toBe(0o640);
  });

  it("keeps the previous version when asked, with the same mode", () => {
    const d = tmp();
    const p = join(d, "daemon.json");
    writeFileAtomic(p, "one", { mode: 0o600 });
    writeFileAtomic(p, "two", { mode: 0o600, keepPrevious: true });
    expect(readFileSync(p, "utf8")).toBe("two");
    expect(readFileSync(`${p}.prev`, "utf8")).toBe("one");
    expect(statSync(`${p}.prev`).mode & 0o777).toBe(0o600);
  });
});
