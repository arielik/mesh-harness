Verdict: APPROVED | Round: 1 | Blocking-open: 0

# RL-26 code review, round 1 (ad8a0dc..a518dfc, branch aiops-2026-11-26-B-252)

Reviewer: Claude Opus 5.5 (claude-opus-5-5), cold (did not write this code). Date: 2026-11-26.
Row: mesh-ai B-252. Spec: docs/specs/RL-26.md revision 2 (mesh-ai `reviews/B-252/r2-spec.md`: APPROVED).

## What was run

- `eslint .` clean; `tsc --noEmit && tsc --noEmit -p web` clean; `depcruise src` clean; `tsdown` +
  `vite build` clean.
- `vitest run`: 2984 passed, 4 failed, 107 skipped. The 4 failures (test/schemas.test.ts AC16/AC19/AC13
  version, test/docs-rl13.test.ts AC10) expect `package.json` version `0.1.40` while the base
  `ad8a0dc` already carries `0.1.41`; they fail identically at the base and are not touched by this
  branch (the brief forbids a version bump). Pre-existing, not a finding of this row.
- The four new files (test/run-stop.test.ts, test/session-stop.test.ts, test/team-offers.test.ts,
  test/run-stop-run.test.ts) pass.
- `node scripts/schemas.ts` leaves the tree clean: schemas/hub-api.openapi.json is in sync.
- Mutations (each reverted), all caught by the new tests:
  M1 machine-owner right honoured under act-for (service.ts stopRun) → run-stop AC-02 fails;
  M2 team offer auto from the accept policy → team-offers AC-14/AC-15 fail;
  M3 hub remoteStop check removed → session-stop AC-08/AC-12 fail;
  M4 daemon re-check of its own `remoteStop` removed → AC-10 fails;
  M5 team-machine list without the non-service teammate check → AC-13 fails;
  M6 listed headless offer not kept → AC-16 fails.

## AC coverage

| AC | Test | Status |
|---|---|---|
| AC-01 | run-stop.test.ts test_AC01 | covered (park, stoppedRun, one `run_stop`, event order, no `parked` message) |
| AC-02 | run-stop.test.ts test_AC02 ×2 | covered (all codes, machine owner own token 200, relayed 403) |
| AC-03 | run-stop.test.ts test_AC03 | covered (ann 200 with via; apu/root via svc 403; no header 400; `old` 403) |
| AC-04 | run-stop-run.test.ts test_AC04 | covered (killed_operator, transcript round 1, no /done, ack killed, run.stopped, notice) |
| AC-05 | run-stop-run.test.ts test_AC05 ×2 | covered (dropped, no-run, already-ended keeps its exit, retried ack emits nothing) |
| AC-06 | run-stop-run.test.ts test_AC06 (each) | covered |
| AC-07 | run-stop.test.ts test_AC07 | covered |
| AC-08 | session-stop.test.ts test_AC08 (each) | covered |
| AC-09 | run-stop-run.test.ts test_AC09 ×2 | covered (pane interrupt/end, background interrupt no-pane, end `claude stop`) |
| AC-10 | run-stop-run.test.ts test_AC10 | covered |
| AC-11 | session-stop.test.ts test_AC11 ×2 | covered (rights incl. act-for member only, checks in order) |
| AC-12 | run-stop-run.test.ts test_AC12 + session-stop.test.ts test_AC12 | covered (defaults, setup, consent_changed, downgrade) |
| AC-13 | team-offers.test.ts test_AC13 | covered |
| AC-14 | team-offers.test.ts test_AC14 | covered |
| AC-15 | team-offers.test.ts test_AC15 | covered |
| AC-16 | run-stop-run.test.ts test_AC16 ×2 | covered (kept across pull and restart, sweep, refusals) |
| AC-17 | team-offers.test.ts test_AC17 | covered |
| AC-18 | team-offers.test.ts test_AC18 | covered (own-token MM-3 unchanged, features, OpenAPI, docs) |

## Security of the new write paths

- stop-run: `goals:decide` scope; act-for keeps the member role only (`canApprove` holds for the
  goal owner); the machine-owner branch requires `!actor.via` (REQ-STOPRIGHTS-2). Verified by test and M1.
