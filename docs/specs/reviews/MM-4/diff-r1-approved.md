Verdict: APPROVED | Round: 1 | Blocking-open: 0

# Review of the MM-4 diff, round 1

I reviewed `git diff feat/my-mesh-assign...comb/MM-4` (base 70af6af, head 1aef28d) against
`docs/specs/MM-4.md`. I found no earlier diff rounds (`docs/specs/reviews/MM-4/diff-r*.md`), so every
finding here is NEW. Before the diff I read the spec rounds `r1`…`r3` (spec approved in r3).

Commits reviewed: developer d444645, 33be790, b079f1f, 987d507, 06a2177, c2762ae, 9edfd33, bc35b3d;
test-writer 484203a (branched from the base 70af6af) and eedf111; merges 9bd4a01 and 1aef28d.

## Checks

I ran these on an export of `comb/MM-4` (`git archive` into the scratchpad, `pnpm install --frozen-lockfile --prefer-offline`):

| Check | Result |
|---|---|
| `pnpm check` (lint, typecheck, boundaries, test, build) | pass: 59 files, 1128 tests passed, 61 skipped |
| `pnpm test:web` (after the build from `pnpm check`) | pass: 29 tests, including all 8 AC-15/AC-16 tests |
| Fail-first, vitest: the new tests of 484203a on the base 70af6af | 122 failed. Every criterion AC-01…AC-14, AC-17, AC-18 has at least one test that failed |
| Fail-first, Playwright: `test/e2e-web/goals.spec.ts` of 484203a on the base, after `pnpm build` | all 8 AC-15/AC-16 tests failed, and the 6 older tests passed |

Not run:
- the Postgres legs (`MESH_TEST_PG_URL` is not set; the suite skips them). This diff does not change
  the store interface or either store. Suggest and `to` on messages read only through existing store
  methods (`listMachines`, `listSessions`, `getMachine`, `getSession`) inside `store.tx`, so
  SQLite/Postgres parity does not depend on new store code.
- `pnpm schemas` as a separate command. `test_AC17_openapi_fresh` compares `hubOpenApi()` to the
  committed `schemas/hub-api.openapi.json`, and it passes.

New tests that passed on the base. Each one guards behaviour that should not change, or is a
control, so none of them is the only test of a criterion: `test_AC11_tosid_unchanged`,
`test_AC11_tostep_unchanged`, `test_AC11_neither_400`, `test_AC12_local_unchanged`,
`test_AC13_absent_no_limit`, `test_AC13_accept_launch_not_gated`, `test_AC10_no_hub_call_control`,
`test_AC17_openapi_fresh`, `test_AC18_skill_equals_file`.

## Correctness

- **Auth.** Both suggest routes use rule `member` with no scope, so a service token gets 403
  (`test_AC08_service_token`), and `HUB_API` matches `app.ts` (`test_AC17_hub_api_matches_app`).
- **Privacy and visibility.** `suggest()` counts sessions only when `sessionVisible(caller, …, m.share)`
  is true, both for `repo` (repo of a visible session) and for idle sessions and the best session.
  With `team=1`, only the `repo` boolean and the wanted-label intersection of another user's
  machine are exposed, which matches the spec and concepts.md. `say` with `to` goes through
  `resolveTarget` → `findSessionOn`, which filters by visibility, so a hidden `me` session answers
  `no session x on <name>` 404 (`test_AC11_hidden_session`). It cannot be used to probe sessions
  that the `toSid` path hides.
- **Read-only.** Suggest emits no event and writes nothing (`test_AC08_read_only`).
- **Races.** In the daemon, `liveCount()` and `pendingLaunches.set` run with no `await` between
  them, so offers handled at the same time in one pull share the limit
  (`test_AC13_concurrent_offers`). A launch is no longer counted after a `launchStep` failure, when it
  throws, or once a session holding the step appears, and it expires after 120 s on the daemon clock.
- **Idempotency.** Suggest has no side effects. An MM-3 retry of an offer goes through the existing
  `offersHandled` bookkeeping, which this diff does not change.
