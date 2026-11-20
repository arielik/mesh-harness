Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 2

# RL-13 review, round 1 (spec revision 1, add9e1e)

Checked against: src/protocol/{goal,hub,tools,skill,ledger}.ts, src/daemon/{tools,runs,daemon,git}.ts,
src/hub/{service,app}.ts, src/core/{trail,session-state}.ts, src/cli/show.ts, test/helpers/{world,relay-kit,git-tree}.ts,
test/fixtures/claude/fake-claude/claude.

What holds up (no action):
- Compatibility claim is right: `body()` is `schema.parse(raw)` (src/hub/app.ts:78-86) and `DoneRequest` /
  `RunReport` are plain `z.object` (src/protocol/hub.ts:202, 417), so a 0.1.31 hub strips `commit`.
- No offline-queue race for headless runs: `finish()` returns while any call of the step is queued
  (src/daemon/runs.ts:842), so the queued `mesh_done` (with its commit) replays before the `finished`
  report replaces it. A replayed done rewrites the local record from the hub's (src/daemon/daemon.ts:483-489).
- The 403 rule matches `runReport`: the round's-user/admin check is already unconditional once `round`
  is given (src/hub/service.ts:976-979), before the `telemetry || branch` gate that `commit` must join (:980).
- `run.finished` spreads telemetry after the named fields (service.ts:1000); `RunTelemetry` has no
  `commit` key, so no collision.
- The session's cwd follows hook events (src/core/session-state.ts:189), and `findRepoRoot` accepts a
  worktree's `.git` file (src/daemon/git.ts:131), so "the repo root of the session's cwd" is the checkout
  the session is in now, worktrees included.
- Testability: real git in World checkouts (test/helpers/world.ts:179), a git hook in the relay kit with
  `answerPush` (test/helpers/relay-kit.ts:117-130), and fake-claude's `{"commit": true}` action that records
  `head` (test/fixtures/claude/fake-claude/claude:14, 82-84) cover AC-01..AC-06.

## Blocking

### B1. The checkout's commit is sent even when the checkout is another repo than the step's

Spec lines 76-80: without `args.commit`, the daemon reads `HEAD` (or the branch) in "the repo root of the
session's cwd". Nothing checks that this checkout is the step's repo. A session can hold a step of a
different repo: `mesh_claim` takes any ready step, and the autopilot's own `sameRepo` guard
(src/daemon/tools.ts:374) exists precisely because `s.repo` and `step.repo` can differ. In that case the hub
records a commit of repo A on a step of repo B (src/protocol/goal.ts:346 `repo`), and every CI or
analysis join on (repo, commit) is silently wrong. That is the one thing this release exists to get right.

Required: state the guard. For example: the checkout's commit is sent only when the checkout's repo
(`s.repo`, or `repoForCwd(root)`) matches the step's repo by `repoMatches` (step repo from
`host.local.cached(step)` or the context the session fetched); when the step's repo is unknown to the
daemon, or does not match, no commit (an explicit `args.commit` is exempt). The headless worktree path is
always the step's repo. Add the case to AC-02 ("a session in another repo's checkout sends no commit").

### B2. A headless run's "end commit" can be a commit that exists nowhere once the run is finished

Spec lines 91-98 say the `finished` report carries the worktree's `HEAD`, and calls it "the pushed commit
for `propose-via-branch`". That holds only when the push succeeded. In `push()` (src/daemon/runs.ts:925-935)
a failed push posts a note and returns `undefined`; `pushDone` is then set (runs.ts:896-900) and the
`finished` report would carry the unpushed `HEAD`. The worktree is detached (`worktree add --detach`,
runs.ts:578) and removed right after (`worktree remove --force`, runs.ts:909-912), so that commit is
unreachable on this machine and absent on the remote. The same applies to a `read-only+checks` run, or any
non-push profile, whose agent committed locally: `HEAD != baseCommit`, nothing is pushed. The round would
then name a commit no CI system and no other person can ever find, replacing nothing better (the run's own
`mesh_done` read the same worktree).

