// mesh-ai B-178: a service token manages a person's pulses and profiles (x-mesh-on-behalf-of).
// H1 scopes pulses:write and profiles:write; H2 act for a person (owner, event user and via);
// H3 only the person's own machines; H4 the person's fleet with machines[].owner; H5 profile save.
// Each with its refused cases.

import { afterEach, describe, expect, it } from "vitest";
import { body, Pk, type Bare, type Json } from "./helpers/pulse-kit.ts";

const H = "x-mesh-on-behalf-of";
const PROFILE = "description: test\nallow:\n  - Read\n";

let k: Pk;
afterEach(async () => {
  await k?.stop();
});

interface Svc {
  writer: string;
  reader: string;
  m: Bare;
}
async function start(): Promise<Svc> {
  k = await Pk.start();
  const writer = await k.w.hub.svc.serviceToken("mesh-ai", ["goals:read", "live:read", "pulses:write", "profiles:write"]);
  const reader = await k.w.hub.svc.serviceToken("viewer", ["goals:read", "goals:write", "live:read"]);
  const m = await k.bare("ann", "ann-box");
  return { writer, reader, m };
}
const as = (token: string, method: "GET" | "POST", path: string, b?: unknown, user?: string) => k.w.call(token, method, path, b, user === undefined ? {} : { [H]: user });

describe("H1 scopes", () => {
  it("a service token without pulses:write or profiles:write is refused; members need no scope", async () => {
    const s = await start();
    expect((await as(s.reader, "POST", "/v1/pulses", body({ target: { machines: [s.m.machine] } }), "ann")).status).toBe(403);
    expect((await as(s.reader, "POST", "/v1/profiles", { name: "p1", text: PROFILE }, "ann")).status).toBe(403);
    expect((await k.pulse("ann", body())).status).toBe(201);
    expect((await k.call("ann", "POST", "/v1/profiles", { name: "p1", text: PROFILE })).status).toBe(201);
  });
});

describe("H2 act for a person", () => {
  it("creates a pulse owned by the person; events carry the person and via", async () => {
    const s = await start();
    const res = await as(s.writer, "POST", "/v1/pulses", body({ target: { machines: [s.m.machine] } }), "ann");
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const id = res.json.id as string;
    expect(res.json.owner).toBe("ann");
    const [created] = await k.pulseEvents("pulse.created", id);
    expect(created?.user).toBe("ann");
    expect(created?.payload?.via).toBe("mesh-ai");

    for (const verb of ["pause", "resume"] as const) {
      const r = await as(s.writer, "POST", `/v1/pulses/${id}/${verb}`, {}, "ann");
      expect(r.status, `${verb} ${JSON.stringify(r.json)}`).toBe(200);
      const [e] = await k.pulseEvents(`pulse.${verb}d`, id);
      expect([e?.user, e?.payload?.via]).toStrictEqual(["ann", "mesh-ai"]);
    }
    const u = await as(s.writer, "POST", `/v1/pulses/${id}/update`, { title: "renamed" }, "ann");
    expect(u.status, JSON.stringify(u.json)).toBe(200);
    expect((await k.pulseEvents("pulse.updated", id))[0]?.payload?.via).toBe("mesh-ai");
    const f = await as(s.writer, "POST", `/v1/pulses/${id}/fire`, {}, "ann");
    expect(f.status, JSON.stringify(f.json)).toBe(201);
    expect(f.json.slot.by).toBe("ann");
    const fired = await k.pulseEvents("pulse.fired", id);
    expect([fired[0]?.user, fired[0]?.payload?.via]).toStrictEqual(["ann", "mesh-ai"]);
    const d = await as(s.writer, "POST", `/v1/pulses/${id}/delete`, {}, "ann");
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    expect((await k.pulseEvents("pulse.deleted", id))[0]?.payload?.via).toBe("mesh-ai");
  });

  it("refuses a service write without the header, an unknown user, a service account and another person's pulse", async () => {
    const s = await start();
    const b = body({ target: { machines: [s.m.machine] } });
    expect(await as(s.writer, "POST", "/v1/pulses", b)).toMatchObject({ status: 400, json: { error: expect.stringMatching(/^on-behalf-of required/) } });
    expect(await as(s.writer, "POST", "/v1/profiles", { name: "p1", text: PROFILE })).toMatchObject({ status: 400, json: { error: expect.stringMatching(/^on-behalf-of required/) } });
    expect(await as(s.writer, "POST", "/v1/pulses", b, "nobody")).toMatchObject({ status: 403, json: { error: 'unknown user "nobody"' } });
    expect(await as(s.writer, "POST", "/v1/pulses", b, "viewer")).toMatchObject({ status: 403, json: { error: 'unknown user "viewer"' } });
    expect(await as(s.writer, "POST", "/v1/pulses", b, "")).toMatchObject({ status: 403 });
    // bob's own pulse: the service acting for ann may not change it (ann is not its owner).
    const bobs = await k.pulseOk("bob", body());
    expect(await as(s.writer, "POST", `/v1/pulses/${bobs.id}/pause`, {}, "ann")).toMatchObject({ status: 403, json: { error: `only @bob or an admin can change pulse ${bobs.id}` } });
    // Acting for an admin gives member rights only.
    expect((await as(s.writer, "POST", `/v1/pulses/${bobs.id}/pause`, {}, "carol")).status).toBe(403);
    expect((await k.pulseOf(bobs.id as string)).enabled).toBe(true);
  });

  it("a member sending the header is refused with 403; the header on another route is refused with 400", async () => {
    const s = await start();
    expect(await k.w.call(k.tok.ann, "POST", "/v1/pulses", body(), { [H]: "bob" })).toMatchObject({ status: 403, json: { error: "on-behalf-of is for service tokens only" } });
    expect(await k.w.call(k.tok.ann, "GET", "/v1/fleet", undefined, { [H]: "bob" })).toMatchObject({ status: 403 });
    expect(await as(s.writer, "GET", "/v1/pulses?mine=1", undefined, "ann")).toMatchObject({ status: 400, json: { error: "on-behalf-of is not accepted on this route" } });
  });

  it("idempotent retries are kept per service and person", async () => {
    const s = await start();
    const b = body({ target: { machines: [s.m.machine] } });
    const one = await k.w.call(s.writer, "POST", "/v1/pulses", b, { [H]: "ann", "idempotency-key": "k1" });
    const two = await k.w.call(s.writer, "POST", "/v1/pulses", b, { [H]: "ann", "idempotency-key": "k1" });
    expect(one.status).toBe(201);
    expect(two.json.id).toBe(one.json.id);
  });
});

