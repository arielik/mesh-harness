Verdict: CHANGES REQUESTED | Round: 2 | Blocking-open: 1

# Review of the RL-8 spec, round 2

This is a cold review of `docs/specs/RL-8.md` at commit 81d2d9b. I read round 1
(`r1-changes-requested.md`) first. I checked the spec against the design
`docs/analysis/2026-11-12-pulse-relay-roster.md` (§5.1, §5.5, §5.10), the CLI spike, and the code on
`feat/relay-design`: `src/daemon/runs.ts` (`load`, `handleOffer`, `start`, `notStarted`, `queuePass`,
`reconcile`, `markEnded`, `finish`, `push`, `runSids`, `liveRunSids`, `runningWithoutSession`),
`src/daemon/daemon.ts` (`start`, `receive`, `handleOffer`, `liveCount`, `bindRunSession`,
`endRunSessions`, `reconcile`/`reconcileOnce`), `src/core/session-state.ts` (`applyObservation`,
`applyEntry`, `kindOf`, `applyRunSession`, `endSessions`), `src/hub/service.ts` (`createPulse`,
`updatePulse`, `pausePulse`, `resumePulse`, `pulseView`, `pinAgents`, `resolveRoster`, `agentsView`),
`src/hub/app.ts` (pulse routes), `src/protocol/roster.ts`, `src/cli/pulse-commands.ts`,
`src/core/repo-id.ts` (`repoMatches`), `test/helpers/world.ts` (`restart` with `whileStopped`,
`p.agents`, `p.requests`, `p.logs`) and the fake `claude` (`calls/<step>-<pid>.json` with `cwd`).

## Round 1 findings

| R1 | Status |
|---|---|
| B1 pid-only sweep | Fixed in the definition: a leftover run session now needs the pid **and** F's `sessionId` in `claudeSessionIds`, and never a running run's session. The control added to AC-06 cannot fail as written (B1 below). |
| S1 AC-06 (b) fixture | Fixed: `seenByReconciler` absent, `claudeSessionIds: [S]`, `p.agents` `null` or without P; (a) is labelled a regression guard. |
| S2 `invalid` of the pinned definition | Fixed: the lookup is named (repo = pin `source`, name, hash), and the pre-RL-7 row with no `invalid` is covered. |
| S3 holding wrapper | Fixed: every call is recorded, only the first `worktree add` is held, the test waits for it. |
| S4 idempotent replay | Fixed in the `PulseView.warnings` row. |
| S5 stale partial worktree | Kept out, documented in concepts and Open questions. Accepted. |

## What holds

- The race and the capacity gap are as described: `runs.handleOffer` saves `queued` and awaits
  `start`; `queuePass()` sees the same `queued` run; `liveCount()` counts a run only once `startedAt`
  is set. Offers of one pull run concurrently (`receive` → `void this.handleOffer`), so AC-02's two
  `worktree add` calls happen on today's code. The `busy` flag of `runs.reconcile()` does not cover the
  offer path, so AC-01 fails today.
- AC-01's "no transcript" is right: with an accepted `mesh_done` the step is not held at `finish`, so
  `decided` is never `closed`.
- `finish()` uploads the transcript only under `decided === "closed"`, and `meta.notStarted` marks a
  never-started run, so "no transcript" is a one-condition change. `bindRunSession` (the only sender of
  `bind:<sid>:<step>` for runs) runs only after `runner.start` returned `ok`; `p.requests` records the
  `Idempotency-Key`, so the AC-04 check is observable.
- The kind rule fits `applyObservation`: the first match is by pid among live sessions, then by Claude
  session id (ended included), and `applyEntry` sets `kind` unconditionally today. AC-07's three unit
  cases can each fail.
