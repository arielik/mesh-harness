Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 1

# Review of the RL-8 spec, round 1

This is a cold review of `docs/specs/RL-8.md` (commit b950edd). I checked it against the design
`docs/analysis/2026-11-12-pulse-relay-roster.md` (§5.1, §5.5, §5.10), the CLI spike
`docs/analysis/2026-11-12-claude-cli-spike.md`, and the code on `feat/relay-design`:
`src/daemon/runs.ts`, `src/daemon/daemon.ts`, `src/core/session-state.ts`, `src/hub/service.ts`
(pulses, `pinAgents`, `resolveRoster`, `agentsView`), `src/hub/app.ts` (pulse routes, idempotency),
`src/protocol/pulse.ts`, `src/protocol/roster.ts`, `src/cli/pulse-commands.ts`, `src/store/pg.ts`
(nested transactions), `schemas/hub-api.openapi.json`, `test/helpers/world.ts`,
`test/helpers/relay-kit.ts`, the fake `claude` fixture and the existing "did not start" tests.
No earlier rounds exist (`docs/specs/reviews/RL-8/` did not exist), so every finding is **NEW**.
None is a REPEAT or a REGRESSION-OF-OWN-REPAIR.

## What holds

- The race is real as described. `runs.handleOffer` saves the run `queued` and then awaits
  `start(run)`. `queuePass()` (from `runs.reconcile()`, serialized by `Daemon.reconcile()` but not
  against the inbox path `receive → handleOffer`) picks the same `queued` run. `liveCount()` counts
  `runningWithoutSession()` only when `startedAt` is set, so a run in `start` is not counted.
  Rules 1–4 and AC-01/AC-02 fail on today's code.
- `firstLine()` is used in exactly the three places of the git table (`runs.ts` 495, 767, 782).
- `finish()` posts the transcript whenever `decided === "closed"`, including `meta.notStarted`, so
  the "no transcript" rule is a one-condition change. `bindRunSession` (the only sender of the
  `bind:<sid>:<step>` claim for runs) runs only after `runner.start` returned `ok`.
- `applyEntry` sets `s.kind = kindOf(e)` unconditionally and `kindOf` never returns `print`, so
  problem 5 is real. The pid-keyed rule is precise and AC-07's unit cases can fail.
- Pulse warnings: `agentsView(viewer, name)` already applies `agentCopyVisible` (RL-5 privacy),
  carries `invalid` per version, and `repoMatches` exists. `createPulse`/`updatePulse` run in
  `goalTx`; `store.tx` joins an open transaction (`pg.ts:95`; SQLite likewise), so calling the
  roster view inside them works on both stores. Routes and statuses stay. The OpenAPI document
  types these replies as `object`, so `pnpm schemas` output is unchanged and the route table test is
  not affected. `GET /v1/pulses/:id` returns `PulseDetail`, not `PulseView`, so "absent there" holds
  by construction. The CLI example's `--params a=b,…` matches `paramsOf`; `audit-relay` has steps
  `audit` (`{agent}`) and `validate` (`{validator}`).
- Scope matches the spec's own problem list (all five come from the same smoke test). No hub
  migration, no `SCHEMA_VERSION` change, no new route.

## Blockers

### B1 (NEW): the leftover-session sweep is keyed on the pid alone and can end the session of a live run
"Leftover run session" = a live `print` session whose `pid` equals the `pid` of **any** finished run
file. Run files are never pruned (`runs.ts` has no removal; `load()` reads every one), and pids are
reused: after a reboot they start low again, and on hosts with `pid_max` 32768 they wrap within
days. The codebase already treats pid reuse as real (`src/claude/headless.ts:5` and `:35`: the
`startId` and `MESH_RUN=<runId>` checks exist so "a reused pid is never killed"). When a new run's
`claude -p` gets the pid of an old finished run, the sweep on the next reconcile ends the new run's
live `print` session while the run works: its step is no longer held locally, `mesh_context` and
`mesh_done` from the run lose their binding until RL-7 rule 3 rebinds it, and `mesh machines` shows
it ended. The sweep runs on every reconcile, so this repeats.
This is a wrong decision (blocker rule 2), and AC-06 (c) only covers a different pid, so no AC
would catch it.
**Fix:** define a leftover run session as a live `print` session with `pid` = the finished run's
`pid` **and** `claudeSessionIds` containing that run's `sessionId` (every run session registered by
RL-7 has it; the v0.1.21 phantom has it too, since `bindRunSession` passes
`claudeSessionId: run.sessionId`), and never a session in `liveRunSids()` (a running run's
sessions). Add a control to AC-06: a running run whose session's pid equals the pid of an older
finished run file (written by the test) keeps its session live after `reconcile()`.