Required: define the value for "HEAD differs from `baseCommit` and was not pushed" (push failed, or a
profile that does not push). Options: send `baseCommit` (what the run was given, which is reachable),
or send no commit and also have `mesh_done` in a run worktree skip unpushed heads; either way say it, and
add it to AC-05 (relay kit `answerPush: {code: 1, ...}` with fake-claude `commit: true` makes it testable).
Also correct the summary on line 96-98 accordingly.

## Suggestions

S1. Restart recovery rationale (spec line 93-94) does not match the code: the worktree is removed only
after `finishedDone` is saved (src/daemon/runs.ts:903-912), so a restarted daemon never retries a
`finished` report after removing the worktree. The only real "worktree gone" cases are external removal
(`git worktree prune`, a person deleting the run dir) or a run whose `worktree add` failed (`notStarted`,
runs.ts:577, `worktree` unset). Reword the reason. Better still: read the commit once, after the push,
and persist it in the `RunEnd` sidecar (as `branch` is, runs.ts:103-112, 899) so every retry sends the
same value.

S2. Order of the new 400 in `runReport`. Say it is checked first (before the `started` state/holder
checks at service.ts:960-962 and the 404/403 at :976-979), so "a `started` report with `commit` is a 400"
holds whatever the step's state. Otherwise AC-06 depends on the test's step being held by the reporter.

S3. `branch` is free text up to 200 characters (hub.ts:205, tools.ts schema) and the spec interpolates it
into `refs/heads/<branch>^{commit}`. Revision syntax in it (`@{1}`, `~2`, `^`, `:`) resolves to some other
commit. Require a ref-name check first (e.g. `git check-ref-format --branch`, or a SAFE regex like
`SAFE_REV` at tools.ts:516 without `^~@{}:`), else no commit. Also say whether a `branch` given as
`origin/x` or `refs/heads/x` is normalised.

S4. `ToolHost.git` is optional (src/daemon/tools.ts:79); say "no `host.git` means no commit" in the
resolution list. Note there is a process-free `headCommit()` (src/daemon/git.ts:45, used at
daemon.ts:605 for `repo_commit`); either reuse it for the `HEAD` case or say why `rev-parse` is required.

S5. AC-02: add "a checkout with no commits (unborn `HEAD`) sends no commit". World checkouts are
`git init` with no commit (test/helpers/world.ts:179), so AC-01's test must make a commit first; spell it
out so the test is not written against an unborn HEAD.

S6. Events: `doneStep` also emits `step.rejected` and `step.parked` with a round that will carry `commit`
(service.ts:2756-2770). Either add `commit` to those payloads or say they are out of scope.

S7. Ledger: the round schema is a `z.looseObject` (src/protocol/ledger.ts:96), so AC-08 "the ledger
schema accepts it" is already true today. Make the AC check that the generated schema
(`pnpm schemas`, scripts/schemas.ts:8-9) declares `commit` with the `Commit` pattern, and use the
`Commit` regex rather than `z.string()`. `pnpm schemas` also regenerates `hub-api.openapi.json`
(scripts/schemas.ts:9) for the `DoneRequest`/`RunReport`/`RunRow`/`StageCard` changes; mention it.

S8. `mesh show` (src/cli/show.ts:59): "its newest round's commit" on a step that is claimed again
after a reopen shows the previous round's commit next to a claimed state. Say whether that is intended
(e.g. only for done/failed/parked steps).

S9. Docs paths: concepts.md and operations.md are under docs/guide/, implementation-plan.md under
docs/plan/; name them in full.

S10. The interactive "session in another worktree of the same repo, no `branch` given" case records
that worktree's `HEAD`, which may be `main`. The `refs/heads/<branch>` lookup works across worktrees
(shared refs), so the skill text should push agents to pass `branch` (cheaper than `commit`) when the
work is on a branch not checked out in the session's cwd.
