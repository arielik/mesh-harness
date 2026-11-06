import { describe, expect, it } from "vitest";
import { Tokens } from "../src/auth/index.ts";
import { HubStore } from "../src/store/index.ts";

const H = 3_600_000;
const D = 24 * H;

async function setup() {
  const store = await HubStore.open(":memory:");
  const user = await store.upsertIdentity({ provider: "p", subject: "alice", name: "alice", groups: [] }, 0);
  return { store, user, tokens: new Tokens(store) };
}

describe("hub tokens (plan §4.3)", () => {
  it("are opaque, prefixed by kind, and stored only as hashes", async () => {
    const { store, user, tokens } = await setup();
    const t = await tokens.issue("device", user.id, 0, { machineId: "m-1" });
    expect(t.token).toMatch(/^mh_d_[A-Za-z0-9_-]{40,}$/);
    expect(JSON.stringify(await store.db.all("SELECT * FROM token"))).not.toContain(t.token);
    expect(await tokens.verify(t.token, 1)).toMatchObject({ userId: "alice", kind: "device", machineId: "m-1" });
  });

  it("slide the idle window but stop at the absolute lifetime", async () => {
    const { user, tokens } = await setup();
    const t = await tokens.issue("device", user.id, 0);
    for (let day = 6; day <= 13; day += 6) expect(await tokens.verify(t.token, day * D)).toBeDefined();
    expect(await tokens.verify(t.token, 14 * D + 1)).toBeUndefined();
  });

  it("expire web sessions after 12 h idle", async () => {
    const { user, tokens } = await setup();
    const t = await tokens.issue("web", user.id, 0);
    expect(await tokens.verify(t.token, 11 * H)).toBeDefined();
    expect(await tokens.verify(t.token, 11 * H + 12 * H + 1)).toBeUndefined();
  });

  it("can be revoked, and reject garbage", async () => {
    const { store, user, tokens } = await setup();
    const a = await tokens.issue("device", user.id, 0, { machineId: "m-1" });
    const b = await tokens.issue("device", user.id, 0, { machineId: "m-2" });
    await tokens.revoke(a.token);
    expect(await tokens.verify(a.token, 1)).toBeUndefined();
    expect(await store.revokeTokens({ machineId: "m-2" })).toBe(1);
    expect(await tokens.verify(b.token, 1)).toBeUndefined();
    expect(await tokens.verify("mh_d_short", 1)).toBeUndefined();
    expect(await tokens.verify("not-a-token", 1)).toBeUndefined();
  });
});
