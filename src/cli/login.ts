// `mesh login`: hub-mediated login (plan §4.4). The CLI never talks to the identity provider.

import { createServer } from "node:http";
import { hostname as osHostname } from "node:os";
import { pkceChallenge, pkceVerifier } from "../auth/index.ts";
import { run, type Runner } from "../claude/index.ts";
import type { LoginResult, ProviderInfo } from "../protocol/index.ts";
import type { Io } from "./context.ts";
import { HubCallError, hubFetch } from "./hub-client.ts";

export interface LoginOptions {
  hub: string;
  provider?: string | undefined;
  token?: string | undefined;
  device?: boolean;
  noBrowser?: boolean;
  /**
   * The browser may run on another machine (a remote shell): don't open one, and take the
   * one-time code (or the address the browser ended on) pasted into the terminal.
   */
  paste?: boolean;
  /** Read one line; resolves "" if `signal` aborts first (paste mode). */
  readLine?: (prompt: string, signal: AbortSignal) => Promise<string>;
  io: Io;
  runner?: Runner;
  /** Read a line from the user (token prompt). */
  ask?: (question: string) => Promise<string>;
  hostname?: string;
  /** Called with the URL a person must open (tests use it to drive the browser part). */
  onBrowserUrl?: (url: string) => void;
}

export async function providers(hub: string): Promise<ProviderInfo[]> {
  return (await hubFetch<{ providers: ProviderInfo[] }>(hub, "GET", "/auth/providers")).json.providers;
}

/** Is this a shell on another machine, where a browser can't reach this machine's localhost? */
export function isRemoteShell(env: Record<string, string | undefined>): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);
}

/**
 * The one-time code from what a person pasted: the code itself, or the whole address the browser
 * ended on (http://127.0.0.1:<port>/callback?code=…, which a remote shell's browser can't open).
 */
