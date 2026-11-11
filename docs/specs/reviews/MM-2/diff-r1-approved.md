Verdict: APPROVED | Round: 1 | Blocking-open: 0

# Review of the MM-2 diff, round 1

Reviewed cold: `git diff feat/my-mesh-assign...comb/MM-2`. That is merge fa103f4 of the developer
branch (head e765cfe) and the test branch (head 120f30a), checked against `docs/specs/MM-2.md`
(revision 1). I first read the spec round `r1-approved.md`. This is the first diff round, so every
finding is NEW.

## Checks run

I ran everything in detached review worktrees in a scratch folder, never in the integration
worktree.

| Check | Result |
|---|---|
| `pnpm check` on `comb/MM-2` | pass: lint, typecheck, boundaries, test (53 files, 780 passed, 54 skipped) and build. |
| `pnpm schemas` | `schemas/hub-api.openapi.json` is unchanged, so the committed file is current. |
| Postgres legs | `MESH_TEST_PG_URL` pointed at the local test Postgres. `src/store/hub-store.contract.test.ts`, `test/labels.test.ts` and `test/my-mesh.test.ts`: 195/195 pass. This covers AC-08 and AC-09 (concurrent adds across two hubs) on both engines. |
| `pnpm test:web` (Playwright) | 16/16 pass, including the four `test_AC19_*`. |
| Fail-first | I ran the changed test files at test-branch head 120f30a (base plus tests only): 138 tests fail in 11 files. Every criterion AC-01 … AC-17 and AC-20 … AC-22 has at least one test that failed first. `mine.spec.ts` at 120f30a (after `pnpm build`): `test_AC19_machine_labels_span` fails. The run is serial and stops at the first failure, so the other three AC-19 tests were not observed failing. AC-18 is review-only by the spec. |
| Mutation of the lock | I removed `await this.store.serialize()` from `HubService.labelMachine` and ran the tests 3 times. `test_AC09_concurrent_adds_postgres` failed 3/3 and `test_AC09_concurrent_adds` (SQLite) passed 3/3 (see S2). I restored the file afterwards. |

Not run:
- the Postgres legs of the rest of the suite (`m46 ops`, `m46 replicas`). Only the three files above ran on Postgres.
- `pnpm test:web` at the test-branch head for the other AC-19 tests (the run stops at the first failure).
- AC-18 by hand in a terminal. I reviewed `src/cli/tui/tui.ts` instead (below).

## Rules

- **Developer and tests.** The developer added no new test. It edited existing test files, all
  mechanically (S1).
- **Test-writer and product code.** be305ad and 120f30a touch only `*.test.ts` and `test/e2e-web/*`.
  The merge fa103f4 adds no product change: the non-test tree equals e765cfe, and
  `test/schemas.test.ts` equals the test branch.
- **No assertion on source text.** `test/schemas.test.ts` reads docs, the skill file, `package.json`
  and the committed OpenAPI file, which AC-20 and AC-21 name as their surfaces. The route table is
  compared through `createApp(...).routes`, and placement (AC-22) through module exports.
- **Docs updated.** concepts ("Label"), how-to ("Label sessions and machines" and the labelled
  example), install guide ("What the hub sees"), skill (both copies equal), plan §5.6 and
  `docs/events.md` (`machine.labelled`).
- **Generic names.** None found in the new code, docs or tests.

## Correctness (checked, no defect found)

- **Auth.**
  - `POST /v1/machines/:id/labels` is `member` with no scope, so service tokens get 403.
  - The owner check runs before any write, and admins get no exception.
  - `HUB_API` matches the served route.
  - `POST /local/labels` sits behind the daemon's `guard` (key, host, no browser origin).
- **Privacy.**
  - `sessionMetadata` adds only `labels`, and only when there are any.
  - `liveSession` adds `labels` under the unchanged `sessionVisible` filter. `/v1/fleet` stays
    owner-only.
  - Under `steps`, no-step sessions are still not sent (AC-07 checks the sync bodies).
- **Parity.**
  - Machine labels live in the `machine.extra` JSON column on both engines, with no migration.
  - `setMachineLabels` reads `extra` with `FOR UPDATE` in a transaction. `touchMachine` spreads
    `extra`, so it keeps `labels`.
  - `labelMachine` takes `serialize()` (the transaction-scoped events lock) before reading the
    current list, so concurrent adds on Postgres do not lose each other. The mutation run confirms
    this.
