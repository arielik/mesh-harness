// RL-25: an Alertmanager webhook notifies a person's machines (POST /v1/alerts/webhook, scope
// alerts:notify): auth, body, person and recipients, per-episode dedup, reminders, resolve, prune,
// and an older daemon. Written from the spec's contracts (docs/specs/RL-25.md) and the round-2
// review's builder notes (a resolved alert resolves only the episode of its own `startsAt`; the
// late-firing suppression comes before the recipient check).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { sha256 } from "../src/auth/index.ts";
import { HubLink } from "../src/daemon/hub-link.ts";
import { buildHubConfig, startHub, type RunningHub } from "../src/hub/index.ts";
import { DaemonStore, HubStore } from "../src/store/index.ts";
import { PG_URL, PgFixture } from "./helpers/pg.ts";
import { World, type Json } from "./helpers/world.ts";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** 2026-11-16T09:00:00.000Z */
const T0 = Date.UTC(2026, 10, 16, 9);
const iso = (ms: number) => new Date(ms).toISOString();
const START = T0 - 26 * HOUR;
const H = "x-mesh-on-behalf-of";
const URL_PATH = "/v1/alerts/webhook";

let w: World | undefined;
afterEach(async () => {
  await w?.stop();
  w = undefined;
});
const W = (): World => w as World;

interface Cast {
  am: string;
  reader: string;
  /** ann-box: ann's machine seen now (its device token is ann's own token). */
  annBox: { token: string; machine: string };
  /** ann-old: ann's machine last seen 15 days ago. */
  annOld: { token: string; machine: string };
  bobBox: { token: string; machine: string };
  cyOld: { token: string; machine: string };
  root: { token: string; machine: string };
}

async function login(name: string, hostname: string): Promise<{ token: string; machine: string }> {
  const l = await W().login(name, { hostname });
  expect(l.machine, hostname).toBeTruthy();
  return { token: l.token, machine: l.machine as string };
}

async function cast(): Promise<Cast> {
  w = new World();
  await W().start(["ann", "bob", "cy", "root"], { admins: ["root"] });
  W().clock = T0 - 20 * DAY;
  const cyOld = await login("cy", "cy-old");
  W().clock = T0 - 15 * DAY;
  const annOld = await login("ann", "ann-old");
  W().clock = T0;
  const annBox = await login("ann", "ann-box");
  const bobBox = await login("bob", "bob-box");
  const root = await login("root", "root-box");
  const am = await W().hub.svc.serviceToken("am", ["alerts:notify"]);
  const reader = await W().hub.svc.serviceToken("reader", ["goals:read"]);
  return { am, reader, annBox, annOld, bobBox, cyOld, root };
}

interface AlertOpts {
  person?: string | undefined;
  fingerprint?: string;
  status?: "firing" | "resolved";
  startsAt?: number | string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  generatorURL?: string;
}

/** One alert as Alertmanager sends it (default: ann's MeshAttentionWaitingOnPerson, firing). */
function alert(o: AlertOpts = {}): Record<string, unknown> {
  const person = "person" in o ? o.person : "ann";
  return {
    status: o.status ?? "firing",
    labels: { alertname: "MeshAttentionWaitingOnPerson", severity: "crit", ...(person !== undefined ? { person } : {}), ...o.labels },
    annotations: o.annotations ?? { summary: "Plan G12 waits on you for 26 h", dashboard: "https://example.test/?view=waiting", runbook_url: "https://example.test/runbook" },
    startsAt: typeof o.startsAt === "string" ? o.startsAt : iso(o.startsAt ?? START),
    endsAt: "0001-01-01T00:00:00Z",
    generatorURL: o.generatorURL ?? "https://prom.example.test/graph?g0.expr=x",
    fingerprint: o.fingerprint ?? "fp-ann-1",
  };
}

function hook(alerts: Record<string, unknown>[], o: { version?: string; status?: string } = {}): Record<string, unknown> {
  return {
    version: o.version ?? "4",
    status: o.status ?? (alerts.some((a) => a.status === "firing") ? "firing" : "resolved"),
    receiver: "mesh-hub",
    groupKey: '{}:{person="ann"}',
    groupLabels: { person: "ann" },
    commonLabels: {},
    commonAnnotations: {},
    externalURL: "https://am.example.test",
    truncatedAlerts: 0,
    alerts,
  };
}

