Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 2

# Diff review of RL-1, round 1

Reviewed: `git diff feat/relay-design...comb/RL-1` (comb/RL-1 at eca019f; impl/RL-1 and
test/RL-1 at 981cd32 combined) against `docs/specs/RL-1.md` (revision 2 plus the developer's three
dated Open questions). Earlier rounds read first: `r1-changes-requested.md` and `r2-approved.md`
(both spec reviews). No earlier diff round exists, so every finding below is **NEW**. None is a
REPEAT or a REGRESSION-OF-OWN-REPAIR.

## Checks

I ran these on an export of comb/RL-1 (`git archive`, in a scratch folder, not in the integration
worktree):
- `pnpm install --frozen-lockfile --prefer-offline`: ok.
- `pnpm lint`: pass.
- `pnpm typecheck`: pass.
- `pnpm boundaries`: pass (178 modules, no violations).
- `pnpm test`: pass. 69 files; 1353 passed, 68 skipped. The skipped tests are the Postgres legs,
  because `MESH_TEST_PG_URL` is not set.
- `pnpm build`: pass.
- `pnpm schemas`: the regenerated `schemas/hub-api.openapi.json` is byte-identical to the
  committed one.

I also ran a fail-first check. I ran the new and changed test files of test/RL-1 (981cd32, which
has no product code) against the pre-change base: 214 failed, 104 passed, 59 skipped. Every
criterion AC-01 to AC-39 has at least one test that fails on the base. The RL-1 tests that pass on
the base are all controls or regression guards that are meant to pass today:
`test_AC01_old_plan_unchanged`, `test_AC02_valid_control`, `test_AC03_goal_default`,
`test_AC03_builtins_unchanged`, `test_AC20_interactive`, `test_AC21_interactive_control`,
`test_AC23_assignments_off`, `test_AC30_interactive_control`,
`test_AC30_offline_pauses_and_late_done` and `test_AC32_no_inputs_no_header`.

I did not run:
- the Postgres contract and World legs (no Postgres available). So the BYTEA path of AC-08 is
  reviewed by reading only.
- the real `claude` binary (never run).

## Role separation

- Test-writer commits (cae6914, f9fb150, 981cd32) touch only tests, fixtures and test helpers. No
  product code. OK.
- Developer commits touch two test files:
  - `test/schemas.test.ts` (16a1ffb): this edit was dropped in the combine. The test-writer's
    version won, so it has no net effect.
  - `test/m2-flow.test.ts` (f78f9ae): this edit is still in comb/RL-1. See B2.

## Blockers

### B1 (NEW, test) `test_AC34_boundaries` asserts on source text

File: `test/schemas.test.ts`, in `RL-1 AC-34 checks, schema, boundaries` → `test_AC34_boundaries`.

The test reads every `src/daemon/*.ts` file as text and regex-matches it:
```ts
for (const f of daemonFiles) expect(read(`src/daemon/${f}`), f).not.toMatch(/from\s+["'](node:)?child_process["']/);
```
That is an assertion on source text, which the test-writer role forbids. It is also weak:
- `require("child_process")`, a dynamic `import()` or a re-export would pass it.
- A comment that quotes the import would fail it.