- **Idempotency.** A change that leaves the list equal records no event and returns 200.
  `parseLabels` dedupes and sorts in code-point order, and the hub's add/remove sorts with the same
  `cmp`.
- **Daemon.**
  - Initial labels are set only for a sid not in memory before the commit, so a session from before
    the release, an adopted placeholder (same sid) or a live session is never relabelled.
  - A remembered `[]` beats the repo default.
  - The checkout key is the nearest `.git` folder or file, so each worktree is separate.
  - In `POST /local/labels`, every check runs before `update()`, so a refused call changes nothing.
  - `unknown` is left out when there are no credentials, the hub is offline, or the request fails or
    takes more than 2 s.
- **CLI.** `mesh run --label` is parsed before the agent check, any claim and tmux. Labels are
  remembered for each start directory before the window opens, so the placeholder from
  `POST /local/launch` gets them.
- **AC-18 (review).**
  - `L` opens `labels for <who>: ` with the current labels joined by `, `.
  - Enter runs `parseLabels`. On an error it sets the status and makes no call. Otherwise it calls
    `client.labels(sid, labels, "set")` and shows the status text from the spec, with
    ` · not a topic: …` suffixes.
  - Esc clears the prompt.
  - `if (goals || machines) return;` comes before the session keys, so `L` does nothing in those
    views.

## Blockers

None.

## Suggestions (not blocking)

### S1 (NEW, process) The developer edited existing test files

- `labels: []` added to the `FleetMachine` fixtures in `src/core/fleet.test.ts`,
  `src/cli/tui/render.test.ts` and `src/daemon/inventory.test.ts` (39d5521, a9c0ab0). The spec makes
  `FleetMachine.labels` required, and typecheck needs the field.
- The version pin in `test/schemas.test.ts` changed from 0.1.9 to 0.1.10 (6c96ada). The merge kept
  the test-writer's version, which drops the MM-1 pin.
- The footer line in `src/cli/tui/__snapshots__/render.test.ts.snap` gained `L labels` (6c96ada).
  AC-17 requires that footer.

None of these weakens an assertion. Expected: next time, the test-writer makes such fixture,
snapshot and version-pin changes in its own commits, or the developer names them in the hand-off.

### S2 (NEW, test) The SQLite leg of the concurrent-add test cannot fail

`test_AC09_concurrent_adds` (`test/labels.test.ts:504`) runs on the World hub, which is in-memory
SQLite on one connection, so the two adds never overlap. With the `serialize()` lock removed it
still passes. The Postgres leg (`test_AC09_concurrent_adds_postgres`) does catch the missing lock,
but `pnpm check` skips it unless `MESH_TEST_PG_URL` is set.

Expected: a one-line comment on the SQLite test saying that it checks only that both adds succeed,
and that the race is proven by the Postgres leg.

### S3 (NEW, impl) The skill's `mesh machines --label` line misstates the filter

The skill row (`src/protocol/skill.ts` and `skills/mesh/SKILL.md`) says:

`mesh machines --label a,b | only sessions with every one of these labels`

Under `filterFleet`, a machine that carries every label keeps all its sessions.

Expected: wording such as "only machines or sessions with every one of these labels (a matching
machine keeps all its sessions)", with both copies regenerated together.

### S4 (NEW, test) Eight new tests passed before the product code existed

These tests did not fail first:
- `test_AC02_synced_steps_drops_free`
- `test_AC03_no_file`
- `test_AC03_not_a_checkout`
- `test_AC07_alice_still_cannot_see`
- `test_AC11_empty_labels_no_brackets`
- `test_AC15_without_label_no_call`
- `test_AC08_schema_version_6` (skipped at the test-branch head)
- `test_AC09_concurrent_adds_postgres` (skipped without a Postgres URL)

All are negative or guard cases next to failing positive tests, which is acceptable.

Expected: no change. This is recorded so the next round does not re-derive it.

### S5 (NEW, impl/spec) Machine labels reach every member through `/v1/live` activity

The `machine.labelled` activity text (`labelled machine <hostname> gpu, perf-lab`) goes to every
member's `/v1/live`, whatever the owner's share level. `LiveMachine` itself does not carry labels.
This matches the spec and MM-1's `machine.named`, so it is not a defect.

Expected: if machine labels should stay private to their owner, add an open question to MM-3 rather
than changing MM-2.
