Verdict: APPROVED | Round: 1 | Blocking-open: 0

# RL-20 implementation review, round 1 (commit 93e8cdf)

Cold review of `git show 93e8cdf` against `docs/specs/RL-20.md` (revision 3, approved).

## Summary

The route, the split of `presetChecks`, the `read` flag, the pulse-detail `steps`, the feature and
the docs match the spec. Create, update and ingest still call the throwing `presetChecks` with the
same arguments and order of checks (`src/hub/service.ts:3481-3487`, call sites 3618, 3740, 3849);
the only change on their path is that the 422 is now thrown by the wrapper instead of a `fail()`
closure, with the same text and `details`. The full suite passes on a copy of the commit (145 files,
2926 passed, 107 skipped) and `tsc --noEmit` is clean. Each guarded behaviour I mutated except one
(see finding 1) is caught by a test.

## Findings

1. **non-blocking**: the "one problem per distinct refusal text" dedup
   (`src/hub/service.ts:3546`, `if (!problems.includes(e.message))`) is not guarded. Removing the
   condition leaves all 13 tests green (mutation e below). AC-03 has two steps that sink to two
   *different* unknown topics. The spec does not have an AC for two steps that sink to the *same*
   unknown topic, so this is not an AC gap. Suggested: in `test_AC03_several_problems_in_create_order`,
   add a preset with two steps sinking to the same unknown topic and assert a single problem.
2. **non-blocking**: `checkPreset` resolves the roster keys twice: once inside `presetProblems`
   (`src/hub/service.ts:3527`, which discards `agents`) and again at 3551 to get `agents`. Both run
   in the same read transaction, so they agree. This is only a redundant read; `presetProblems`
   could return the `agents` it already computed.
3. **non-blocking, spec wording only**: the spec says `bad topic "<topic>"` names the topic after
   substitution, trimming and lowercasing. `topicName` (`src/hub/service.ts:7318`) prints the raw
   argument, but the argument is already trimmed and lowercased by `instantiate`
   (`src/core/presets.ts:275-276`). The text is therefore as specified, and it is identical to
   create's text either way (AC-02 asserts equality with create's 400).
4. **non-blocking**: the cookie cross-origin 403 for this `POST` comes from the shared middleware
   (`src/hub/app.ts:571`) and is not tested for the new route. No AC asks for that test. It is
   noted only because the spec states the behaviour.

Checked and fine:
- Equivalence with create: `problems` = 422 `details` (same `presetProblems` code), then sink
  400 texts in step order. Steps are copied before `sinkTopic`, each call is wrapped on its own, and
  errors other than `HubError` 400 are re-thrown (`src/hub/service.ts:3536-3555`). AC-02 and AC-03
  compare against create's actual answers (`test/preset-check-hub.test.ts:96-108, 154-172`).
- `steps` and `agents` only when `ok` (3553-3554); the tests assert both are absent on every failure
  (`test/preset-check-hub.test.ts:92-93`).
- Warnings come from the shared `pulseWarnings` (now `Pick<Pulse,…>`, 3661) with the pins that
  resolved. They are kept on `ok: false` and are equal to create's warnings (AC-04).
- Idempotency key ignored only for `read` routes (`src/hub/app.ts:587`). On-behalf is refused by
  `actingFor` because the route has no `onBehalfOf` (`src/hub/service.ts:2144`). The OpenAPI
  document drops the header for `read` routes and the description changes as specified
  (`src/protocol/hub-api.ts:502, 536`).
- `pulseDetail` `steps` from the stored snapshot only, absent on a parse or instantiate error
  (`src/hub/service.ts:3719-3726`). The spread keeps the key absent rather than `undefined`.
- Docs: concepts paragraph, auth `goals:read` list, operations feature list and the upgrade
  sentence before `0.1.23 has no release package.`, and the implementation-plan rows. `schemas/` is
  regenerated (`test/schemas.test.ts` passes).

## Mutation check

Scratch copy outside the worktree (node_modules symlinked). Each mutation was applied on its own,
then the file was restored from the worktree. Command:
`vitest run test/preset-check-hub.test.ts test/docs-rl20.test.ts` (baseline: 13/13 pass).

| # | Mutation | Result |
|---|---|---|
| a | `src/hub/app.ts`: drop `route.read !== true &&` from the idempotency-key condition | **caught**: `test_AC08_no_writes_no_events_no_replay` fails |
| b | `checkPreset`: per-step sink-topic loop iterates nothing | **caught**: AC02, AC03, AC04 fail |
| c | `checkPreset`: `{ kind: true }` replaced by `{}` | **caught**: `test_AC02_each_problem_class` fails |
| d | `pulseDetail`: `...(steps ? { steps } : {})` removed | **caught**: `test_AC09_pulse_detail_steps` fails |
| e | (extra) sink-problem dedup removed | **not caught** (finding 1) |
| f | (extra) `steps`/`agents` returned with problems | **caught**: AC02, AC03 fail |
| g | (extra) `warnings` hard-coded to `[]` | **caught**: AC04 fails |
