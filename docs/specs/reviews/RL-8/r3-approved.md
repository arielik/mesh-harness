Verdict: APPROVED | Round: 3 | Blocking-open: 0

# Review of the RL-8 spec, round 3

This is a cold review of `docs/specs/RL-8.md` at commit e05907b. I read round 1
(`r1-changes-requested.md`) and round 2 (`r2-changes-requested.md`) first. The round 2 revision
changes one line: AC-06 (d). I checked the spec against the design
`docs/analysis/2026-11-12-pulse-relay-roster.md` (§5.1, §5.5, §5.10), the CLI spike, and the code on
`feat/relay-design`: `src/daemon/runs.ts` (`load`, `runSids`, `liveRunSids`,
`runningWithoutSession`), `src/daemon/daemon.ts` (the machine report's session list),
`test/helpers/world.ts` (`restart` with `whileStopped`, `p.agents`), `src/hub/service.ts`
(`presetChecks`, `createPulse`, `updatePulse`, `pausePulse`, `resumePulse`, `pinAgents`,
`proposePlan`, `rosterOffer`), `src/hub/app.ts` (pulse routes), `src/core/presets.ts`
(`audit-relay`, `instantiate`) and `src/protocol/goal.ts` (plan step `agent`).

## Earlier findings

| Finding | Status |
|---|---|
| r1 B1 pid-only sweep | Fixed in r1's revision (pid **and** run session id, never a running run's session). |
| r1 S1–S4 | Fixed in r1's revision. r1 S5 kept out and documented; accepted. |
| r2 B1 AC-06 (d) cannot fail | **Fixed.** (d) now writes the older `finished` run file in `whileStopped` of `restart(p, {}, {}, whileStopped)`. `runs.load()` reads every run file at `Daemon.start()`, so both files are in `this.runs`; the running run is adopted (`load()`: no exit file, live `pid` and `startId`). A pid-only sweep would end the running run's `print` session (pid P equals the old file's pid), so (d) fails on that bug. `p.agents` is pinned (`null`, or P with the running run's `sessionId`), so `applyObservation` cannot end the session as "process exited" on correct code. |
| r2 S1 other `PulseView` replies | **REPEAT** (suggestion), not acted on. See S1. |
| r2 S2 `agent` vs `policy.agent` | **REPEAT** (suggestion), not acted on. On a second look its impact is small: the warnings are computed from the **instantiated plan**, whose steps carry `agent` (`src/protocol/goal.ts:384`); `policy.agent` exists on stored `Step`s (`rosterOffer`). `pinAgents` reads both because it is also called with other shapes. Saying "`agent` (or `policy.agent`), as `pinAgents` reads it" would still remove the doubt. |
| r2 S3 fleet half of AC-06 (b) | **Withdrawn.** The restarted daemon reports its live sessions in the machine report (`daemon.ts:1546` keeps every session that is not ended), so on today's code the phantom reaches the hub as working after the flush and the fleet half fails; with the sweep it is ended first. The half can fail. |
| r2 S4 design deviation on transcripts | **REPEAT** (suggestion), not acted on. See S2. |

## What holds

- Everything listed under "What holds" in round 2 still holds; the revision touched only AC-06 (d).
- AC-06 now has a failing state for each of its halves: (b) on today's code (no sweep), (d) on a
  pid-only sweep, (c) on a sweep without the session id check.
- No hub migration, no `SCHEMA_VERSION` change, no new route; pulse replies stay typed `object` in
  the OpenAPI document, so `pnpm schemas` output and the route table test are unchanged.
  Idempotent replay of warnings is stated. Warnings follow the caller's roster visibility
  (`agentsView` applies `agentCopyVisible`), so no machine the caller cannot see leaks; the
  roster-key path reads the pulse's own pin and the catalog, which has no per-viewer rule.
- Scope stays within the five problems of the smoke test.

## Blockers

None.

## Suggestions

### S1 (REPEAT of r2 S1): say "absent from every other reply"
`pausePulse` and `resumePulse` also return `PulseView` through `pulseView`. The table names only the
two GET routes. One phrase settles pause and resume for the test-writer.

### S2 (REPEAT of r2 S4): record the deviation from design §5.1 on transcripts
Design §5.1 "End of run" stores a transcript artifact when no `mesh_done` arrives. The spec drops it
for never-started runs (sound: no session, no tail). One dated Open questions line would make the
deviation explicit.

### S3 (NEW): AC-08's update "with params `agent=good`" must send the full params
`updatePulse` replaces `params` (`body.params ?? p.params`, `service.ts:3155`) and `presetChecks`
instantiates `audit-relay`, whose steps use `{agent}`, `{validator}` and `{filer}` with no defaults
(`presets.ts:93/106/121`; a missing one throws `unknown parameter {validator} …`). A test that sends
`{params: {agent: "good"}}` gets a refusal on correct code. Write it as
`params {agent: "good", validator: "good", filer: "good"}`.

### S4 (NEW): `warnings` presence differs from the existing plan warnings
`proposePlan` (`service.ts:2191`) omits `warnings` when the list is empty; RL-8 always includes it on
create/update (possibly empty). Both are stated precisely, so tests can follow either, but a short
note ("unlike `mesh goal plan`, present even when empty") avoids a reviewer flagging the difference
as a bug later.

## Checks

I ran none of the repo's checks. This round reviews a spec, and nothing is implemented yet. I read
the code named above.

Not run: `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm build`, `pnpm check`,
`pnpm schemas`. The Postgres legs of the store contract were not run (`MESH_TEST_PG_URL` is unset;
CI runs them). RL-8 changes no store code, and I judged the transaction and visibility points on
their SQLite path and on `store.tx` joining an open transaction.
