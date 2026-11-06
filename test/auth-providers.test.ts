// Provider contract suite (plan §4.2, task 2.1/2.8): every provider must pass the same checks.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthError, NoneProvider, OidcProvider, pkceChallenge, pkceVerifier, sha256, TokenProvider, type AuthProvider, type Identity } from "../src/auth/index.ts";
import { MockOidc } from "./fixtures/mock-oidc.ts";

interface Case {
  name: string;
  make(): AuthProvider;
  /** Perform a successful login and return the identity. */
  login(p: AuthProvider): Promise<Identity>;
  /** Perform a login that must fail. */
  bad(p: AuthProvider): Promise<unknown>;
}

const mock = new MockOidc();
beforeAll(() => mock.start());
afterAll(() => mock.stop());

const oidc = () =>
  new OidcProvider({ id: "kanidm", issuer: mock.issuer, clientId: "mesh", scopes: ["openid", "groups"], groupsClaim: "groups", groupNormalize: ["strip_domain"], allowInsecure: true });

/** Follow the mock's authorize redirect like a browser would. */
async function browserLogin(p: AuthProvider, tamper = false): Promise<Identity> {
  const verifier = pkceVerifier();
  const ctx = { state: "st-1", nonce: "n-1", pkceChallenge: pkceChallenge(verifier), redirectUri: "http://127.0.0.1:1/cb" };
  const start = await p.start("redirect", ctx);
  if (start.kind !== "redirect") throw new Error("expected redirect");
  const res = await fetch(start.url, { redirect: "manual" });
  const callbackUrl = res.headers.get("location") as string;
  const r = await p.complete({ flow: "redirect", callbackUrl, pkceVerifier: tamper ? pkceVerifier() : verifier, state: ctx.state, nonce: ctx.nonce, redirectUri: ctx.redirectUri });
  if (r === "pending") throw new Error("unexpected pending");
  return r;
}

const cases: Case[] = [
  {
    name: "none",
    make: () => new NoneProvider(),
    login: async (p) => (await p.complete({ flow: "none" })) as Identity,
    bad: (p) => p.complete({ flow: "token", token: "x" }),
  },
  {
    name: "token",
    make: () => new TokenProvider("ci", [{ name: "mesh-ai", token_sha256: sha256("s3cret-token"), groups: ["service"] }]),
    login: async (p) => (await p.complete({ flow: "token", token: "s3cret-token" })) as Identity,
    bad: (p) => p.complete({ flow: "token", token: "wrong" }),
  },
  {
    name: "oidc (mock issuer)",
    make: oidc,
    login: (p) => browserLogin(p),
    bad: (p) => browserLogin(p, true),
  },
];

describe.each(cases)("provider contract: $name", (c) => {
  it("declares flows and a label", () => {
    const p = c.make();
    expect(p.flows().length).toBeGreaterThan(0);
    expect(p.label).toBeTruthy();
    expect(p.id).toBeTruthy();
  });

  it("returns an identity with provider, subject and groups", async () => {
    const p = c.make();
    const id = await c.login(p);
    expect(id.provider).toBe(p.id);
    expect(id.subject).toBeTruthy();
    expect(Array.isArray(id.groups)).toBe(true);
  });

  it("is stable: the same login gives the same subject", async () => {
    const p = c.make();
    expect((await c.login(p)).subject).toBe((await c.login(p)).subject);
  });

  it("rejects a bad login with an AuthError", async () => {
    await expect(c.bad(c.make())).rejects.toBeInstanceOf(AuthError);
  });
});

