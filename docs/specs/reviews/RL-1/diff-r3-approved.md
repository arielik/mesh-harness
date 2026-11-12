Verdict: APPROVED | Round: 3 | Blocking-open: 0

# Diff review of RL-1, round 3

Reviewed: `git diff feat/relay-design...comb/RL-1` (comb/RL-1 at 898b1bf; impl/RL-1 at d3232ff and
test/RL-1 at d452449 combined) against `docs/specs/RL-1.md` (revision 2, the amended `redactSecrets`
contract and the dated Open questions). I read the earlier rounds first: `r1-changes-requested.md`,
`r2-approved.md` (spec reviews), `diff-r1-changes-requested.md` and `diff-r2-changes-requested.md`.
Then I read the changes since round 2 (`git diff 9f9886b comb/RL-1`: 7cc7792, 50e4124, d3232ff,
d452449) and re-checked them against the whole diff. The base now carries 094e061, which amends the
test plan's assumption A1 to "count once".

comb/RL-1 is green. Both round-2 blockers are fixed, and so are the suggestions S8, S9 and S10. I
found two new suggestions and no blocker.

## Checks

I ran these on an export of comb/RL-1 (`git archive`, in a scratch folder, not in the integration
worktree):
- `pnpm install --frozen-lockfile --prefer-offline`: ok.
- `pnpm check` (lint, typecheck, boundaries, test, build): **pass**, exit 0.
  - boundaries: 178 modules, 625 dependencies, no violations.
  - test: 69 files; 1356 passed, 68 skipped. The skipped tests are the Postgres legs, because
    `MESH_TEST_PG_URL` is not set.
- `pnpm schemas`: the regenerated `schemas/hub-api.openapi.json` is byte-identical to the
  committed one.