const post = (token: string | undefined, body: unknown, headers: Record<string, string> = {}) => W().call(token, "POST", URL_PATH, body, headers);
async function postOk(c: Cast, body: unknown): Promise<Json> {
  const r = await post(c.am, body);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json;
}

interface Msg {
  id: number;
  toMachine: string;
  toSid: string;
  fromUser: string;
  kind: string;
  text: string;
  state: string;
  method?: string;
  data?: Json;
}
async function alertMsgs(machine?: string): Promise<Msg[]> {
  const rows = await W().hubStore.db.all<{ id: number }>("SELECT id FROM message WHERE kind = 'alert' ORDER BY id");
  const out: Msg[] = [];
  for (const r of rows) {
    const m = (await W().hubStore.getMessage(Number(r.id))) as unknown as Msg;
    if (machine === undefined || m.toMachine === machine) out.push(m);
  }
  return out;
}
const alertEvents = async (): Promise<Json[]> => (await W().hubStore.eventsOfTypes(["alert.notified"])) as Json[];
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- new store methods, read loosely
const S = (): any => W().hubStore;
const episode = (fingerprint = "fp-ann-1", person = "ann"): Promise<Json> => S().getAlertEpisode(fingerprint, person);
const ack = async (token: string, id: number, state = "delivered", method = "desktop") => {
  const r = await W().call(token, "POST", `/v1/inbox/${id}/ack`, { state, method });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
};
const counts = (j: Json) => ({ received: j.received, notified: j.notified, reminded: j.reminded, resolved: j.resolved, suppressed: j.suppressed, skipped: j.skipped.length });

async function nothingStored(): Promise<void> {
  expect(await alertMsgs()).toStrictEqual([]);
  expect(await alertEvents()).toStrictEqual([]);
  expect(await W().hubStore.db.all("SELECT * FROM alert_episode")).toStrictEqual([]);
}

// ---------------------------------------------------------------------------------------------

describe("AC-01 who may post", () => {
  it("test_AC01_refusals", async () => {
    const c = await cast();
    const b = hook([alert()]);
    expect(await post(c.reader, b)).toStrictEqual({ status: 403, json: { error: "forbidden", code: "forbidden" } });
    for (const t of [c.annBox.token, c.root.token]) expect(await post(t, b)).toStrictEqual({ status: 403, json: { error: "only a service token posts alerts", code: "service-only" } });
    expect(await post(undefined, b)).toStrictEqual({ status: 401, json: { error: "login required", code: "login-required" } });
    const r = await post(c.am, b, { [H]: "ann" });
    expect([r.status, r.json.code]).toStrictEqual([400, "on-behalf-of-not-accepted"]);
    await nothingStored();
    // A member's token is refused before its body is read: an invalid body still gets service-only.
    expect((await post(c.annBox.token, { version: "3" })).json.code).toBe("service-only");
  });
});

describe("AC-02 body", () => {
  it("test_AC02_version_and_body", async () => {
    const c = await cast();
    const v3 = await post(c.am, hook([alert()], { version: "3" }));
    expect(v3).toStrictEqual({ status: 400, json: { error: "webhook version 3 is not supported; expected 4", code: "alert-version" } });
    const many = hook(Array.from({ length: 1001 }, (_, i) => alert({ fingerprint: `fp-${i}` })));
    const noFp = hook([{ ...alert(), fingerprint: undefined }]);
    const badStart = hook([alert({ startsAt: "yesterday" })]);
    for (const [name, b] of [
      ["1001 alerts", many],
      ["no fingerprint", noFp],
      ["startsAt yesterday", badStart],
    ] as const) {
      const r = await post(c.am, b);
      expect([r.status, r.json.code, r.json.error], name).toStrictEqual([400, "alert-body", "invalid alert webhook body"]);
      expect(Array.isArray(r.json.details) && r.json.details.length > 0, name).toBe(true);
    }
    // Positive control: exactly 1000 alerts are accepted.
    const ok = await post(c.am, hook(Array.from({ length: 1000 }, (_, i) => alert({ person: undefined, fingerprint: `fp-${i}` }))));
    expect(ok.status, JSON.stringify(ok.json).slice(0, 200)).toBe(200);
    expect(ok.json.received).toBe(1000);
    await nothingStored();
  });
});