describe("oidc specifics", () => {
  it("normalizes Kanidm SPN groups", async () => {
    const id = await browserLogin(oidc());
    expect(id).toMatchObject({ subject: "u-1", name: "alice", email: "alice@lab", groups: ["mesh-approvers"] });
  });

  it("falls back to userinfo for groups", async () => {
    mock.groupsInUserinfo = true;
    try {
      expect((await browserLogin(oidc())).groups).toEqual(["mesh-approvers"]);
    } finally {
      mock.groupsInUserinfo = false;
    }
  });

  it("runs the device flow: pending until approved", async () => {
    const p = oidc();
    const start = await p.start("device", { state: "", nonce: "", pkceChallenge: "", redirectUri: "" });
    if (start.kind !== "device") throw new Error("expected device");
    expect(await p.complete({ flow: "device", pollId: start.pollId, state: start.state })).toBe("pending");
    expect(mock.approveDevice(start.userCode)).toBe(true);
    let r: Identity | "pending" = "pending";
    for (let i = 0; i < 40 && r === "pending"; i++) {
      await new Promise((ok) => setTimeout(ok, 150));
      r = await p.complete({ flow: "device", pollId: start.pollId, state: start.state });
    }
    expect(r).toMatchObject({ subject: "u-1" });
  });

  it("keeps no device state itself: another provider instance (another replica) finishes the login", async () => {
    let now = 1_000_000;
    const make = () =>
      new OidcProvider({ id: "kanidm", issuer: mock.issuer, clientId: "mesh", scopes: ["openid"], groupsClaim: "groups", groupNormalize: [], allowInsecure: true }, () => now);
    const start = await make().start("device", { state: "", nonce: "", pkceChallenge: "", redirectUri: "" });
    if (start.kind !== "device") throw new Error("expected device");
    // The state is plain data the hub can store as JSON.
    const saved = JSON.parse(JSON.stringify(start.state)) as Record<string, unknown>;
    mock.approveDevice(start.userCode);
    now += start.interval * 1000;
    expect(await make().complete({ flow: "device", pollId: start.pollId, state: saved })).toMatchObject({ subject: "u-1" });
  });

  it("paces device polls by the issuer's interval and honours slow_down", async () => {
    let now = 1_000_000;
    const p = new OidcProvider({ id: "kanidm", issuer: mock.issuer, clientId: "mesh", scopes: ["openid"], groupsClaim: "groups", groupNormalize: [], allowInsecure: true }, () => now);
    const start = await p.start("device", { state: "", nonce: "", pkceChallenge: "", redirectUri: "" });
    if (start.kind !== "device") throw new Error("expected device");
    const poll = () => p.complete({ flow: "device", pollId: start.pollId, state: start.state });
    const before = mock.deviceTokenRequests;
    // Too early: answered without asking the issuer.
    expect(await poll()).toBe("pending");
    expect(mock.deviceTokenRequests).toBe(before);
    now += 1000;
    mock.slowDownOnce = true;
    expect(await poll()).toBe("pending");
    expect(mock.deviceTokenRequests).toBe(before + 1);
    expect(start.state.interval).toBe(start.interval + 5);
    now += 1000; // the old interval is no longer enough
    expect(await poll()).toBe("pending");
    expect(mock.deviceTokenRequests).toBe(before + 1);
    now += 5000;
    expect(await poll()).toBe("pending");
    expect(mock.deviceTokenRequests).toBe(before + 2);
    // Past expires_in (60 s at the mock): a failed login, not pending forever.
    now += 61_000;
    await expect(poll()).rejects.toThrow(/expired/);
  });

  it("rejects device state it did not create", async () => {
    await expect(oidc().complete({ flow: "device", pollId: "x", state: { deviceCode: 1 } })).rejects.toMatchObject({ status: 404 });
  });

  it("explains a missing device endpoint and an unreachable issuer", async () => {
    mock.device = false;
    try {
      await expect(oidc().start("device", { state: "", nonce: "", pkceChallenge: "", redirectUri: "" })).rejects.toThrow(/device flow/);
    } finally {
      mock.device = true;
    }
    const dead = new OidcProvider({ id: "x", issuer: "http://127.0.0.1:9/", clientId: "c", scopes: ["openid"], groupsClaim: "groups", groupNormalize: [], allowInsecure: true });
    await expect(dead.start("redirect", { state: "s", nonce: "n", pkceChallenge: "c", redirectUri: "http://x/cb" })).rejects.toThrow(/cannot reach/);
  });
});
