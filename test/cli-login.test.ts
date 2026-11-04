// `mesh login` against a real hub: token, OIDC browser (hub-mediated, CLI PKCE) and device flows.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256 } from "../src/auth/index.ts";
import { login } from "../src/cli/login.ts";
import { hubCommands } from "../src/cli/hub-commands.ts";
import type { CliEnv } from "../src/cli/context.ts";
import { buildHubConfig, startHub, type RunningHub } from "../src/hub/index.ts";
import { resolvePaths } from "../src/protocol/index.ts";
import { HubStore } from "../src/store/index.ts";
import { MockOidc } from "./fixtures/mock-oidc.ts";

const mock = new MockOidc();
let hub: RunningHub;
const io = { out: () => undefined, err: () => undefined };

beforeAll(async () => {
  await mock.start();
  const config = buildHubConfig(
    {
      listen: "127.0.0.1:0",
      db: ":memory:",
      auth: {
        providers: [
          { id: "team", kind: "token", users: [{ name: "alice", token_sha256: sha256("alice-token") }] },
          { id: "kanidm", kind: "oidc", preset: "kanidm", issuer: mock.issuer, client_id: "mesh", allow_insecure: true },
        ],
      },
    },
    { baseDir: "/", env: {} },
  );
  hub = await startHub(config, { store: await HubStore.open(":memory:"), tickMs: 0 });
});
afterAll(async () => {
  await hub.stop();
  await mock.stop();
});

describe("mesh login", () => {
  it("logs in with a token", async () => {
    const r = await login({ hub: hub.url, token: "alice-token", io, hostname: "dev-01" });
    expect(r.user.id).toBe("alice");
  });

  it("asks which provider when there are several and no hint", async () => {
    await expect(login({ hub: hub.url, io })).rejects.toThrow(/--provider: team \(Token\), kanidm \(Kanidm\)/);
  });

  it("runs the browser flow through the hub to the CLI's localhost listener", async () => {
    const r = await login({
      hub: hub.url,
      provider: "kanidm",
      io,
      noBrowser: true,
      hostname: "dev-01",
      // Play the browser: follow the redirects until the CLI's localhost callback.
      onBrowserUrl: (url) => {
        void (async () => {
          let next = url;
          for (let i = 0; i < 5; i++) {
            const res = await fetch(next, { redirect: "manual" });
            const loc = res.headers.get("location");
            if (!loc) break;
            next = new URL(loc, next).href;
          }
        })();
      },
    });
    expect(r.user).toMatchObject({ id: "alice-2", roles: ["member"] });
    expect(r.token).toMatch(/^mh_d_/);
  });

  it("runs the device flow", async () => {
    const r = await login({ hub: hub.url, provider: "kanidm", device: true, io, onBrowserUrl: (code) => void setTimeout(() => mock.approveDevice(code), 50) });
    expect(r.token).toMatch(/^mh_d_/);
  });

  it("saves private credentials with `mesh login` and clears them with `mesh logout`", async () => {
    const root = mkdtempSync(join(tmpdir(), "mesh-login-"));
    try {
      const paths = resolvePaths({ MESH_CONFIG_DIR: join(root, "cfg"), MESH_STATE_DIR: join(root, "st"), CLAUDE_CONFIG_DIR: join(root, "cl") }, root);
      const out: string[] = [];
      const c: CliEnv = { io: { out: (t) => out.push(t), err: (t) => out.push(t) }, paths, env: {}, cwd: root, self: ["mesh"], version: "0" };
      const cmd = (n: string) => hubCommands(c).find((x) => x.name === n) as { run(a: string[]): Promise<number> };
      expect(await cmd("login").run(["--hub", hub.url, "--provider", "team", "--token", "alice-token"])).toBe(0);
      const creds = JSON.parse(readFileSync(paths.credentials, "utf8"));
      expect(creds).toMatchObject({ hub: hub.url, user: { id: "alice" } });
      expect(await cmd("whoami").run([])).toBe(0);
      expect(out.join("\n")).toContain("alice (alice)");
      expect(await cmd("goal").run(["new", "IPv6", "underlay"])).toBe(0);
      expect(await cmd("goal").run(["ls"])).toBe(0);
      expect(out.join("\n")).toMatch(/G1\s+backlog/);
      expect(await cmd("logout").run([])).toBe(0);
      expect(await cmd("whoami").run([]).catch((e: Error) => e.message)).toContain("not logged in");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