describe("AC-03 skipped", () => {
  it("test_AC03_skipped_alerts", async () => {
    const c = await cast();
    const j = await postOk(
      c,
      hook([
        alert({ person: undefined, fingerprint: "f1" }),
        alert({ person: "Ann", fingerprint: "f2" }),
        alert({ person: "nobody", fingerprint: "f3" }),
        alert({ person: "am", fingerprint: "f4" }),
        alert({ person: "cy", fingerprint: "f5" }),
        alert({ person: "  ", fingerprint: "f6" }),
      ]),
    );
    expect(j).toStrictEqual({
      received: 6,
      notified: 0,
      reminded: 0,
      resolved: 0,
      suppressed: 0,
      skipped: [
        { fingerprint: "f1", reason: "no-person" },
        { fingerprint: "f2", reason: "person-unknown" },
        { fingerprint: "f3", reason: "person-unknown" },
        { fingerprint: "f4", reason: "person-unknown" },
        { fingerprint: "f5", reason: "no-machine" },
        { fingerprint: "f6", reason: "no-person" },
      ],
    });
    await nothingStored();
  });

  it("test_AC03_person_label_trimmed", async () => {
    const c = await cast();
    const j = await postOk(c, hook([alert({ person: " ann " })]));
    expect(j.notified).toBe(1);
    expect((await alertMsgs()).map((m) => m.toMachine)).toStrictEqual([c.annBox.machine]);
  });
});

describe("AC-04 a new episode", () => {
  it("test_AC04_notified", async () => {
    const c = await cast();
    const j = await postOk(c, hook([alert()]));
    expect(j).toStrictEqual({ received: 1, notified: 1, reminded: 0, resolved: 0, suppressed: 0, skipped: [] });
    const all = await alertMsgs();
    expect(all).toHaveLength(1);
    const [m] = all as [Msg];
    expect(m).toMatchObject({ toMachine: c.annBox.machine, toSid: "", kind: "alert", fromUser: "am", state: "pending", text: "MESH ALERT CRIT: Plan G12 waits on you for 26 h" });
    expect(m.data).toStrictEqual({
      alert: {
        fingerprint: "fp-ann-1",
        status: "firing",
        reminder: false,
        alertname: "MeshAttentionWaitingOnPerson",
        severity: "crit",
        summary: "Plan G12 waits on you for 26 h",
        startsAt: START,
        runbook: "https://example.test/runbook",
        dashboard: "https://example.test/?view=waiting",
        url: "https://prom.example.test/graph?g0.expr=x",
      },
    });
    // The machine sees it in its inbox, machine-wide.
    const inbox = await W().call(c.annBox.token, "GET", "/v1/inbox");
    expect(inbox.json.messages.map((x: Json) => [x.id, x.kind, x.toSid])).toStrictEqual([[m.id, "alert", ""]]);
    expect((await W().call(c.annOld.token, "GET", "/v1/inbox")).json.messages).toStrictEqual([]);
    expect((await W().call(c.bobBox.token, "GET", "/v1/inbox")).json.messages).toStrictEqual([]);
    const ev = await alertEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: "alert.notified", user: "am" });
    expect(ev[0].payload).toStrictEqual({ fingerprint: "fp-ann-1", person: "ann", status: "firing", reminder: false, alertname: "MeshAttentionWaitingOnPerson", severity: "crit", startsAt: START, machines: [c.annBox.machine] });
    expect(await episode()).toMatchObject({ state: "firing", startsAt: START, notifiedAt: T0, notices: [{ machine: c.annBox.machine, message: m.id }] });
  });

  it("test_AC04_text_rules", async () => {
    const c = await cast();
    const long = `a\tb\nc${"x".repeat(300)}`;
    await postOk(
      c,
      hook([
        alert({ fingerprint: "f-nosev", labels: { severity: "" }, annotations: { description: "from description" } }),
        alert({ fingerprint: "f-name", annotations: {} }),
        alert({ fingerprint: "f-long", annotations: { summary: long, dashboard: `https://x.test/${"d".repeat(2001)}` } }),
      ]),
    );
    const byFp = new Map((await alertMsgs()).map((m) => [m.data.alert.fingerprint, m]));
    // An empty severity counts as absent.
    expect(byFp.get("f-nosev")?.text).toBe("MESH ALERT: from description");
    expect(byFp.get("f-nosev")?.data.alert.severity).toBeUndefined();
    expect(byFp.get("f-name")?.text).toBe("MESH ALERT CRIT: MeshAttentionWaitingOnPerson");
    const s = byFp.get("f-long")?.data.alert.summary as string;
    expect(s).toHaveLength(200);
    expect(s.startsWith("a b c")).toBe(true);
    expect(byFp.get("f-long")?.data.alert.dashboard).toBeUndefined();
  });
});