- Daemon start loads sessions before `runs.load()`, so the start-up sweep has both.
- Pulse warnings: `createPulse`/`updatePulse` run in `goalTx` and `store.tx` joins it; `pinAgents`
  refuses only keys that do not resolve, not invalid definitions, so AC-09 reaches 201 with a pin
  whose catalog row carries `invalid`. `agentsView` applies `agentCopyVisible`, so the "other user
  gets `[]`" case of AC-08 holds by construction on both stores. `repoMatches({id, name}, "alpha")`
  matches the copy the runner reports. Routes, statuses and the OpenAPI document stay as they are, so
  the route table test is not affected. No migration, no `SCHEMA_VERSION` change.
- The CLI contract matches `pulse-commands.ts` (`Created pulse …`, `Updated pulse …`, `--window`).
- Scope stays within the five problems of the smoke test.

## Blockers

### B1 (REGRESSION-OF-OWN-REPAIR): AC-06 (d), the pid-reuse control, cannot fail as written
The repair of r1 B1 added control (d): "a run that is `running` … whose session's pid P equals the
`pid` of an older `finished` run file written by the test into `runsDir` … → after `reconcile()` the
running run's session is still live". The daemon reads run files only in `runs.load()`, at
`Daemon.start()`, and the spec places the sweep over the loaded run files ("At daemon start (after the
run files are loaded) and on every reconcile pass"). A file the test writes into `runsDir` while the
daemon runs is never in `this.runs`. So an implementation that sweeps by pid alone (the r1 B1 bug)
does not see that file, the running run's session stays live, and (d) passes. The AC that guards the
r1 B1 fix cannot fail (blocker rule 3).
A second gap: (d) does not pin `p.agents`. If the World's listing is a list without P after the run's
session was seen by the reconciler, `applyObservation` ends it ("process exited"), and (d) fails on
correct code.
**Fix:** in (d), the test writes the older `finished` run file (another `runId` and `sessionId`,
`pid` P) while the daemon is stopped: `restart(p, {}, {}, whileStopped)` with the write in
`whileStopped`. The new daemon adopts the running run (`load()`: live pid and `startId`), loads both
files and sweeps at start. Then `reconcile()`. `p.agents` is `null`, or lists P with the running
run's `sessionId`. Assert that the running run's session is live and holds its step after start-up
and after `reconcile()`.

## Suggestions

### S1 (NEW): name which other replies carry `PulseView` without `warnings`
`pausePulse` and `resumePulse` also return `PulseView` (through `pulseView`), and so does any other
reply built by `pulseView`. The table says `warnings` is present on create/update and absent on the
two GET routes, but says nothing about pause and resume. Add: "absent from every other reply". This
keeps a test-writer from guessing.

### S2 (NEW): "a step whose `agent` is set" should name the field, as `pinAgents` reads it
`pinAgents` reads `s.agent ?? s.policy?.agent`. The warnings contract says "whose `agent` is set". Say
`agent` or `policy.agent`, the same as the pin, so a roster key given only in `policy.agent` gets its
warning, and the two code paths agree.

### S3 (NEW): AC-06 (b): the fleet half only fails if the hub saw the phantom as working
"After a flush `GET /v1/fleet` … no longer lists it as working" can fail only if the hub had the
phantom as working before the restart. A session written straight into the store before the restart
was never reported. Either have the first daemon report it (flush before the restart), or keep the
local `ended` check alone and drop the fleet half.

### S4 (NEW): record the deviation from design §5.1 on transcripts
Design §5.1 "End of run" says that when the session sends no `mesh_done`, the daemon closes the round
`fail` "with … a rendered tail … as a `transcript` artifact". The spec drops it for never-started runs
(no session, no tail). That is a sound reading, but the Open questions entry "Transcripts of short
started runs" covers only started runs. One dated line would make the deviation from the design
explicit: never-started runs have no session, so the design's transcript bullet does not apply.

## Checks

I ran none of the repo's checks. This round reviews a spec, and nothing is implemented yet. I read
the code named above.

Not run: `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm build`, `pnpm check`,
`pnpm schemas`. The Postgres legs of the store contract were not run (`MESH_TEST_PG_URL` is unset; CI
runs them). RL-8 changes no store code, and I judged the transaction and visibility points on their
SQLite path and on `store.tx` joining an open transaction.
