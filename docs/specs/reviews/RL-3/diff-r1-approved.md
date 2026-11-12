Verdict: APPROVED | Round: 1 | Blocking-open: 0

# Diff review of RL-3, round 1

Reviewed: `git diff feat/relay-design...comb/RL-3` (head a5e152b, 44 files) against `docs/specs/RL-3.md`
as it stands on `comb/RL-3`. Earlier rounds read first: `r1-changes-requested.md` and `r2-approved.md`.
Both are spec reviews. No earlier diff round exists, so every finding below is NEW. None is a REPEAT or a
REGRESSION-OF-OWN-REPAIR.

## Checks run

All checks ran on an exported copy of `comb/RL-3` (`git archive`, then `pnpm install --frozen-lockfile
--prefer-offline`). Nothing was checked out in the integration worktree.

| Check | Result |
|---|---|
| `pnpm lint` | pass |
| `pnpm typecheck` (root and web) | pass |
| `pnpm boundaries` | pass (no dependency violations) |
| `pnpm test` | 1834 passed, 89 skipped. One failure in the first run: `test/cli.test.ts > mesh doctor > passes with hooks installed and the daemon running`, `EADDRINUSE 127.0.0.1:38380`, a port clash with another process on this host. On a rerun of that file all 58 tests passed. It is not caused by RL-3. |
| `pnpm build` | pass |
| `pnpm schemas`, then compare | `schemas/hub-api.openapi.json` is byte-identical after regeneration |
| `pnpm test:web` (Playwright, after build) | 35 passed, including the 5 AC-23 pulse tests |
| Fail-first | The new and changed test files of the test branch (dc729c6, product code at the base) were run against the pre-implementation tree. 11 of 11 files failed: 215 tests failed and 110 passed. Every criterion AC-01 to AC-23 and AC-26 to AC-29 has failing tests. AC-02, AC-03 and AC-04 fail at import (`src/core/schedule.ts` and `src/core/pulse.ts` do not exist on the base). |

Not run:
- **Postgres legs.** `MESH_TEST_PG_URL` is not set on this host, so these were skipped: the Postgres part
  of AC-05 (v9 → v10 migration, contract), `test_AC09_two_services postgres`, AC-25 `test_AC25_copy`
  (Postgres only) and the existing Postgres legs. SQLite and Postgres parity is reviewed from the code
  only: the migration-10 DDL is the same apart from `BIGINT` for the time columns; `ON CONFLICT DO
  NOTHING` with `rowCount` gives the `addSlot` boolean; `COLLATE "C"` gives code-point slot order;
  `LOCKS.pulses` is taken under the events lock.
- **The real `claude` binary.** It is never run. AC-22 uses the fake executable fixture.

## Separation of roles

- **Test-writer:** commits a9a0933 and dc729c6 touch only test files, `test/helpers/*` and
  `test/e2e-web/mine.spec.ts`. They change no product code. ✔
- **Developer:** see F1. Developer commits edited existing test files. The final tree keeps none of those
  edits: `git diff dc729c6 comb/RL-3` over all test paths is empty. The developer added no new tests.
- **Assertions on source text:** none. The test files read only docs, `package.json`,
  `skills/mesh/SKILL.md` and the generated OpenAPI file (AC-26 and AC-27 surfaces). They also read the
  fake run's `profile.json`. No test asserts on `src/**` text.

## Spec conformance (summary)

These were checked against the contracts:
- preset validation order and texts;
- the R-6 snapshot of the preset and profiles, and the offer guard on `goal.profiles`;
- create-with-plan (no design step, no inbox message, `applyApproved` shared with `approvePlan`);
- advance before fire in the tick, and retire, abandon and overlap inside `fireSlot`;
- the window measured from the due time, and `catchUp` measured from `firedAt`;
- missed reasons, and `hub_down` capped at the 10 latest rows;
- error slots written in a second transaction, with `nextAt` advanced;
- the owner-not-member pause;
- the stale `duePulses` re-read;
- `deleteTopic` removing the topic from pulses (serialised);
- pulse goals left out of `GET /v1/goals` and `/v1/live`;
- route rules and scopes, the CLI texts and exit codes, the web section, and the docs table.