describe("AC-05 dedup", () => {
  it("test_AC05_repeats_suppressed", async () => {
    const c = await cast();
    await postOk(c, hook([alert()]));
    for (const at of [T0 + MIN, T0 + 3 * HOUR + 59 * MIN]) {
      W().clock = at;
      const j = await postOk(c, hook([alert()]));
      expect(counts(j)).toStrictEqual({ received: 1, notified: 0, reminded: 0, resolved: 0, suppressed: 1, skipped: 0 });
    }
    expect(await alertMsgs()).toHaveLength(1);
    expect(await alertEvents()).toHaveLength(1);
  });

  it("test_AC05_concurrent_same_hub", async () => {
    const c = await cast();
    const rs = await Promise.all([post(c.am, hook([alert()])), post(c.am, hook([alert()])), post(c.am, hook([alert()]))]);
    expect(rs.map((r) => r.status)).toStrictEqual([200, 200, 200]);
    expect(rs.map((r) => r.json.notified).sort()).toStrictEqual([0, 0, 1]);
    expect(await alertMsgs()).toHaveLength(1);
    expect(await alertEvents()).toHaveLength(1);
  });
});

describe("AC-06 reminder", () => {
  it("test_AC06_reminder_cancels_pending", async () => {
    const c = await cast();
    await postOk(c, hook([alert()]));
    const [first] = (await alertMsgs()) as [Msg];
    W().clock = T0 + 4 * HOUR;
    const j = await postOk(c, hook([alert()]));
    expect(counts(j)).toStrictEqual({ received: 1, notified: 0, reminded: 1, resolved: 0, suppressed: 0, skipped: 0 });
    const all = await alertMsgs();
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ id: first.id, state: "failed", method: "cancelled" });
    expect(all[1]).toMatchObject({ toMachine: c.annBox.machine, state: "pending", text: "MESH ALERT CRIT: Plan G12 waits on you for 26 h" });
    expect(all[1]?.data.alert).toMatchObject({ status: "firing", reminder: true });
    // A cancelled notice left the inbox and emitted no message.delivered.
    expect((await W().call(c.annBox.token, "GET", "/v1/inbox")).json.messages.map((x: Json) => x.id)).toStrictEqual([all[1]?.id]);
    expect(await W().hubStore.eventsOfTypes(["message.delivered"])).toStrictEqual([]);
    const ev = await alertEvents();
    expect(ev).toHaveLength(2);
    expect(ev[1].payload).toMatchObject({ status: "firing", reminder: true, machines: [c.annBox.machine] });
    expect((await episode()).notices).toStrictEqual([
      { machine: c.annBox.machine, message: first.id },
      { machine: c.annBox.machine, message: all[1]?.id },
    ]);
    expect((await episode()).notifiedAt).toBe(T0 + 4 * HOUR);
    // The next reminder is due 4 hours after this one.
    W().clock = T0 + 7 * HOUR;
    expect((await postOk(c, hook([alert()]))).suppressed).toBe(1);
  });
});

