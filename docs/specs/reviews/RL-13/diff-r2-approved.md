Verdict: APPROVED | Round: diff-2 | Blocking-open: 0

# RL-13 diff review, round 2 (commit 0a1b9b0)

Scope: `git show 0a1b9b0` against round 1 (diff-r1-changes-requested.md, commit c13581b).

Checked on a scratch copy of the tree (the working tree was not touched): `tsc --noEmit` clean;
full suite green (122 files, 2869 tests, with Postgres).

## Round 1 items

| Item | Status | Reason |
|---|---|---|
| B1 | RESOLVED | test/commits-headless.test.ts:108 adds the `origin` remote naming `vpc/svc`. Mutation (drop the `runOf`/`isRunSession` line in `resolveCommit`) now fails `test_AC05_run_mesh_done_sends_no_commit`. |
| B2 | RESOLVED | test/commits-hub.test.ts:97-100 uses the real current branch (`symbolic-ref --short HEAD`) and first asserts `<cur>~1` does resolve, so the case no longer depends on `init.defaultBranch`. Mutation (drop `check-ref-format`) now fails `test_AC02_unknown_or_revision_branch`. |
| S1 | RESOLVED | One 5 s budget for the whole resolution (`doneCommit` racing `resolveCommit`). See the notes on the race below. |
| S2 | RESOLVED | `test_AC04_offline_without_cache_sends_no_commit` prunes the cache, stops the hub, and checks the tool succeeds and the flushed done carries no commit. It fails when the `catch` around `contextOf` is removed and when the catch is changed to fall through with a repo. |
| S3 | OPEN (non-blocking) | No retry case added; the retry is still shown only by `pushedCommit` in `end.json`. Same reasoning as round 1: the value sent is `e.pushedCommit ?? run.baseCommit`, both persisted, so this stays a suggestion. |
| S4 | RESOLVED | src/daemon/runs.ts:112 comment now says the field is unset when nothing was pushed and the report sends `baseCommit`. |

## The new time budget (src/daemon/tools.ts:240-254)

- **Timers.** The timer is cleared in `finally` on both outcomes and is `unref`'d, so it neither
  leaks nor holds the process open.
- **Unhandled rejections.** None. `Promise.race` subscribes to `resolveCommit`'s promise, so a
  rejection after the budget has won is handled (checked in isolation with
  `--unhandled-rejections=strict`). Every git call inside `resolveCommit` is in a `try` anyway, and
  the `contextOf` call is caught. A rejection before the budget propagates exactly as it did
  before the fix (same as c13581b).
- **Explicit-commit error lost to the race.** Cannot happen. The explicit branch returns before any
  `await`, so `resolveCommit` settles in a microtask, and the budget's `setTimeout` callback cannot
  run before it. Valid and malformed explicit commits always win.
- **Fake clocks.** The budget uses the real `setTimeout`, not the World's injected `w.clock`, so the
  tests that advance `w.clock` (`test_AC04_*`) are unaffected. `vi.useFakeTimers` appears only in
  src/cli/tui/tui.test.ts and src/core/fleet.test.ts, which do not reach `mesh_done`. If a future
  test fakes timers around `mesh_done`, the budget never fires and the resolution still finishes on
  its own (git is a child process, not a faked timer), so it degrades to "no budget", not a hang.
- **Behaviour when it fires.** Simulated on the scratch copy (budget 300 ms, git hanging 600 ms then
  throwing): `mesh_done` returned at about the budget with no commit, the step was done, and vitest
  reported no unhandled errors. This matches the spec's "any git or hub failure means no commit".

## Suggestions (non-blocking)

**N1. No test pins the budget.** Replacing the race with a plain `await resolveCommit(...)` fails
nothing. A test would need an injectable budget or a hanging `host.git`; worth adding if the World
can inject `git`, otherwise leave it.

**N2. Work continues after the budget.** When the budget wins, `resolveCommit` keeps running: git
children run on to the tool host's own 30 s timeout, and a late `contextOf` still caches the
context. Both are bounded and harmless; mention it in the comment so nobody expects cancellation.

**N3. Doc comment placement.** The JSDoc that describes `doneCommit` (src/daemon/tools.ts:234-239)
now sits above `const DONE_COMMIT_BUDGET_MS`, so editors attach it to the constant. Move the
constant above the comment, or the comment onto `resolveCommit`, which holds the rules it describes.
