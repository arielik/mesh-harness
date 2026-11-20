Verdict: CHANGES REQUESTED | Round: diff-1 | Blocking-open: 2

# RL-13 diff review, round 1 (commit c13581b)

Scope: `git show c13581b` against docs/specs/RL-13.md (r4, approved) and
docs/specs/plans/RL-13-test-plan.md.

Checked: `tsc --noEmit` clean; full suite green (122 files, 2868 tests, with Postgres).
Mutation checks were run on a scratch copy of the tree (the working tree was not touched):

| Mutation (src/daemon/tools.ts `doneCommit`) | Caught by |
|---|---|
| drop the `repoMatches` check | test_AC02_other_repo, test_AC02_cwd_moved_to_other_repo |
| use `s.repo` instead of `repoForCwd(root)` | test_AC02_cwd_moved_to_other_repo |
| no hub read on a cache miss | test_AC01_no_cached_context |
| drop `check-ref-format --branch` | **nothing** (B2) |
| drop the run-session test (`runOf` / `isRunSession`) | **nothing** (B1) |

The source matches the spec contracts: resolution order (explicit, run session, checkout),
repo check on the checkout root actually read, cache-miss read through `contextOf` with every
failure caught, `check-ref-format` then `refs/heads/` then `refs/remotes/origin/`, the offline body
and local round carrying `commit`, `push()` returning the head it read, `pushedCommit` persisted in
`RunEnd` before the report (and `baseCommit` from the immutable run file otherwise, so a retry sends
the same value; a 0.1.31 end record falls back to `baseCommit`), the 400 in `runReport` before
`goalTx`/`stepOr404`, a commit-only finished report updating the round, and the `step.done`,
`step.failed` and `run.finished` payloads. No source bug found. Both blocking items are tests that
cannot fail.

## Blocking

**B1. test/commits-headless.test.ts:103-119 — `test_AC05_run_mesh_done_sends_no_commit` cannot fail.**
The run session's cwd is the run worktree (`<runDir>/worktree`, outside `ann.repoDir`), so the
World's `repoForCwd` stub does not match it and the real `repoForCwd` reads the checkout's config.
`ann.repoDir` (`svc`) has no remote in this test, so `repoForCwd` returns undefined and
`doneCommit` returns `{}` whether or not the session is recognised as a run session. Verified:
with line src/daemon/tools.ts:245 (`if (host.runOf?.(s.sid) !== undefined || host.isRunSession?.(s.sid) === true) return {};`)
removed, the test still passes. Fix: give the checkout a remote that names the step's repo
before the run, e.g. `git(k.ann.repoDir, ["remote", "add", "origin", "https://gitlab.lab/vpc/svc.git"])`.
With that line added the test passes on the real code and fails on the mutation
(`expected '3c47001f…' to be undefined`, the worktree's own commit), which is the exact leak the
spec's step 2 exists to prevent.

**B2. test/commits-hub.test.ts:97 — the revision-syntax case of `test_AC02_unknown_or_revision_branch` cannot fail here.**
It passes `branch: "main~1"`, but `git init` in the World makes `master` on this host (no
`init.defaultBranch`), so `refs/heads/main~1^{commit}` names nothing and the result is "no commit"
even without `check-ref-format`. Verified: with the `check-ref-format` line removed the test still
passes. (On a host where the default branch is `main` it would test the check; the result must not
depend on the git config of the host.) Fix: use the current branch, e.g.
`` branch: `${git(alice.repoDir, ["symbolic-ref", "--short", "HEAD"])}~1` ``; verified to pass on
the real code and fail on the mutation.

## Suggestions (non-blocking)

**S1. src/daemon/tools.ts:234-281 / src/daemon/daemon.ts:1099 — mesh_done latency on a hung git.**
`doneCommit` runs before the POST and may make up to three git calls (`check-ref-format`, two
`rev-parse`), each with the tool host's 30 s timeout, plus a context GET on a cache miss. Normally
milliseconds, but a hung git (NFS, locked index on a huge repo) now delays mesh_done by up to 90 s
where it used to be immediate. Consider one short timeout (a few seconds) for these reads, or one
budget for the whole resolution.

**S2. Missing test: the cache-miss hub read failing.** The spec makes "any failure of that read
(offline, an error status, a timeout) means no commit; `done` is still sent as before" a contract;
no test covers it (test_AC04 caches the context first via `mesh_context`). A case with the cache
pruned and the hub stopped (the done is then queued) would pin both the catch and that the tool
still succeeds. The code is right (src/daemon/tools.ts:251-257 catches every error).

**S3. test/commits-headless.test.ts:87-90 — "a retried report sends the same value" is shown only by `end.json`.**
It asserts `pushedCommit` is in the end record, not that a report retried after a hub outage
sends it. Acceptable given the code reads only `e.pushedCommit ?? run.baseCommit` (both persisted),
but a retry case (hub refusing the first `finished` with a retryable error, then accepting) would
test the AC as written.

**S4. src/daemon/runs.ts:112 — the RunEnd comment.** It says `pushedCommit` is "the result commit;
`baseCommit` when nothing was pushed", but the field is never set to `baseCommit`; the fallback is
computed at report time from the run file. Behaviour is equivalent to the spec (the run file is
written once at start); reword the comment so a later reader does not expect the field to always
be present.