describe("AC-07 resolve", () => {
  it("test_AC07_resolved_after_delivered", async () => {
    const c = await cast();
    await postOk(c, hook([alert()]));
    const [first] = (await alertMsgs()) as [Msg];
    await ack(c.annBox.token, first.id);
    W().clock = T0 + 10 * MIN;
    const j = await postOk(c, hook([alert({ status: "resolved" })]));
    expect(counts(j)).toStrictEqual({ received: 1, notified: 0, reminded: 0, resolved: 1, suppressed: 0, skipped: 0 });
    const all = await alertMsgs();
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ toMachine: c.annBox.machine, state: "pending", text: "MESH ALERT resolved: Plan G12 waits on you for 26 h" });
    expect(all[1]?.data.alert).toMatchObject({ status: "resolved", reminder: false, fingerprint: "fp-ann-1" });
    expect(await episode()).toMatchObject({ state: "resolved", resolvedAt: T0 + 10 * MIN });
    const ev = await alertEvents();
    expect(ev[1].payload).toMatchObject({ status: "resolved", reminder: false, person: "ann", machines: [c.annBox.machine] });
    // A repeat of the resolve changes nothing.
    expect((await postOk(c, hook([alert({ status: "resolved" })]))).suppressed).toBe(1);
    expect(await alertMsgs()).toHaveLength(2);
  });

  it("test_AC07_resolved_while_pending", async () => {
    const c = await cast();
    await postOk(c, hook([alert()]));
    const j = await postOk(c, hook([alert({ status: "resolved" })]));
    expect(j.resolved).toBe(1);
    const all = await alertMsgs();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ state: "failed", method: "cancelled" });
    expect((await alertEvents())[1].payload).toMatchObject({ status: "resolved", machines: [] });
    expect((await episode()).state).toBe("resolved");
  });

  it("test_AC07_resolved_without_row", async () => {
    const c = await cast();
    const j = await postOk(c, hook([alert({ status: "resolved" })]));
    expect(counts(j)).toStrictEqual({ received: 1, notified: 0, reminded: 0, resolved: 0, suppressed: 1, skipped: 0 });
    await nothingStored();
  });

  it("test_AC07_reminder_then_resolve", async () => {
    const c = await cast();
    await postOk(c, hook([alert()]));
    const [first] = (await alertMsgs()) as [Msg];
    await ack(c.annBox.token, first.id);
    W().clock = T0 + 4 * HOUR;
    expect((await postOk(c, hook([alert()]))).reminded).toBe(1);
    const reminder = (await alertMsgs())[1] as Msg;
    expect(reminder.state).toBe("pending");
    W().clock = T0 + 5 * HOUR;
    expect((await postOk(c, hook([alert({ status: "resolved" })]))).resolved).toBe(1);
    const all = await alertMsgs();
    expect(all.map((m) => [m.id, m.state, m.method ?? null])).toStrictEqual([
      [first.id, "delivered", "desktop"],
      [reminder.id, "failed", "cancelled"],
      [all[2]?.id, "pending", null],
    ]);
    expect(all[2]).toMatchObject({ toMachine: c.annBox.machine, text: "MESH ALERT resolved: Plan G12 waits on you for 26 h" });
  });

  it("test_AC07_no_recipient_at_resolve", async () => {
    const c = await cast();
    await postOk(c, hook([alert({ person: "bob", fingerprint: "fp-bob" })]));
    const [first] = (await alertMsgs()) as [Msg];
    expect(first.toMachine).toBe(c.bobBox.machine);
    await ack(c.bobBox.token, first.id);
    W().clock = T0 + 15 * DAY;
    const j = await postOk(c, hook([alert({ person: "bob", fingerprint: "fp-bob", status: "resolved" })]));
    expect(counts(j)).toStrictEqual({ received: 1, notified: 0, reminded: 0, resolved: 1, suppressed: 0, skipped: 0 });
    expect((await episode("fp-bob", "bob")).state).toBe("resolved");
    const resolvedNotices = (await alertMsgs(c.bobBox.machine)).filter((m) => m.data.alert.status === "resolved");
    expect(resolvedNotices).toHaveLength(1);
    // A firing alert for bob now has no recipient.
    const again = await postOk(c, hook([alert({ person: "bob", fingerprint: "fp-bob-2" })]));
    expect(again.skipped).toStrictEqual([{ fingerprint: "fp-bob-2", reason: "no-machine" }]);
  });
});

