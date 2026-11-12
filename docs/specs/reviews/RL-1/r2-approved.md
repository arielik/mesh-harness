Verdict: APPROVED | Round: 2 | Blocking-open: 0

# Review of spec RL-1, round 2

I reviewed `docs/specs/RL-1.md` (revision 2, commit d7739fd) cold. I read round 1 first
(`r1-changes-requested.md`). I checked the spec against `docs/analysis/2026-11-12-pulse-relay-roster.md`
(§5.1, §5.2, §5.9, §6, §7, §9 S1) and `docs/analysis/2026-11-12-claude-cli-spike.md` (the spike wins
where they differ). I also checked it against the code on `feat/relay-design`:
- `src/core/{presets,policy,claims}.ts`
- `src/protocol/{goal,hub,hub-api}.ts`
- `src/hub/{app,service}.ts`
- `src/store/hub-store.ts`
- `src/daemon/{daemon,hub-link,tools}.ts`
- `.dependency-cruiser.cjs`
- `test/schemas.test.ts`

## Checks

This is a spec review, so there is no code to build. I did not run any of these: `pnpm lint`,
`pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm build` (together `pnpm check`), or
`pnpm schemas`. I used only `git`, `grep`, `sed`, `cat` and file reads. I did not run the `claude`
binary.

## Round 1 blockers: all resolved

| R1 | Status | Where checked |
|---|---|---|
| B1 preset placeholders | Resolved. `PresetStep` loosens `agent`/`profile`, and `parsePreset` uses it. `instantiate` runs `PlanInput.parse` after substitution, and only `agent`/`profile` throw on an unfilled placeholder. AC-03/AC-04 parse YAML text. This fits `parsePreset` today (it runs `PlanInput.parse` on raw steps). | `src/core/presets.ts` |
| B2 profile source | Resolved. The hub stores `StepOffer.profile {name, sha256}` with the offer, and `run.started` reads it. `markAccepted` keeps `step.offer`. AC-20/AC-31 assert it. | `src/protocol/goal.ts` `StepOffer` |
| B3 queued `mesh_done` | Resolved. Steps 2–4 wait while the link is offline, or while any queued call has a path under `/v1/steps/<id>/`. `doneOffline` queues exactly such a path, and `replay()` sends it on the next flush. AC-36 covers it. | `src/daemon/tools.ts` `doneOffline`, `hub-link.ts` `replay` |
| B4 pid reuse | Resolved. `startId` (boot id + start time) is in `alive`/`kill`, and an exit file means "ended". A reaped run is never signalled. AC-18 and AC-29(c) use a live unrelated `sleep`. | — |
| B5 idempotency keys | Resolved. Keys are named for every run call, and `mesh_artifact` forwards the shim key. The hub caches 2xx replies per (key, user) (`app.ts` middleware), so a replay of a committed call gets the stored reply. AC-37 covers it. | `src/hub/app.ts` |
| B6 `inputs` vs `blind`/`reads` | Resolved. `validatePolicies` rejects naming a blind partner (either side). The context route uses the `agentContext` rule for blind partners and unread deps. AC-02/AC-32 cover both forms. | `src/core/policy.ts` `blindPartners`, `agentContext` |
| B7 ownership / 4xx forever | Resolved. "Still holds" means held by this machine, with no `holderSid` or the run's session (`hold()` sets `holderMachine` from the caller). A 4xx is final, and only offline or 5xx is retried. AC-38 covers both the re-claim and the race. | `src/core/claims.ts` `hold`, `claim` |

All eleven round 1 suggestions (S1–S11) were taken: `policyOf`, the keyword rule, reconcile-driven
checks, no inbox delivery, the AC-30 guard, the scope reasons in Open questions, the detached waiter,
the user-allow note, the profile limits, unknown `{word}` kept as text, and the run route cases.
None is a REPEAT.

## What else matches the code

- **Route table.** There are seven new routes. Each has rule `member`, and scopes match existing
  read routes (`goals:read`). `test/schemas.test.ts` compares `method path rule` of `HUB_API` against
  `createApp().routes`, and AC-34 ties both to `pnpm schemas`.
- **Stores.** Migration 8 is in both lists. `touchMachine` keeps `extra` under a row lock, so
  `headless` fits beside `accept`. AC-08 runs on both dialects.
- **Processes.** `HeadlessRunner` lives in `src/claude`. That matches the existing
  `processes-only-in-adapters` depcruise rule.
- **Reconcile rounds.** A rejected `mesh_done` (reconcile) already adds a round. So "artifact round
  = rounds + 1" and "the new round gets `artifactIds`" line up with `doneStep`.
- **Privacy.** No artifact content goes into events or the ledger. `rate_limit_event` is never used.
  The transcript is a redacted render. Messages never reach a run's session.
- **Scope.** Additions beyond the S1 row are listed with reasons in Open questions. The design's
  "unknown param fails" is narrowed on purpose (agent/profile only), with the date and the reason.

## Blockers

None.

## Suggestions (all NEW; none blocking)

