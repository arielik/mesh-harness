// `mesh login` against a real hub: token, OIDC browser (hub-mediated, CLI PKCE) and device flows.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256 } from "../src/auth/index.ts";
import { isRemoteShell, login, pastedCode } from "../src/cli/login.ts";
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

  /** Play the browser: follow redirects from `url`; return the final response's body (the paste page). */
  async function browse(url: string): Promise<string> {
    let next = url;
    for (let i = 0; i < 6; i++) {
      const res = await fetch(next, { redirect: "manual" });
      const loc = res.headers.get("location");
      if (!loc) return await res.text();
      next = new URL(loc, next).href;
    }
    throw new Error("too many redirects");
  }

  it("over SSH: the hub shows a one-time code and the person pastes it into the terminal", async () => {
    let page: Promise<string> | undefined;
    const prompts: string[] = [];
    const r = await login({
      hub: hub.url,
      provider: "kanidm",
      io,
      paste: true,
      hostname: "remote-01",
      onBrowserUrl: (url) => {
        expect(url).toContain("cli_mode=paste");
        page = browse(url);
      },
      readLine: async (prompt) => {
        prompts.push(prompt);
        if (prompts.length === 1) return "not a code";
        const html = await (page as Promise<string>);
        const code = /<code id="code">([^<]+)<\/code>/.exec(html)?.[1];
        expect(code).toBeTruthy();
        return `  ${code}  `;
      },
    });
    expect(r.user).toMatchObject({ id: "alice-2" });
    expect(r.token).toMatch(/^mh_d_/);
    expect(prompts).toHaveLength(2);
  });

  it("a pasted code works once", async () => {
    let page: Promise<string> | undefined;
    let code = "";
    await login({
      hub: hub.url,
      provider: "kanidm",
      io,
      paste: true,
      onBrowserUrl: (url) => void (page = browse(url)),
      readLine: async () => (code = /<code id="code">([^<]+)<\/code>/.exec(await (page as Promise<string>))?.[1] ?? ""),
    });
    const again = await fetch(`${hub.url}/auth/cli/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, verifier: "x".repeat(43) }) });
    expect(again.status).toBe(401);
  });

  it("the hub needs a port or paste mode for a CLI login", async () => {
    const base = `${hub.url}/auth/kanidm/start?client=cli&cli_challenge=${"c".repeat(43)}`;
    expect((await fetch(base, { redirect: "manual" })).status).toBe(400);
    expect((await fetch(`${base}&cli_mode=paste`, { redirect: "manual" })).status).toBe(302);
  });

  it("reads the code from what was pasted", () => {
    expect(pastedCode("AbCdEf0123456789_-xyz")).toBe("AbCdEf0123456789_-xyz");
    expect(pastedCode(" 'http://127.0.0.1:43117/callback?code=Zz9_8-7yYxXwWvV' ")).toBe("Zz9_8-7yYxXwWvV");
    expect(pastedCode("127.0.0.1:43117/callback?code=Qq1234567890")).toBe("Qq1234567890");
    expect(pastedCode("")).toBeUndefined();
    expect(pastedCode("hello world")).toBeUndefined();
    expect(pastedCode("http://127.0.0.1:1/callback")).toBeUndefined();
  });

  it("in redirect mode, a pasted 127.0.0.1 address still finishes the login", async () => {
    let landed: Promise<string> | undefined;
    const r = await login({
      hub: hub.url,
      provider: "kanidm",
      io,
      noBrowser: true,
      // The browser follows the redirects but stops at the CLI's localhost (it's on another machine).
      onBrowserUrl: (url) => {
        landed = (async () => {
          let next = url;
          for (let i = 0; i < 6; i++) {
            const res = await fetch(next, { redirect: "manual" });
            const loc = res.headers.get("location");
            if (!loc) break;
            next = new URL(loc, next).href;
            // The CLI's listener (the hub and the mock IdP are on 127.0.0.1 too, at other paths).
            if (new URL(next).pathname === "/callback") return next;
          }
          throw new Error("no localhost redirect");
        })();
      },
      readLine: async () => (await (landed as Promise<string>)).replace(/^http:\/\//, ""),
    });
    expect(r.token).toMatch(/^mh_d_/);
  });

  it("knows a remote shell", () => {
    expect(isRemoteShell({ SSH_CONNECTION: "10.0.0.2 51000 10.0.0.1 22" }, "darwin")).toBe(true);
    expect(isRemoteShell({ SSH_TTY: "/dev/pts/3" }, "linux")).toBe(true);
    // `sudo -iu other` inside an SSH login: no SSH variables, and no display on Linux.
    expect(isRemoteShell({}, "linux")).toBe(true);
    expect(isRemoteShell({ DISPLAY: ":0" }, "linux")).toBe(false);
    expect(isRemoteShell({ WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBe(false);
    expect(isRemoteShell({}, "darwin")).toBe(false);
  });

  it("`mesh login` over SSH pastes instead of opening a browser", async () => {
    const root = mkdtempSync(join(tmpdir(), "mesh-login-ssh-"));
    try {
      const paths = resolvePaths({ MESH_CONFIG_DIR: join(root, "cfg"), MESH_STATE_DIR: join(root, "st"), CLAUDE_CONFIG_DIR: join(root, "cl") }, root);
      const out: string[] = [];
      let opened = false;
      const c: CliEnv = {
        io: { out: (t) => out.push(t), err: (t) => out.push(t) },
        paths,
        env: { SSH_CONNECTION: "10.0.0.2 51000 10.0.0.1 22" },
        cwd: root,
        self: ["mesh"],
        version: "0",
        runner: async () => {
          opened = true;
          return { code: 0, stdout: "", stderr: "" };
        },
        readLine: async () => {
          const url = /(http\S+\/auth\/kanidm\/start\S+)/.exec(out.join("\n"))?.[1] as string;
          return /<code id="code">([^<]+)<\/code>/.exec(await browse(url))?.[1] ?? "";
        },
      };
      const cmd = hubCommands(c).find((x) => x.name === "login") as { run(a: string[]): Promise<number> };
      expect(await cmd.run(["--hub", hub.url, "--provider", "kanidm"])).toBe(0);
      expect(opened).toBe(false);
      expect(JSON.parse(readFileSync(paths.credentials, "utf8"))).toMatchObject({ user: { id: "alice-2" } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