describe("AC-08 episodes", () => {
  it("test_AC08_new_episode_after_resolve", async () => {
    const c = await cast();
    await postOk(c, hook([alert()]));
    await postOk(c, hook([alert({ status: "resolved" })]));
    W().clock = T0 + HOUR;
    const j = await postOk(c, hook([alert({ startsAt: T0 + 30 * MIN })]));
    expect(j.notified).toBe(1);
    expect(await episode()).toMatchObject({ state: "firing", startsAt: T0 + 30 * MIN, notifiedAt: T0 + HOUR });
    expect((await episode()).notices).toHaveLength(1);
  });

  it("test_AC08_late_firing_after_resolve", async () => {
    const c = await cast();
    await postOk(c, hook([alert()]));
    await postOk(c, hook([alert({ status: "resolved" })]));
    const before = { msgs: (await alertMsgs()).length, events: (await alertEvents()).length };
    const j = await postOk(c, hook([alert()]));
    expect(counts(j)).toStrictEqual({ received: 1, notified: 0, reminded: 0, resolved: 0, suppressed: 1, skipped: 0 });
    expect((await alertMsgs()).length).toBe(before.msgs);
    expect((await alertEvents()).length).toBe(before.events);
    // Also when the person has no recipient left: suppressed, not skipped (the check comes first).
    W().clock = T0 + 15 * DAY;
    expect(counts(await postOk(c, hook([alert()])))).toMatchObject({ suppressed: 1, skipped: 0 });
  });

  it("test_AC08_new_start_while_firing", async () => {
    const c = await cast();
    await postOk(c, hook([alert()]));
    const [old] = (await alertMsgs()) as [Msg];
    W().clock = T0 + 10 * MIN;
    const j = await postOk(c, hook([alert({ startsAt: T0 + 5 * MIN })]));
    expect(j.notified).toBe(1);
    const all = await alertMsgs();
    expect(all[0]).toMatchObject({ id: old.id, state: "failed", method: "cancelled" });
    expect(all[1]).toMatchObject({ state: "pending" });
    expect(all[1]?.data.alert).toMatchObject({ reminder: false, startsAt: T0 + 5 * MIN });
    expect(await episode()).toMatchObject({ state: "firing", startsAt: T0 + 5 * MIN, notices: [{ machine: c.annBox.machine, message: all[1]?.id }] });
  });

  it("test_AC08_late_resolve_of_previous_episode", async () => {
    // Review r2 finding 1: episode A resolves, episode B fires, a lagging peer delivers A's resolve.
    const c = await cast();
    await postOk(c, hook([alert()]));
    await postOk(c, hook([alert({ status: "resolved" })]));
    W().clock = T0 + HOUR;
    const B = T0 + 50 * MIN;
    await postOk(c, hook([alert({ startsAt: B })]));
    const msgs = (await alertMsgs()).length;
    const late = await postOk(c, hook([alert({ status: "resolved" })]));
    expect(counts(late)).toStrictEqual({ received: 1, notified: 0, reminded: 0, resolved: 0, suppressed: 1, skipped: 0 });
    expect(await episode()).toMatchObject({ state: "firing", startsAt: B });
    expect((await alertMsgs()).length).toBe(msgs);
    // B still reminds and resolves.
    W().clock = T0 + 5 * HOUR;
    expect((await postOk(c, hook([alert({ startsAt: B })]))).reminded).toBe(1);
    expect((await postOk(c, hook([alert({ startsAt: B, status: "resolved" })]))).resolved).toBe(1);
  });
});

describe("AC-09 two persons", () => {
  it("test_AC09_each_own_machines", async () => {
    const c = await cast();
    const j = await postOk(c, hook([alert({ fingerprint: "fa" }), alert({ person: "bob", fingerprint: "fb" })]));
    expect(j.notified).toBe(2);
    const all = await alertMsgs();
    expect(all.map((m) => [m.toMachine, m.data.alert.fingerprint])).toStrictEqual([
      [c.annBox.machine, "fa"],
      [c.bobBox.machine, "fb"],
    ]);
    const ev = await alertEvents();
    expect(ev.map((e) => [e.payload.person, e.payload.machines])).toStrictEqual([
      ["ann", [c.annBox.machine]],
      ["bob", [c.bobBox.machine]],
    ]);
  });
});

describe("AC-10 prune", () => {
  it("test_AC10_tick_prunes_old_resolved", async () => {
    await cast();
    const row = (fingerprint: string, state: string, updatedAt: number) => ({ fingerprint, person: "ann", state, startsAt: START, updatedAt, summary: "s", notifiedAt: updatedAt, notices: [] });
    await S().saveAlertEpisode(row("old-resolved", "resolved", T0 - 8 * DAY));
    await S().saveAlertEpisode(row("young-resolved", "resolved", T0 - 6 * DAY));
    await S().saveAlertEpisode(row("old-firing", "firing", T0 - 30 * DAY));
    await W().tick();
    expect(await episode("old-resolved")).toBeUndefined();
    expect(await episode("young-resolved")).toMatchObject({ state: "resolved" });
    expect(await episode("old-firing")).toMatchObject({ state: "firing" });
  });
});