- **Rank, reason, `to`.** `compareSuggestions` uses exactly the spec's key order. `suggestionReason`
  builds the parts in the spec's order. `suggestionTo` applies the clash rule (a teammate's user id
  equals one of the caller's own nicknames → machine id). The AC-02, AC-06 and AC-05 tests cover
  these, including the round trip to assign.

The code matches the spec contracts I checked:
- the step and goal subjects, including the `primaryRepo` fallback;
- the error texts and statuses;
- the `MessageRequest` refine message;
- the `mesh assign` usage (two lines, with the MM-3 line first);
- the old-hub detection;
- `--stick` in the hint when `steps` is empty;
- the `--max-sessions` parsing and its lines;
- the web picker roles, labels and classes.

## Tests

- No test asserts on source text. The AC-18 tests read the docs and the runtime `MESH_SKILL`
  constant, and AC-17 reads the generated OpenAPI document.
- The negative assertions have positive controls: AC-10 no hub call, AC-13 "limit in force"
  controls, AC-14 bad values after a good one, AC-16 hidden buttons.
- Tests find rows by `machine` id / `data-machine` and steps by id, as the spec requires.

## Docs

- concepts.md has **Suggest** and `maxSessions` under **Assignments**, including the `--team`
  disclosure sentence.
- howto.md has `--suggest` with sample output, the web **Assign** button and
  `mesh say <machine>/<session>`.
- install.md has the `maxSessions` row and `--max-sessions`.
- plan §5.6 has both suggest routes (v0.1.12) and `to` on messages.
- `MESH_SKILL` has both rows and equals `skills/mesh/SKILL.md`.
- `package.json` is 0.1.12.
- No team-, company- or person-specific names: the examples use the existing generic `bob`,
  `build-box` and `payments-api`.

## Findings

None of these blocks.

| # | Class | Kind | Finding |
|---|---|---|---|
| S1 | NEW | suggestion (process, impl) | **The developer edited a test.** bc35b3d changes `test/schemas.test.ts` `test_AC34_version` from `0.1.11` to `0.1.12`. The developer role says "Never create or edit a test". The test-writer's 484203a did not make that change, so the merged result depends on the developer's test edit. The content is harmless: one literal, and it is needed for `pnpm check` to pass. **Expected:** the test-writer owns any edit to a test file, and the developer's commit touches only product code and docs. |
| S2 | NEW | suggestion (test) | **A version assertion the spec rules out.** The spec says "No test asserts `package.json`'s version", but the MM-3 test `test_AC34_version` (test/schemas.test.ts:259) still pins the version, now `0.1.12`. Every release has to edit a test because of it, which is how S1 happened. **Expected:** remove `test_AC34_version`, or relax it to a semver shape check, in a test-writer commit. The release version stays a review-only item (AC-19). |
| S3 | NEW | suggestion (process, test) | **The test-writer edited the spec.** eedf111 changes the AC-11 error case in `docs/specs/MM-4.md` from `no machine x` to `no machine x/perf`. The test-writer role says "commit only tests". The new text is correct: MM-3 `resolveTarget` reads an unresolved `a/b` as the machine reference `<user>/<nickname>` and answers `no machine x/perf`, and the implementation does the same. But no spec review covered the change, and the spec's "Open questions" section does not record it. **Expected:** a spec-writer makes AC changes, or at least adds a dated "Open questions" entry for this one, so the next spec review sees it. |
| S4 | NEW | suggestion (impl) | **Dead branches in `assignCommand`.** In `src/cli/offer-commands.ts`, `if (usage \|\| !target)` repeats `!target`, which `usage` already includes, and the later `if (!to) return 2;` can never run, because `usage` is true whenever `!suggestMode && !to`. **Expected:** `if (usage)` and no dead return. Optionally narrow `to` with a type guard. The behaviour does not change. |

## Verdict

APPROVED. No blocker:
- no hard rule is broken: there is no repo `CLAUDE.md`, and no rule in the task is broken;
- no decision is wrong;
- every criterion has a test that failed first, on the surface the spec names.

S1…S4 are suggestions.