export function pastedCode(input: string): string | undefined {
  const text = input.trim().replace(/^["']|["']$/g, "");
  if (!text) return undefined;
  if (/^https?:\/\//i.test(text) || text.includes("code=")) {
    try {
      return new URL(text, "http://127.0.0.1").searchParams.get("code") ?? undefined;
    } catch {
      return undefined;
    }
  }
  return /^[A-Za-z0-9_-]{8,}$/.test(text) ? text : undefined;
}

async function openBrowser(url: string, runner: Runner): Promise<boolean> {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  return (await runner(cmd, args, { timeoutMs: 10_000 })).code === 0;
}

/** Redirect flow: a one-shot localhost listener receives the hub's one-time code. */
async function browserLogin(o: LoginOptions, providerId: string): Promise<LoginResult> {
  const verifier = pkceVerifier();
  const host = o.hostname ?? osHostname();
  let resolveCode: (code: string) => void = () => undefined;
  let rejectCode: (e: Error) => void = () => undefined;
  const codeP = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const code = url.searchParams.get("code");
    if (url.pathname !== "/callback" || !code) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<p>mesh: you are logged in. You can close this tab.</p>");
    resolveCode(code);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  const timer = setTimeout(() => rejectCode(new Error("timed out waiting for the browser login (5 min)")), 5 * 60_000);
  try {
    // Paste mode only when a line can be read (no terminal: the listener, e.g. a forwarded port).
    // cli_port stays in paste mode: a hub older than paste mode ignores cli_mode and redirects to
    // the listener, which then works with port forwarding, or by pasting the address it ended on.
    const url = `${o.hub.replace(/\/+$/, "")}/auth/${encodeURIComponent(providerId)}/start?client=cli&cli_port=${port}&cli_challenge=${pkceChallenge(verifier)}${o.paste && o.readLine ? "&cli_mode=paste" : ""}&hostname=${encodeURIComponent(host)}`;
    o.onBrowserUrl?.(url);
    if (o.paste && o.readLine) {
      o.io.out(`Open this URL in a browser (on any machine) and sign in:\n  ${url}\n`);
      const stop = new AbortController();
      const pasted = (async () => {
        for (;;) {
          const line = await o.readLine?.("Then paste the code the page shows (or the whole address your browser ended on): ", stop.signal);
          if (stop.signal.aborted) return new Promise<string>(() => undefined);
          if (!line?.trim()) continue;
          const code = pastedCode(line);
          if (code) return code;
          o.io.err("That isn't a login code or an address with code=… in it; try again.");
        }
      })();
      try {
        const code = await Promise.race([codeP, pasted]);
        return await exchange(o, code, verifier, host);
      } finally {
        stop.abort();
      }
    }
    const opened = o.noBrowser || o.paste ? false : await openBrowser(url, o.runner ?? run);
    o.io.out(opened ? "Opened your browser to log in. Waiting…" : `Open this URL to log in:\n  ${url}`);
    return await exchange(o, await codeP, verifier, host);
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

async function exchange(o: LoginOptions, code: string, verifier: string, host: string): Promise<LoginResult> {
  try {
    return (await hubFetch<LoginResult>(o.hub, "POST", "/auth/cli/exchange", { body: { code, verifier, hostname: host } })).json;
  } catch (e) {
    if (e instanceof HubCallError && e.status === 401) throw new Error("the hub did not accept that code (it works once, for 5 minutes); run mesh login again", { cause: e });
    throw e;
  }
}

async function deviceLogin(o: LoginOptions, providerId: string): Promise<LoginResult> {
  const host = o.hostname ?? osHostname();
  const start = (await hubFetch<{ userCode: string; verifyUrl: string; verifyUrlComplete?: string; pollId: string; interval: number; expiresIn: number }>(o.hub, "POST", `/auth/${encodeURIComponent(providerId)}/device`, { body: { hostname: host } })).json;
  o.io.out(`To log in, open ${start.verifyUrlComplete ?? start.verifyUrl}\nand enter the code: ${start.userCode}`);
  o.onBrowserUrl?.(start.userCode);
  const deadline = Date.now() + start.expiresIn * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.max(1, start.interval) * 1000));
    const r = await hubFetch<LoginResult | { pending: true }>(o.hub, "POST", `/auth/${encodeURIComponent(providerId)}/device/poll`, { body: { pollId: start.pollId, hostname: host } });
    if (r.status === 200) return r.json as LoginResult;
  }
  throw new Error("the device login expired; try again");
}

export async function login(o: LoginOptions): Promise<LoginResult> {
  const list = await providers(o.hub);
  if (list.length === 0) throw new Error("the hub has no login providers configured");
  let p = o.provider ? list.find((x) => x.id === o.provider) : list.length === 1 ? list[0] : undefined;
  if (!p && o.token) p = list.find((x) => x.flows.includes("token"));
  if (!p) {
    throw new Error(`pick a provider with --provider: ${list.map((x) => `${x.id} (${x.label})`).join(", ")}`);
  }
  const host = o.hostname ?? osHostname();
  if (p.flows.includes("none")) {
    return (await hubFetch<LoginResult>(o.hub, "POST", `/auth/${encodeURIComponent(p.id)}/login`, { body: { hostname: host } })).json;
  }
  if (p.flows.includes("token")) {
    const token = o.token ?? (o.ask ? (await o.ask(`Token for ${p.label}: `)).trim() : undefined);
    if (!token) throw new Error("a token is required (--token)");
    try {
      return (await hubFetch<LoginResult>(o.hub, "POST", `/auth/${encodeURIComponent(p.id)}/login`, { body: { token, hostname: host } })).json;
    } catch (e) {
      if (e instanceof HubCallError && e.status === 401) throw new Error("the hub did not accept that token", { cause: e });
      throw e;
    }
  }
  if (o.device && p.flows.includes("device")) return deviceLogin(o, p.id);
  if (p.flows.includes("redirect")) return browserLogin(o, p.id);
  if (p.flows.includes("device")) return deviceLogin(o, p.id);
  throw new Error(`provider ${p.id} offers no flow this CLI supports`);
}