## Suggestions

### S1 (NEW): pin the AC-06 (b) fixture so the AC cannot pass by accident
Today `applyObservation` already ends a live session whose pid is not listed **if**
`seenByReconciler` is true ("process exited", `session-state.ts:351-357`). If the test-writer
stores the phantom with `seenByReconciler: true` and the World's `p.agents` is a list without that
pid, today's code ends it and AC-06 (b) passes with no sweep. The real v0.1.21 phantom was never
seen by the reconciler (the process died at once). State the fixture: `seenByReconciler` absent,
`claudeSessionIds` = `[<the finished run's sessionId>]` (see B1), and `p.agents` either `null` or a
list that does not hold the pid. AC-06 (a) alone cannot fail today either (`markEnded` already ends
the run's sessions). That is acceptable because (b) carries the AC, but say so or drop (a).

### S2 (NEW): the pinned roster definition has no `invalid` field; name the lookup
The roster-key bullet says "the pinned catalog definition (the pulse's `agents` entry for that key)
has `invalid`". The pulse's `agents` entries are `AgentDef` (`src/protocol/roster.ts:60`:
`key, source, name, hash, commit`), which carry no front matter. Say where `invalid` is read: the
stored catalog definition with `repo = pin.source`, `name = pin.name`, `hash = pin.hash`
(`store.listCatalogDefs({repo, name})` filtered by hash), and its `invalid`. Note the RL-7 limit
that a definition stored before RL-7 keeps its first `front` on re-push, so such a row may carry no
`invalid` (no warning, the conservative outcome).

### S3 (NEW): AC-01 should say what the wrapped runner does with a second `worktree add`
"Holds the run's `worktree add` call" leaves open whether a second call (today's bug) is also held.
If it is, the buggy code hangs inside `reconcile()` and the test fails by timeout, not by the
"exactly one call" assertion. Say: the wrapper records every call, holds only the **first**
`worktree add` of the step, and passes later ones through at once; the test waits until the first
call is recorded before it calls `reconcile()`. The same applies to AC-02.

### S4 (NEW): replies replayed under an `Idempotency-Key` carry the first reply's warnings
`POST /v1/pulses` and `/update` go through the generic idempotency layer (`app.ts:420`), which keeps
the first response. "Not stored" is true of the pulse row, but a retried CLI request gets the
warnings computed at the first call. One sentence in the warnings contract prevents a test that
expects a recomputed list on replay.

### S5 (NEW): the stale partial worktree after a crash during start
The Open question accepts that a daemon killed during `git worktree add` fails the step on restart
("already exists"). A conservative alternative within this row is to run
`git worktree remove --force <runDir>/worktree` (or `git worktree prune`) before the add when the
folder exists for a `queued` run. Leaving it out is a defensible call. If it stays out, a sentence in
concepts would explain the `could not make a worktree: fatal: … already exists` failure.

## Checks

Run: none of the repo's checks. This round reviews a spec, and nothing is implemented. I read the
code named above and the four existing never-started tests (`test/relay-daemon.test.ts` AC22,
`test/relay-run-session.test.ts` AC10, `test/roster-daemon.test.ts` AC21 and its invalid roster
case). None of them asserts a transcript, so the Compatibility note's test updates may be empty.

Not run: `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm build`, `pnpm check`,
`pnpm schemas`. The Postgres legs of the store contract were not run (`MESH_TEST_PG_URL` is unset;
CI runs them). RL-8 changes no store code, and I judged the nested-transaction point on
`src/store/pg.ts` and the shared SQLite path.