- Fail-first. I ran the four new or changed tests of d452449 (with comb's test helpers) on exports
  of the round-1 code (eca019f) and the round-2 code (9f9886b):

  | Test | eca019f | 9f9886b |
  |---|---|---|
  | `test_AC13_order_and_count` (count 1) | fails (count 2) | passes (round-2 code already counted once) |
  | `test_AC13_assignment_of_a_literal` | fails (count 2) | fails (the `tail` is kept, S9) |
  | `test_AC09_foreign_sid` | fails (201, not 403) | passes (49de911 added the check) |
  | `test_AC39_held_message_delivered_after_the_run` | fails (still pending, not delivered) | fails (failed for its age, B1) |

  Each fails on the code it was written against. `test_AC39_no_delivery_to_the_run` (unchanged)
  fails on 9f9886b and passes on comb, so B1's repair is proven by the test that caught it.

I did not run:
- the Postgres contract and World legs (no Postgres available). Nothing in this round touches the
  store.
- the real `claude` binary (never run; the fake executable is used).

## Round-2 findings: status

| Round 2 | Status |
|---|---|
| B1 a run's held messages failed the moment the run ends | Fixed (7cc7792). `messageAge` ages a message from the later of its creation and the run's end, in both `deliverPending` loops. `held` now also treats a session that is still listed but has had no hook since the run ended as "not come back". `test_AC39_no_delivery_to_the_run` passes unchanged. The Open question is updated and dated. |
| B2 `redactSecrets` did not match its spec | Fixed with option (b). The spec contract is amended (order PEM, literals, tokens, assignments; each secret counted once; the whole-mark and mark-plus-text rules). There is a dated Open question, and the test plan's A1 is amended on the base (094e061). The test-writer changed `test_AC13_order_and_count` to `count: 1` and added `secret=<literal>` → 1. Both fail on eca019f. |
| S8 round-1 repairs untested | Fixed (d452449). There are tests for the foreign `sid` 403 (no event, no artifact, plus a positive control) and for delivery after the run with the session back. `reapGroup` is still untested; it was optional and is Linux-only. Closed. |
| S9 tail kept after a mark | Fixed (50e4124). Only a value that is exactly a mark is left alone; a value with a mark among other text is redacted whole. `password=<literal>tail` is covered by `test_AC13_assignment_of_a_literal`. |
| S10 developer's version edit of `test/schemas.test.ts` on impl/RL-1 | Fixed (d3232ff). impl/RL-1 now has no test file that differs from the base. |
| Process note (combine while red) | Resolved for this round: comb/RL-1 passes `pnpm check`. |

## Blockers

None.

## Suggestions (non-blocking)

### S11 (NEW, impl) A late async hook from the run can count as "the session came back"

Files: `src/daemon/daemon.ts` `held()`, and `src/core/session-state.ts` `applyHook`.

`held()` decides that the session came back when `s.lastEventAt > end`. `lastEventAt` is the time
a hook was received (`ev.at`). `applyHook`'s own comment says async hooks can arrive out of order.
An async hook that the run's `claude` sent before it exited can be received after the tick that
set `endedAt`. Then:
- `held` is false;
- `planDelivery` runs for a session whose process is gone;
- the run's held messages can be failed or pasted nowhere, instead of waiting the hour.

The window is small, because `endedAt` is set on a tick after the exit file appears.

Expected: decide "came back" from a hook that was *sent* after the end. Use `ev.sentWindow[0] > end`
when the hook carries it, or a `SessionStart`/`UserPromptSubmit` after the end. Or record the
window in the S1 Open question.

### S12 (NEW, impl) A value with a mark that was already in the input is returned unredacted

File: `src/core/redact.ts`, the last line: `return { text: count ? out : text, count }`.

Take the input `password=[REDACTED]hunter2`. The mark is already in the input (for example, text
that someone copied from an earlier artifact). The assignment pass redacts the whole value but
does not count it, because it holds a mark. `count` stays 0, so the function returns the original
`text` and `hunter2` leaks. This is the S9 tail leak again, in the case where the mark was not
written by an earlier pass. The spec's "text without matches is returned unchanged" does not cover
it, because the input has a match.

Expected: return `out` whenever `out !== text`. Optionally add an AC-13 case
`password=[REDACTED]hunter2` → `{ text: "password=[REDACTED]", count: 0 }` (test-writer).

## What I checked and found right (changes since round 2)

- **Correctness of B1's repair.**
  - `messageAge` uses `finishedRunEnd`. That is the latest `endedAt` of a finished run that owns
    the sid, so a newer message is still aged from its own `createdAt`.
  - Once more than an hour has passed since the run ended, `held` is false and `messageAge` is
    over the TTL, so the usual settling takes over. A message can no longer stay pending forever.
  - A running run's session is still fully quiet.
- **Correctness of B2/S9's repair.**
  - The code order matches the amended spec. Literals before tokens means a literal shaped like a
    token is counted once.
  - `[REDACTED private key]` cut at its space (`value === MARK`) is treated as a whole mark.
- **Auth.** `test_AC09_foreign_sid` proves the 403 happens before any write: there is no
  `step.artifact` event and no artifact row.
- **Privacy.** Redaction now leaves no tail after a mark that an earlier pass wrote. S12 covers
  marks that were already in the input.
- **SQLite/Postgres parity, idempotency.** Nothing in this round touches the store, the routes or
  the run calls.
- **Role separation.**
  - d452449 (test-writer) touches only `src/core/redact.test.ts`, `test/relay-daemon.test.ts`
    and `test/relay-hub.test.ts`.
  - 7cc7792 and 50e4124 (developer) touch only `src/` and the spec.
  - d3232ff only reverts the developer's own earlier test edit, which is the requested remedy for
    S10.
  - `git diff feat/relay-design...impl/RL-1` has no test files, and
    `git diff feat/relay-design...test/RL-1` has no product code.
- **No assertion on source text.** The new tests assert outputs, store rows, events and HTTP
  answers only.
- **Every criterion has a test that failed first.** AC-01 to AC-39 were checked at round 1. This
  round's new and changed tests fail on the code they target (table above).
- **Docs.**
  - The spec contract and two Open questions are amended and dated, and the test plan's A1 is
    amended.
  - `concepts.md` ("the hub records how many were removed") and `events.md` (`redactions`) stay
    accurate.
  - No team-, company- or person-specific names were added.