The same file already left this check to the tools on purpose (line 194: "left to review and
`pnpm boundaries`"). The depcruise rule `processes-only-in-adapters` enforces it. That rule is part
of `pnpm check`, which is AC-34's surface.

Expected: remove the source-text loop. Prove placement with module exports, as the test already
does for `processRunner`, and leave the import rule to `pnpm boundaries`. If a test must cover it,
run dependency-cruiser on `src` from the test and assert no `processes-only-in-adapters`
violation.

### B2 (NEW, impl + test) The developer edited an existing test

File: `test/m2-flow.test.ts`, line 284ff, commit f78f9ae: `RL-1 adds mesh_artifact` was added to
the expected tool list.

The developer role says never to create or edit a test. The spec's Compatibility section says the
test-writer updates existing tests that pin old values. The change itself is right; the owner is
wrong. comb/RL-1 passes only because the developer made it.

Expected:
- The test-writer makes this one-line update on test/RL-1. It fails first on the base, because
  the base has no `mesh_artifact`.
- The developer drops it from impl/RL-1.
- The merger re-combines.

## Suggestions (non-blocking)

### S1 (NEW, impl) A finished run's session stays muted forever

File: `src/daemon/runs.ts`, `isRunSession`, together with `daemon.ts` `quiet()` and
`deliverPending`.

`isRunSession` is true for runs in state `running` **or `finished`**. Run files are never pruned.
So a session of a finished run:
- never gets a Stop reply, paste, nudge or escalation;
- stays "reserved" for offers;
- has pending messages that never expire. The TTL is skipped while `quiet`, so they pile up in the
  local store and are scanned on every tick, forever.

This matters for the how-to's `claude --resume <sessionId>`: if Claude Code keeps the session id
on resume, the person reading the run is muted in that session.

The spec says "a session whose id is the `sessionId` of a **running** run". AC-39 only needs the
messages to still be in the inbox right after the run ends.

Expected: limit `quiet` to `running` runs. Settle (or keep) the run session's queued messages once
the run is finished. Or record the choice and its bound in Open questions.

### S2 (NEW, impl) `redactSecrets` counts some secrets twice

File: `src/core/redact.ts`.

The assignment pass runs after the token pass, and its value class `[^\s"']{6,}` matches the
`[REDACTED]` the token pass just wrote. So `token: ghp_<36 chars>` gives `count: 2`. The same
happens for `secret=<daemon key>`: the assignment pass and the literal pass each count it. The text
is right, but the hub's `redactions` and `telemetry.redactions` are too high.

Expected: skip values that are already `[REDACTED]` in the assignment pass, and in the literal pass
count only literals still present. Add an AC-13 case such as `token: ghp_…` → count 1.

### S3 (NEW, test) AC-39's "kept in the inbox" check is conditional

File: `test/relay-daemon.test.ts`, `test_AC39_no_delivery_to_the_run`, last line:
`if (queuedForRun) expect(...)`. When the hub answers 404 to the say, the clause "messages are
still in the inbox after the run ends" is not checked at all. Today the hub answers 201, so it runs,
but it can silently stop running.

The local `ping-Z` message is always queued on the machine. It is checked only for "not
delivered", never for "still pending after the run ends".

Expected: assert, without a condition, that `ping-Z` is in `pendingMessages(s7)` after `endRun`.

### S4 (NEW, impl) `uploadArtifact` does not check `sid`

File: `src/hub/service.ts`, `uploadArtifact`. The body's `sid` goes into the `step.artifact`
event's `sid` without a check. `doneStep` and the assign routes run
`callerMachine(actor, sid)` + `refuseForeign`.

Expected: refuse a foreign `sid` the same way (403 `session <sid> is not yours on this machine`),
or leave it out of the event.

### S5 (NEW, impl) A run's artifacts can land in the next holder's round

File: `src/hub/service.ts`, `uploadArtifact` and `doneStep`.

`round` = rounds + 1 at upload time, and `doneStep` lists artifacts by `round.n`. A release or
takeover adds no round. So in the AC-38 case, a run's `mesh_artifact` reports appear in the new
holder's `artifactIds`. This follows the spec text, but it attributes another session's output to
the new holder.

Expected: an Open question (dated) that records it. A later slice could also filter by holder
session or clear the round on release.

### S6 (NEW, impl) A budget kill misses the group when its leader has already exited

File: `src/claude/headless.ts`, `kill`. `kill` does nothing unless `alive(pid, startId)`. If the
`claude` leader has exited but members of its process group are still running (an MCP child, a
spawned shell), nothing is signalled. `finish()` also never cleans up the group.

Expected (optional): when the leader is gone but `process.kill(-pid, 0)` still finds the group,
and the exit file says the run ended less than a moment ago, signal the group. Or document the
limit.

### S7 (NEW, impl) Profile ownership check races

File: `src/hub/service.ts`, `saveProfile`. It reads the profile (`getProfile`), checks the owner,
then upserts. On Postgres, unless `store.tx` serializes or locks, two first-time saves of one name
by different users can both see "new". The later one then overwrites, and `createdBy` changes.

Expected: lock the name (advisory lock or `SELECT … FOR UPDATE`), or insert with
`ON CONFLICT DO NOTHING` and check the owner afterwards.

## What I checked and found right

- **Auth.**
  - The new routes are rule `member`. The GET routes have scope `goals:read`.
  - `POST /v1/profiles` refuses a non-owner unless admin.
  - Upload and `run started` need `holderUser` or admin. `run finished` with a round needs that
    round's `user` or admin.
  - Artifacts are team-visible, like `GET /v1/goals/:id` (design OQ-3).
- **Privacy.**
  - `step.artifact`, `run.*` and `profile.saved` payloads carry no content. AC-11 checks events,
    the feed and the ledger export.
  - Transcripts are `redactSecrets(renderTail(...))` with the daemon key and hub token. JSON-object
    lines are quoted.
  - `inputs` follows `blindPartners` (both sides) and `reads`, and `agentContext` keeps `inputs`.
- **SQLite/Postgres parity.**
  - Migration 8 exists in both lists: BLOB vs BYTEA, INTEGER vs BIGINT.
  - `hub-copy` copies `artifact` and `profile` and turns `Uint8Array` into `Buffer`.
  - `ON CONFLICT(name)` upsert works on both.
  - `touchMachine` keeps `headless` in `extra` under the existing row lock.
- **Races and idempotency.**
  - The daemon's run calls carry `run-<runId>-<name>` keys. End-of-run progress is in `end.json`,
    so a retry resumes where it stopped.
  - A 4xx is final, and offline/5xx is retried.
  - End-of-run waits while the link is offline or a `/v1/steps/<id>/` call is queued, so a queued
    `mesh_done` is replayed first (AC-36).
  - `handleOffer` dedupes by offer message id across restarts.
- **Restart.** `load()` adopts only when there is no exit file and the `startId` matches. Otherwise
  it reaps without a signal. `Daemon.stop()` never signals a run.
- **Tick.** Headless steps are exempt from the "session ended → pause" rule but not from the
  machine-offline rule. Artifact pruning runs on the first tick, then every 6 h at most, and not
  when `retention_days` is 0.
- **Docs.** Updated:
  - `concepts.md`: headless steps, profiles and what they cannot do, branches, capacity,
    close-as-fail, artifacts, telemetry.
  - `howto.md` and `install.md`.
  - `events.md`: four rows.
  - Implementation plan §5.6: seven routes.
  - `MESH_SKILL` equals `skills/mesh/SKILL.md`.
  - The new Open questions are dated.
  - No team-, company- or person-specific names were added.
- **Tests.** No real `claude` is run; the fake executable is `test/fixtures/claude/fake-claude`.
  Tests find runs by `step` and events by `type` + `step`. Only AC-34 pins the package version.