### S1: `git push` is denied only under `propose-via-branch`
`parseProfile` refuses an allow entry that contains the text `git push`. But
`extends: read-only` with `allow: ["Bash(git *)"]` passes, and neither `read-only` nor
`read-only+checks` denies `Bash(git push *)`. So such a run can push, although the docs say "only the
daemon pushes".

Deny wins across sources (spike 3b), so this fix is cheap: add `Bash(git push *)` to the deny list of
all three bases, and update the table and AC-05. Shell rules stay best effort (`git -C x push`).

### S2: bind the run's session to its step locally
Today a session's local `step` is set only after the SessionStart bind `POST /claim` succeeds
(`daemon.ts` `applyEvent`, `.then(update)`). If that call fails, `mesh_context`, `mesh_artifact` and
`mesh_done` all answer `this session holds no step`, and the run can only end through close-as-fail.
A hub blip at start is enough for this.

The daemon knows the run's `sessionId`, so it can set the session's step from the run file at
SessionStart, whatever the hub says.

### S3: name where `telemetry.redactions` comes from
The spec defines it as "the sum over the artifacts the run's session stored", but `RunFile` has no
field for it, and `StoredArtifact` records `by` (a user), not the `sid`. After a restart (AC-29a) the
number has no source. Fix: add `redactions` to `RunFile`, raised by each `mesh_artifact` of the run's
session.

### S4: a lost `done` reply can lose the round's telemetry
Here is the sequence:
1. Close-as-fail `done` commits, but its reply is lost.
2. The next tick's `GET` finds the step `failed`, so it is not "held".
3. The daemon looks for "the last round whose `sid` is the run's `sessionId`". For a run whose
   session never registered (missing agent, early crash), that `done` carried no `sid`.
4. So no round is found. `run finished` goes without `round`, and the telemetry and the push are
   skipped.

Fix: record the progress of steps 2–4 in the run file (for example `closedRound`), so a retry carries
on where it stopped and does not decide again from the step's state.

### S5: the tick exemption follows the step, not the run
`tick()` stops pausing a headless step on "holder session ended", even when a person holds it
interactively (allowed, Open questions). That person's ended session then never pauses it. Also, if a
run file is lost (runs dir deleted, disk change), the step stays `claimed` for good while the machine
is online.

Record this in Open questions. Consider exempting only while `holderSid` is absent or is the run's
session. A hub backstop is another option, for example pause after
`claimedAt + budget.minutes + grace`.

### S6: the worktree base is an unrecorded decision
`git worktree add --detach … HEAD` takes whatever the person's checkout has checked out. That may be a
feature branch, and it is never fetched. The design says only "fresh detached worktree". Record this
in Open questions, or use the remote default branch after a fetch, or the goal base (`worktree: "base"`
semantics).

### S7: pushing a reopened step
A second `propose-via-branch` run of a reopened step starts from a new `baseCommit`. Its push to an
existing `mesh/<slug>` is non-fast-forward, so the run only adds a note. Decide what happens:
`--force-with-lease` inside the `mesh/` namespace, or a per-round name such as `mesh/<slug>-r<n>`.
Record the choice.

### S8: the fence format belongs in the contracts
The fence format is only in AC-32, and its header `(<kind>…)` is open-ended. `brief()`
(`src/daemon/tools.ts`) has no contract row. Fix:
- add a row with the exact header and footer lines;
- say whether the 12 hex digits hash the served (possibly truncated) content or the stored content.

### S9: AC-39 wording
`mesh say` targets a session (`toSid`, `--step` holder, or `<machine>/<session>`), not a user (see
`service.ts` `say`). Write it as "a `mesh say` to the step (its holder is the run's session)".

"Still in the inbox" also names no observable. Name one: the hub message is not acked, or there is no
`message.delivered` event for the run's `sid`.

### S10: `inputs` naming a step that is not a dependency
`inputs: ["x"]` may name any plan step. When `x` is not a dependency, the `reads` rule (which is about
dependencies) does not filter it, and `x` may not have run yet. Say whether `inputs` local ids must be
dependencies (a `validatePolicies` error), or whether `reads` also applies to them.

### S11: smaller contract gaps
- The return shapes of `getProfile`/`listProfiles` are not given (AC-08 round-trip). Say: the saved
  object or `undefined`, and the list ordered by name.
- `artifacts.max_bytes` can be set above the daemon's new 4 MiB local body limit. A large
  `mesh_artifact` then fails at the local route with `body too large`, not with the hub's 413 text.
  Clamp it or document it.
- "Any other 4xx is final" includes 401. `hub-link.replay` treats 401 like offline (it stops and
  retries). Do the same for a run's calls, so an expired token does not drop a close-as-fail.

## Summary

| Class | Blockers | Suggestions |
|---|---|---|
| NEW | 0 | 11 (S1–S11) |
| REPEAT | 0 | 0 |
| REGRESSION-OF-OWN-REPAIR | 0 | 0 |

No hard repo rule is broken. No team-, company- or person-specific name appears in the spec. Every
acceptance criterion names a surface and a failing state. The only part that passes today, the late
`mesh_done` in AC-30, is labelled a regression guard. The verdict is APPROVED. The suggestions can be
folded in at the writer's discretion or carried into Open questions.