describe("AC-13 an older daemon", () => {
  it("test_AC13_offer_only_receive_acks_failed", async () => {
    const c = await cast();
    const dir = mkdtempSync(join(tmpdir(), "mesh-alert-old-"));
    const store = await DaemonStore.open(":memory:");
    try {
      const credentialsPath = join(dir, "credentials.json");
      writeFileSync(credentialsPath, JSON.stringify({ hub: W().hub.url, token: c.annBox.token, user: { id: "ann", name: "ann", roles: ["member"] }, machine: c.annBox.machine }));
      // The 0.1.41 `receive`: a machine-wide message other than an offer is unknown.
      const link = new HubLink({
        credentialsPath,
        store,
        sessions: () => [],
        onMessage: (m) => (m.toSid === "" ? (m.kind === "offer" ? "handling" : "unknown") : "queued"),
        log: () => undefined,
        now: () => W().clock,
      });
      await postOk(c, hook([alert()]));
      await link.pullInbox();
      const [first] = (await alertMsgs()) as [Msg];
      expect(first).toMatchObject({ state: "failed", method: "unknown session" });
      const j = await postOk(c, hook([alert({ status: "resolved" })]));
      expect(j.resolved).toBe(1);
      expect(await alertMsgs()).toHaveLength(1);
      link.stop();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// AC-05: two hubs on one database decide from one current row (SQLite file always; Postgres with MESH_TEST_PG_URL).
const pgdb = new PgFixture();
afterAll(async () => {
  await pgdb.end();
});

async function twoHubs(db: string): Promise<{ hubs: RunningHub[]; stores: HubStore[]; am: string }> {
  const config = buildHubConfig(
    { listen: "127.0.0.1:0", db, auth: { providers: [{ id: "team", kind: "token", users: [{ name: "ann", token_sha256: sha256("ann-token-secret") }] }] } },
    { baseDir: "/", env: {} },
  );
  const stores = [await HubStore.open(db), await HubStore.open(db)];
  const hubs: RunningHub[] = [];
  for (const s of stores) hubs.push(await startHub(config, { store: s, tickMs: 0, now: () => T0 }));
  await fetch(`${hubs[0]?.url}/auth/team/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "ann-token-secret", hostname: "ann-box", install: "inst-ann-1" }) });
  const am = await (hubs[0] as RunningHub).svc.serviceToken("am", ["alerts:notify"]);
  return { hubs, stores, am };
}

async function concurrent(db: string): Promise<void> {
  const { hubs, stores, am } = await twoHubs(db);
  try {
    const b = JSON.stringify(hook([alert()]));
    const send = (h: RunningHub) => fetch(h.url + URL_PATH, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${am}` }, body: b }).then(async (r) => ({ status: r.status, json: (await r.json()) as Json }));
    const rs = await Promise.all([send(hubs[0] as RunningHub), send(hubs[1] as RunningHub), send(hubs[0] as RunningHub), send(hubs[1] as RunningHub)]);
    expect(rs.map((r) => r.status)).toStrictEqual([200, 200, 200, 200]);
    expect(rs.map((r) => r.json.notified).sort()).toStrictEqual([0, 0, 0, 1]);
    const s = stores[0] as HubStore;
    expect(await s.db.all("SELECT id FROM message WHERE kind = 'alert'")).toHaveLength(1);
    expect(await s.eventsOfTypes(["alert.notified"])).toHaveLength(1);
  } finally {
    for (const h of hubs) await h.stop().catch(() => undefined);
    for (const s of stores) await s.close().catch(() => undefined);
  }
}

describe("AC-05 two hubs on one store", () => {
  it("test_AC05_two_hubs_sqlite_file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-alert-2h-"));
    try {
      await concurrent(join(dir, "hub.db"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!PG_URL)(`test_AC05_two_hubs_postgres${PG_URL ? "" : " (skipped: set MESH_TEST_PG_URL)"}`, async () => {
    await concurrent(await pgdb.fresh());
  });
});
