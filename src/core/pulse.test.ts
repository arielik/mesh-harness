// RL-3 AC-04: machine candidates of a pulse offer (`pulseCandidates`) and manual slot ids
// (`manualSlot`) (docs/specs/RL-3.md, Core). The expected order is `suggest`'s, computed here.

import { describe, expect, it } from "vitest";
import type { Session } from "../protocol/index.ts";
import { manualSlot, pulseCandidates } from "./pulse.ts";
import { suggest, type SuggestMachine, type SuggestSession } from "./suggest.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 16, 9);
const now = T0;
const onlineMs = 10 * MIN;
const REPO = "alpha";
const ALPHA = { id: "git.example.com/org/alpha", name: "alpha" };
const TOPICS = ["t"];

type M = SuggestMachine & { headless?: boolean | undefined };
const mach = (id: string, over: Partial<M> = {}): M => ({ id, userId: "ann", hostname: `${id}-host`, lastSeen: now - MIN, share: "me", repos: [ALPHA], accept: ["self"], ...over });
const sess = (sid: string, machineId: string, userId = "ann"): SuggestSession => ({
  userId,
  machineId,
  session: { sid, claudeSessionIds: [`c-${sid}`], cwd: "/w", kind: "interactive", state: "idle", quiet: false, startedAt: now - 10 * MIN, lastEventAt: now - MIN, turns: 1, humanPrompts: 1, seenByReconciler: true, repo: ALPHA } as Session,
});

interface In {
  machines: M[];
  sessions?: SuggestSession[];
  target?: { labels?: string[]; machines?: string[] };
  headless?: boolean;
  tried?: string[];
}
const run = (o: In) =>
  pulseCandidates({
    owner: "ann",
    repo: REPO,
    topics: TOPICS,
    target: o.target ?? {},
    headless: o.headless ?? false,
    tried: new Set(o.tried ?? []),
    now,
    onlineMs,
    machines: o.machines,
    sessions: o.sessions ?? [],
  }).map((s) => s.machine);
/** `suggest`'s order of the given machine ids, as the spec defines the call. */
const suggestOrder = (machines: M[], sessions: SuggestSession[], keep: string[]) =>
  suggest({
    caller: "ann",
    callerMachine: undefined,
    now,
    onlineMs,
    repos: [REPO],
    topics: TOPICS,
    any: false,
    machines,
    callerNicknames: new Set(machines.filter((m) => m.userId === "ann" && m.nickname).map((m) => m.nickname as string)),
    sessions,
  })
    .map((s) => s.machine)
    .filter((m) => keep.includes(m));

const FIVE = (): M[] => [
  mach("m-off", { lastSeen: now - 11 * MIN, labels: ["gpu", "fast"] }),
  mach("m-norepo", { repos: [], labels: ["gpu", "fast"] }),
  mach("m-acc", { accept: ["off"], labels: ["gpu", "fast"] }),
  mach("m-nolab", { labels: ["gpu"] }),
  mach("m-ok", { labels: ["gpu", "fast"] }),
];

describe("AC-04 pulseCandidates", () => {
  it("test_AC04_filters", () => {
    expect(run({ machines: FIVE(), target: { labels: ["gpu", "fast"] } })).toStrictEqual(["m-ok"]);
  });

  it("test_AC04_no_target_labels", () => {
    const ms = FIVE();
    const got = run({ machines: ms, target: {} });
    expect([...got].sort()).toStrictEqual(["m-nolab", "m-ok"]);
    expect(got).toStrictEqual(suggestOrder(ms, [], ["m-nolab", "m-ok"]));
  });

  it("test_AC04_headless", () => {
    const ms = [mach("m-ok"), mach("m-ok2", { headless: true })];
    expect(run({ machines: ms, headless: true })).toStrictEqual(["m-ok2"]);
    expect([...run({ machines: ms, headless: false })].sort()).toStrictEqual(["m-ok", "m-ok2"]);
  });

  it("test_AC04_tried", () => {
    const ms = [mach("m-1"), mach("m-2")];
    const both = run({ machines: ms });
    expect(both).toHaveLength(2);
    const [first, second] = both as [string, string];
    expect(run({ machines: ms, tried: [first] })).toStrictEqual([second]);
  });

  const targets: [string, string, M][] = [
    ["by id", "m2", mach("m2", { userId: "bob", nickname: "box", accept: ["user:ann"] })],
    ["user/nickname", "bob/box", mach("m2", { userId: "bob", nickname: "box", accept: ["user:ann"] })],
    ["owner's bare nickname", "laptop", mach("m2", { nickname: "laptop" })],
  ];
  it.each(targets)("test_AC04_target_machines %s", (_n, entry, m2) => {
    const ms = [mach("m1", { nickname: "desk" }), m2];
    // Positive control: without target.machines both are candidates.
    expect([...run({ machines: ms })].sort()).toStrictEqual(["m1", "m2"]);
    expect(run({ machines: ms, target: { machines: [entry] } })).toStrictEqual(["m2"]);
  });

  it("test_AC04_target_machines bare nickname of another user's machine", () => {
    const ms = [mach("m1", { nickname: "desk" }), mach("m2", { userId: "bob", nickname: "box", accept: ["user:ann"] })];
    expect(run({ machines: ms, target: { machines: ["bob/box"] } })).toStrictEqual(["m2"]);
    expect(run({ machines: ms, target: { machines: ["box"] } })).toStrictEqual([]);
  });

  it("test_AC04_order_is_suggest", () => {
    // x has an idle session in the repo (a suggest rank key); y does not.
    const x = mach("m-x", { labels: ["zz"] });
    const y = mach("m-y", { labels: ["zz", "ww"] });
    const sessions = [sess("s-x", "m-x")];
    for (const ms of [
      [x, y],
      [y, x],
    ]) {
      const want = suggestOrder(ms, sessions, ["m-x", "m-y"]);
      expect(want).toStrictEqual(["m-x", "m-y"]);
      expect(run({ machines: ms, sessions })).toStrictEqual(want);
      // Target labels filter, they never rank: y carries more labels, x still comes first.
      expect(run({ machines: ms, sessions, target: { labels: ["zz"] } })).toStrictEqual(want);
    }
  });
});

describe("AC-04 manualSlot", () => {
  const RE = /^manual:[0-9A-HJKMNP-TV-Z]{26}$/;
  it("test_AC04_manualSlot", () => {
    const a = manualSlot(T0);
    const b = manualSlot(T0, new Uint8Array(10));
    const c = manualSlot(T0 + 1);
    for (const s of [a, b, c]) expect(s).toMatch(RE);
    const time = (s: string) => s.slice("manual:".length, "manual:".length + 10);
    expect(time(a)).toBe(time(b));
    expect(time(c) > time(a)).toBe(true);
    expect(b.slice("manual:".length + 10)).toBe("0000000000000000");
    expect(manualSlot(T0)).not.toBe(manualSlot(T0));
  });
});
