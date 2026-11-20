Verdict: CHANGES REQUESTED | Round: 2 | Blocking-open: 1

# RL-13 review, round 2 (spec revision 2, 8bbd766)

Checked against: src/daemon/{tools,runs,daemon,git}.ts, src/store/daemon-store.ts, src/core/{session-state,repo-id}.ts,
src/cli/mesh-commands.ts, src/protocol/goal.ts, test/helpers/{world,git-tree}.ts, and `git check-ref-format` /
`git rev-parse` behaviour on git in this repo.

## Round-1 findings

| # | Status | Reason |
|---|--------|--------|
| B1 | PARTIAL | The guard is stated and AC-02 covers it, but it compares the wrong repo: `s.repo` is not the repo of the checkout the commit is read from (see N1). The cache it relies on is fine in normal flows (see N2). |
| B2 | RESOLVED | Result commit = pushed head, else `baseCommit`, else none; saved in `RunEnd`; AC-05 covers push failure and retries. Verified below; two non-blocking refinements (N3, N4). |
| S1 | RESOLVED | Restart wording removed; the value is persisted in `RunEnd`. |
| S2 | RESOLVED | Spec line 63-64. |
| S3 | RESOLVED | `check-ref-format --branch` required (spec line 85-88). Normalisation of `origin/x` / `refs/heads/x` is still unstated; see N6. |
| S4 | RESOLVED | "no `host.git` means no commit" (line 83). `headCommit()` reuse not discussed; optional. |
| S5 | RESOLVED | AC-02 has "a repository without commits". |
| S6 | RESOLVED | Out of scope stated (line 126-127). |
| S7 | PARTIAL | Body now uses `Commit.optional()` and names the OpenAPI doc, but AC-08 still reads "the ledger schema accepts it", which is true today (`z.looseObject`). See N5. |
| S8 | RESOLVED | Line 140-142. |
| S9 | RESOLVED | Full paths. |
| S10 | RESOLVED | Skill text line 152-154. |

## Blocking

### N1. The repo check uses `s.repo`, which is not the repo of the checkout the commit is read from

Spec line 77-83: the commit is read from `findRepoRoot(s.cwd)`, but the check is
`repoMatches(s.repo, step.repo)`. `s.repo` is set once, the first time the session has a cwd in a repo
with a remote, and never again: src/daemon/daemon.ts:562-565 (`if (!s.repo && s.cwd) s.repo = repoForCwd(s.cwd)`),
src/core/session-state.ts:189 updates only `s.cwd` from hooks. So a session started in repo B (the step's
repo) whose cwd later moves into repo A passes the check and records A's `HEAD` on B's step, which is
exactly what B1 was about. This is a normal flow, not a corner: Claude Code keeps a `cd` inside the
session's working directories, and `mesh run --design` adds other repos with `--add-dir`
(src/protocol/goal.ts:107), so the cwd can sit in another repo's checkout.

(Round 1 offered "`s.repo`, or `repoForCwd(root)`"; only the second is correct.)

Required: compare the repo of the checkout actually read: `repoForCwd(root)` (through the daemon's
`deps.repoForCwd`, which World stubs for its `git init` checkouts without a remote,
test/helpers/world.ts:327; `ToolHost` needs a hook for it, tools.ts has none today) against the step's
repo with `repoMatches`. Unknown checkout repo (no remote) means no commit, as now. Add to AC-02:
"a session whose cwd moved into another repo's checkout sends no commit".

## Non-blocking

### N2. The cached context is populated in normal flows, not in all

`host.local.cached(step)` (tools.ts:60, daemon.ts:1089-1090) is the SQLite `step_cache`
(daemon-store.ts:42, 237-248): it survives a daemon restart and is pruned after 30 days
(daemon.ts:1463). It is written by `contextOf` (tools.ts:218-221), i.e. by `mesh_context`, `mesh_claim`
(tools.ts:320), `mesh_accept` (tools.ts:313), and for headless runs by `bindRunSession` (daemon.ts:955-958).
It is **not** written when the step is bound by the autopilot chain (tools.ts:377-380), an offer accepted
for a session (`bindOffered`, daemon.ts:976-979), the TUI `n` (`assignNext`, daemon.ts:1194), or the
`MESH_STEP` hook bind of `mesh run` / `mesh accept --launch` (daemon.ts:1313-1318). Each of those tells the
agent to call `mesh_context` first (tools.ts:182, mesh-commands.ts:621-625), which fills the cache, so
AC-01 holds in normal flows. An agent that skips `mesh_context` (a `mesh run --prompt` with its own
prompt, or a step held >30 days) silently gets no commit.