describe("H3 the person's own machines", () => {
  it("accepts the person's machine by id or nickname; refuses another person's, an unknown one, labels only and an empty target", async () => {
    const s = await start();
    const bobBox = await k.bare("bob", "bob-box");
    expect((await k.call("ann", "POST", `/v1/machines/${s.m.machine}/name`, { nickname: "box" })).status).toBe(200);
    expect((await as(s.writer, "POST", "/v1/pulses", body({ target: { machines: ["box"] } }), "ann")).status).toBe(201);
    expect((await as(s.writer, "POST", "/v1/pulses", body({ target: { machines: ["ann/box"], labels: ["gpu"] } }), "ann")).status).toBe(201);
    expect(await as(s.writer, "POST", "/v1/pulses", body({ target: { machines: [s.m.machine, bobBox.machine] } }), "ann")).toMatchObject({ status: 403, json: { error: `machine not yours: ${bobBox.machine}` } });
    expect(await as(s.writer, "POST", "/v1/pulses", body({ target: { machines: ["m-nope"] } }), "ann")).toMatchObject({ status: 403, json: { error: "machine not yours: m-nope" } });
    expect(await as(s.writer, "POST", "/v1/pulses", body({ target: { labels: ["gpu"] } }), "ann")).toMatchObject({ status: 400, json: { error: expect.stringMatching(/^target.machines required/) } });
    expect(await as(s.writer, "POST", "/v1/pulses", body(), "ann")).toMatchObject({ status: 400, json: { error: expect.stringMatching(/^target.machines required/) } });
  });

  it("an update for a person checks the resulting target", async () => {
    const s = await start();
    const bobBox = await k.bare("bob", "bob-box");
    const p = await as(s.writer, "POST", "/v1/pulses", body({ target: { machines: [s.m.machine] } }), "ann");
    const id = p.json.id as string;
    expect(await as(s.writer, "POST", `/v1/pulses/${id}/update`, { target: { machines: [bobBox.machine] } }, "ann")).toMatchObject({ status: 403, json: { error: `machine not yours: ${bobBox.machine}` } });
    expect((await as(s.writer, "POST", `/v1/pulses/${id}/update`, { target: {} }, "ann")).status).toBe(400);
    // A pulse ann made herself with a labels target: the service may not update it without naming her machines.
    const own = await k.pulseOk("ann", body({ target: { labels: ["gpu"] } }));
    expect((await as(s.writer, "POST", `/v1/pulses/${own.id}/update`, { title: "x" }, "ann")).status).toBe(400);
    expect((await as(s.writer, "POST", `/v1/pulses/${own.id}/pause`, {}, "ann")).status).toBe(200);
    expect((await k.pulseOf(id)).target).toStrictEqual({ machines: [s.m.machine] });
  });
});

describe("H4 fleet for a person", () => {
  it("answers the person's machines with owner; without the header the service's own (none)", async () => {
    const s = await start();
    await k.bare("bob", "bob-box");
    const f = await as(s.writer, "GET", "/v1/fleet", undefined, "ann");
    expect(f.status, JSON.stringify(f.json)).toBe(200);
    expect(f.json.user.id).toBe("ann");
    const ids = (f.json.machines as Json[]).map((m) => m.id);
    expect(ids).toContain(s.m.machine);
    expect((f.json.machines as Json[]).every((m) => m.owner === "ann")).toBe(true);
    expect((await as(s.writer, "GET", "/v1/fleet")).json.machines).toStrictEqual([]);
    const mine = await k.call("ann", "GET", "/v1/fleet");
    expect((mine.json.machines as Json[]).every((m) => m.owner === "ann")).toBe(true);
    expect((await as(s.writer, "GET", "/v1/fleet", undefined, "nobody")).status).toBe(403);
  });
});

describe("H5 profile save for a person", () => {
  it("saves under the person; another person's profile stays theirs", async () => {
    const s = await start();
    const r = await as(s.writer, "POST", "/v1/profiles", { name: "p1", text: PROFILE }, "ann");
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(keys(r.json)).toEqual(expect.arrayContaining(["name", "sha256"]));
    const ev = (await k.r.allEvents()).filter((e) => e.type === "profile.saved" && e.payload?.name === "p1");
    expect([ev[0]?.user, ev[0]?.payload?.via]).toStrictEqual(["ann", "mesh-ai"]);
    expect((await k.call("bob", "POST", "/v1/profiles", { name: "p2", text: PROFILE })).status).toBe(201);
    expect(await as(s.writer, "POST", "/v1/profiles", { name: "p2", text: PROFILE }, "ann")).toMatchObject({ status: 403 });
    expect((await as(s.writer, "POST", "/v1/profiles", { name: "p1", text: `${PROFILE}  - Grep\n` }, "ann")).status).toBe(200);
  });
});

const keys = (o: Json) => Object.keys(o ?? {});