Events are published only after commit (`afterCommit`), so a fire that is rolled back sends no SSE hint.
I found no correctness defect against the spec. Implementation readings that the spec did not pin are in
its Open questions, dated 2026-11-12 (implementation). They are reasonable.

## Findings

None of these is a blocker.

### F1 (NEW, suggestion, process): the developer edited test files, and the merge resolved the conflicts instead of aborting

- Developer commits 96e50ad (`src/core/policy.test.ts`, `src/core/presets.test.ts`), bd1eb39
  (`src/store/hub-store.contract.test.ts`, `test/m46-ops.test.ts`) and 21c1233 (`test/schemas.test.ts`)
  changed existing tests: schema version 9 → 10, presets loops, and the removed 0.1.16 pin. This
  breaks `developer.md` ("Never create or edit a test"). The spec's Compatibility section gives these
  updates to the test-writer.
- Combine commit 543539c lists conflicts in `policy.test.ts`, `presets.test.ts` and `schemas.test.ts`.
  The merger resolved them, but `merger.md` says to run `git merge --abort` and report the paths.
- The final tree keeps the test-writer's version of every test file, so the shipped code is not
  affected. That is why this finding does not block: the repo has no CLAUDE.md that makes this a hard
  rule, and the result is what the rule protects. In later rows the developer should leave failing
  existing tests to the test-writer, and the merger should abort when there is a conflict.

### F2 (NEW, suggestion, efficiency): each fire scans every `fired` slot the pulse ever had

`src/hub/service.ts` `fireSlot`, in the abandon and overlap loops, calls
`listSlots({pulse, state: "fired"})` and then `getGoal` for each row. A slot whose goal finished stays
`fired` for ever. Each fire therefore costs O(all slots), inside the serialised transaction. For a pulse
every 5 minutes that is about 105 000 rows a year. Expected: limit the scan to slots whose goals may
still be unfinished. For example, filter on the goal state in SQL through the `goal` index, or record a
terminal marker on the slot when its goal ends.

### F3 (NEW, suggestion, efficiency): `dueSlots` for cron walks every slot since `nextAt`

`src/hub/service.ts` `HubService.dueSlots` keeps only 11 slots for cron, but it calls `nextSlot` once for
every slot between `nextAt` and now. After a long downtime of a frequent cron (for example `*/5` and 30
days down), that is about 8 640 minute-scans inside one transaction that holds the serialise lock.
Expected: start the walk near `now`, for example at `now − 11 × period`, the same way the `every` branch
starts at its arithmetic offset.

### F4 (NEW, suggestion, correctness edge): a `HubError` thrown inside a manual fire is not recorded as a slot

`src/hub/service.ts` `firePulse` rethrows every `HubError`. That is right for the 404 and 403 checks.
But it also covers a `HubError` raised inside `fireSlot`, such as `saveStepFrom`'s 409
`changed just now`. In that case the transaction rolls back and no slot row is written. The spec says:
"A manual fire whose transaction throws is recorded as above (`missed`, reason `error`)". Expected:
rethrow only the errors of the checks that run before `fireSlot` (the pulse lookup and the owner check),
and record any later throw as an `error` slot. The tick path already does this.

### F5 (NEW, suggestion, CLI): `mesh pulse update <id> --tz <zone>` without `--cron` is ignored silently

`src/cli/pulse-commands.ts` `commonFields` reads `--tz` only when `--cron` is given. An update that gives
only `--tz` sends `{}`. The hub then answers 400 `give at least one field to change`, or, when other
flags are present, ignores the zone without saying so. Expected: when `--tz` is given without `--cron`,
exit 2 with a usage text (for example `--tz needs --cron`), or resend the stored cron with the new zone.

## Verdict

**APPROVED.** There are no blockers. Every criterion has a test that failed before the implementation
and passes now, except the Postgres-only legs, which were not run on this host. F1 to F5 are
suggestions for a later row.