Suggested: on a cache miss in the online `mesh_done` path, read the step with `contextOf(host, s.step)`
(one GET, which also caches it) before deciding; or say explicitly that a miss means no commit. The
headless path does not depend on it (worktree is exempt). `repoMatches(repo, step.repo)` is the right
call shape (src/core/repo-id.ts:46: `Repo` first, step's string as the query; matches id, path suffix
or bare name, the same leniency the autopilot uses at tools.ts:374). Note the spec's "a step whose repo
is unknown" (`step.repo === ""`) means no commit, unlike the autopilot's `!repo` = match; that is fine,
just intentional.

### N3. A headless run's `mesh_done` puts an unpushed commit into the permanent `step.done` event

B2's fix corrects the round with the `finished` report, but the run's own `mesh_done` (online path,
"a headless run's worktree always is" the step's repo) sends the worktree's `HEAD` first. For a
non-push profile that committed, or a failed push, that is a commit of the detached worktree that is
removed later (runs.ts:576, 908-911). The `step.done` event emitted for that `done` keeps it forever
(the spec has `step.done` carry the round's commit, line 125), and the round holds it until the
`finished` report lands (indefinitely while the hub is unreachable for the daemon or the report keeps
failing). Simplest rule: in a headless run session (`host.runOf(sid)` / `isRunSession`), `mesh_done` sends
no commit from the worktree; the `finished` report sets it. Then `step.done` of a headless step has no
commit, `run.finished` has it; say so in Events and AC-01/AC-05. Alternatively document that `step.done`
of a headless run may name an unreachable commit and consumers must use `run.finished`.

Related: an explicit `args.commit` in a headless run is overwritten by the result commit too; say so.

### N4. Take the pushed commit from `push()`, not from a second read

`push()` (runs.ts:925-935) already reads `HEAD` and pushes exactly `HEAD:refs/heads/<branch>`. Have it
return `{ branch, commit }` and save both in `RunEnd` in the same `saveEnd` that sets `pushDone`
(runs.ts:896-900). The spec's "decided once, after the push step" otherwise allows a separate read whose
failure (worktree removed externally between the two saves) is undefined by the spec's three cases.
Verified otherwise: `baseCommit` is set whenever the worktree was made and `rev-parse HEAD` answered
(runs.ts:576-580); a failed `worktree add` is `notStarted` with no worktree and no `baseCommit`, which is
the "no commit" case; `decided: "none"` runs report no `round`, so no commit; the worktree is removed
only after `finishedDone` (runs.ts:902-911), so a retry always finds the saved value. Also note `baseCommit`
is the local checkout's `HEAD`, which may itself be unpushed; "exists in the checkout" is accurate, but
"reachable" for CI is not guaranteed.

### N5. AC-08 still untestable as written

Change to: "the generated ledger schema declares round `commit` with the `Commit` pattern, and the
OpenAPI document has `commit` on `DoneRequest`, `RunReport`, `RunRow`, `StageCard`".

### N6. Branch-name details

`git check-ref-format --branch` exits 0 for `@{-1}` (it expands it), `@`, `origin/x` and
`refs/heads/x`; the subsequent `refs/heads/<branch>^{commit}` lookups then fail for `@{-1}`, `@` and
`refs/heads/main` (checked here), so all end in "no commit", which is safe. Say that `branch` is used
as given (no stripping of `origin/` or `refs/heads/`), so an agent passing `origin/feature` gets no
commit, and the skill text should ask for the plain branch name.

### N7. AC-05 wording vs the rule

AC-05 says "the base commit ... for a close-as-fail run", but by the rule a close-as-fail
`propose-via-branch` run that committed is pushed (push runs for `decided: "closed"`, runs.ts:896) and
gets the pushed head. Write "a close-as-fail run that made no commits" or name the profile.