- session stop: `sessions:stop` scope; owner / `canApprove` / admin, admin unreachable under act-for;
  the hub refuses without the machine's `remoteStop: true` and the daemon re-checks its own config
  (REQ-SESSSTOP-1/-2). Body schemas are `.strict()` with trimmed, bounded `reason`.
- Team offers: only under act-for, only to a non-service teammate's machine that reported
  `teamOffers: true`, never a session, never a launch-time `mode`/`profile`, always `auto: false`.
- Transcript exception: one `transcript`, device token of `stoppedRun.machine` and user
  `stoppedRun.holder` only; everything else keeps today's 409.
- Acks: `run.stopped`/`session.stopped` only on the first ack (`ackMessage` true), from the
  addressed machine.

## Scope and hard rules

- No version bump; no migration (machine facts in the JSON extra). RL-22 plumbing (`goals:decide`
  in `SERVICE_SCOPES`, park effect inline in `stopRun`) is stated in the hub commit body as asked.
- No scope creep found. Docs (events.md, guide/auth.md, concepts.md, operations.md) and the OpenAPI
  document follow the API change.

## Findings

1. **MAJOR — a `run_stop` that arrives while a run is starting is acked `no-run` and the run starts on
   the parked step.** src/daemon/runs.ts `stop()`: the queued branch skips runs in `this.starting`
   (`!this.starting.has(r.runId)`), and such a run is still `state: "queued"` in its file, so it is not
   `live` either. During `startInner` (worktree add, spawn) a stop answers `no-run`, the run then
   starts and works until its budget on a step it no longer holds: the case REQ-RUNSTOP-3 ("a queued
   run of that step MUST be dropped … without starting") and Problem 1 exist to prevent. Related: the
   `runId` filter (`o.runId === undefined || r.runId === o.runId || queued`) misses a running run whose
   `run.started` has not reached the hub yet (the hub then sends the `runId` of an earlier run of the
   step); this follows the spec text, but the outcome is the same. Suggested fix: record a pending
   stop for the step when a run is starting (or when no run matches the `runId` but exactly one live
   run of the step exists) and kill it as soon as it has a pid; add a test that stops a run held in
   `starting`. Not BLOCKING: a narrow race, the step is parked at the hub so the run's `/done` is
   refused, and the next budget kill ends it.
2. **MINOR — removal rule (b) of a kept headless offer is not implemented.** Spec §Manual accept: the
   entry is removed when the step read an accept makes shows `step.offer` not `offered` to this
   machine. `acceptLocal` (src/daemon/daemon.ts, `mine` false) falls through to the old 409 and leaves
   the entry until the hourly sweep. Harmless (the sweep removes it), but the spec lists it.
3. **MINOR — `end` in a pane sends SIGTERM to `s.pid` without checking it is still the session's
   process.** daemon.ts `stopSession`: `deps.alive`/start identity is not checked, so a reused pid of a
   session the daemon has not yet seen end could be signalled. Matches the spec wording; a liveness
   check against the session's start identity would close it.
4. **MINOR — a manual accept that `HeadlessRuns.handleOffer` turns into a decline answers
   `409 <step>: declined`.** daemon.ts `acceptHeadless`: when the repo is not on the machine the
   accept declines the offer at the hub and deletes the kept entry, and the person sees only
   "declined". Name the reason (the decline note) in the reply.
5. **MINOR — owner notices are awaited without a guard.** runs.ts `finish` awaits `deps.notify` before
   the run is saved `finished`, and daemon.ts `handleStop` awaits `ownerNotice` before the ack; a
   notifier that throws makes `finish` repeat on the next pass (a second notice) or leaves the stop
   unacked until the next pull. Wrap the notice in a catch-and-log.
6. **MINOR — `mesh stop` prints the machine id.** src/cli/offer-commands.ts uses
   `r.step.stoppedRun.machine` (an id such as `m-…`) for "asked <machine> to stop the run"; the
   other CLI texts name machines by name. Cosmetic.
7. **MINOR (note, not this diff) — docs/specs/RL-26.md Status still reads "Draft … revision 2"**
   although mesh-ai `reviews/B-252/r2-spec.md` is APPROVED; the R2 gate record belongs in the
   Status section.

No BLOCKING finding. Verdict: APPROVED.
