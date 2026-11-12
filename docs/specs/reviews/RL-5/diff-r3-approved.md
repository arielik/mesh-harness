Verdict: APPROVED | Round: 3 | Blocking-open: 0

# Review of the RL-5 diff, round 3

This is a cold review of `git diff feat/relay-design...comb/RL-5` (comb/RL-5 at 000e8d6) against
`docs/specs/RL-5.md` as it stands on comb/RL-5. I read the earlier rounds first: the spec reviews
`r1-changes-requested.md` and `r2-approved.md`, then `diff-r1-changes-requested.md` and
`diff-r2-changes-requested.md`. Since round 2 the branch gained:
- 4e3d816 (developer): the S8 repair, with a spec contract change and an Open-questions entry;
- ed94afc (test-writer): the B3 repair and the S7 tests;
- b98e2c8 (test-writer): a test for S8;
- 231cfe3 and 000e8d6: the combines of these.

## Checks

I exported comb/RL-5 with `git archive` into a scratch folder and ran
`pnpm install --frozen-lockfile --prefer-offline` there. For the failed-first checks I exported the
round-2 combine (8137753) and the round-1 combine (6d62a58) and copied the round-3 test files over
each. Nothing was checked out in the integration worktree.

| Check | Tree | Result |
|---|---|---|
| `pnpm lint` | comb/RL-5 | pass |
| `pnpm typecheck` | comb/RL-5 | pass |
| `pnpm boundaries` | comb/RL-5 | pass |
| `pnpm build` | comb/RL-5 | pass |
| `pnpm test` | comb/RL-5 | pass: 93 files, 2052 passed, 100 skipped |
| `pnpm schemas` | comb/RL-5 | the regenerated `schemas/hub-api.openapi.json` is byte-identical to the committed one |
| `pnpm test:web` | comb/RL-5, after `pnpm build` | pass: 43 tests |
| `src/protocol/roster.test.ts`, `test/roster-hub.test.ts`, `test/roster-daemon.test.ts` (vitest) | 8137753 + round-3 tests | only `test_AC09_refusal_kept_and_5xx_backs_off` fails, as it should (S8 is not repaired in 8137753) |
| `src/protocol/roster.test.ts`, `test/roster-hub.test.ts` (vitest) | 6d62a58 + round-3 tests | `test_AC01_parse_roster_key`, `test_AC07_repo_id_over_200`, `test_AC07_reregister_keeps_calibrator` and `test_AC19_v2_repeats_pinned_key` fail, as they should (the S3/S4/S5 repairs are not in 6d62a58) |

Not run:
- `pnpm check` as one command. I ran its five parts separately.
- The Postgres legs of the store contract, of m46 and of `test/roster-replicas.test.ts`
  (`MESH_TEST_PG_URL` is unset). CI runs them. I judged AC-03 and the B2 repair on the SQLite leg.
- The real `claude` binary. The tests use the fake executable.

## Test discipline

- **The developer changed no test.** 4e3d816 touches only `docs/specs/RL-5.md` and
  `src/daemon/daemon.ts`.
- **The test-writer changed no product code.** ed94afc and b98e2c8 touch only
  `src/protocol/roster.test.ts`, `test/roster-hub.test.ts` and `test/roster-daemon.test.ts`.
- **The combine** matches both sides:
  - `git diff test/RL-5 comb/RL-5 -- test/ '*.test.ts'` is empty;
  - `git diff impl/RL-5 comb/RL-5 -- src web docs schemas` differs only in `*.test.ts` files.
- **No assertion on source text.** The new tests drive `parseRosterKey`, the hub over HTTP and the
  daemon against a stub hub.
- **Failed first.** Every round-3 test fails on a tree without its repair (see the table above).

## Round-2 findings

| Round 2 | Status |
|---|---|
| B3 AC-01 asserts the old 200 limit | Fixed in ed94afc. The test now checks 330 parses, 331 does not, and a full-id key (200-character id, 64-character name, 64 hex) of exactly 330 characters. `pnpm test` is green. |
| S7 revised contracts untested | Fixed. `test_AC07_repo_id_over_200` covers the 422 text and the 200 control, `test_AC07_reregister_keeps_calibrator` covers the kept calibrator and the replacement control, and `test_AC19_v2_repeats_pinned_key` covers the kept pin and the offer. The AC-01 key covers the 330 limit. All four failed first. |
| S8 refused pushes resent while a 5xx loops | Fixed in 4e3d816. Per scan, the daemon keeps a set of settled `(repo, commit, digest)` pushes, accepted or refused, and skips them until the next rescan. A 5xx or no answer re-runs the pass only after a back-off: 30 s, doubling, at most 15 min. A new scan resets both. The spec's push contract and Open questions (dated 2026-11-12) say so. `test_AC09_refusal_kept_and_5xx_backs_off` failed first. |
| S9 concurrent-push test cannot fail on SQLite | Unchanged. Round 2 asked for nothing, and the test still guards the Postgres leg in CI. Not a finding this round. |

## Correctness of the S8 repair

I read `catalogPassOnce` on comb/RL-5:
- **Passes cannot overlap.** `catalogPass` reuses the running promise, so `catalogRound` is never
  changed by two passes at once.
- **Retries are idempotent.** A retry of an unsettled push sends the same idempotency key, which is
  built from the repo hash, the commit and the digest. The hub's push is idempotent on it.
- **New commits still go out.** A retry re-reads git, so a commit that lands between retries gives a
  new `(repo, commit, digest)` and is pushed.
- **A failed listing waits for the next rescan.** If the `GET /v1/catalog-sources` listing fails on a
  retry, the pass ends with `done = true`, so the unsettled push waits for the next rescan. This is
  the conservative direction, and the spec's Open questions name it.
- **4xx counts as a refusal.** Every 4xx, 429 included, is settled until the next rescan. That
  matches the spec's "a hub answer with a 4xx status".

None of these points is a defect.

## Findings

### S10 (suggestion, NEW, test): the back-off cap and the reset on rescan are not tested

`test/roster-daemon.test.ts`, `test_AC09_refusal_kept_and_5xx_backs_off`, covers the first two
back-off steps (30 s, then 60 s) and checks that a rescan re-sends a refused push. It does not
cover two parts of the spec's contract:
- the 15 min cap of the back-off;
- that a rescan resets the back-off of a push that is still failing. Only the settled set is
  shown to reset.

A regression in `CATALOG_RETRY_MAX_MS`, or a back-off carried across scans, would pass.

Expected: optionally, a daemon test where pushes keep failing with 5xx. Before the next rescan,
the retry gaps grow to 15 min and stay there. After the rescan, the first retry comes 30 s after
the next failure again. Not blocking: the spec's acceptance criteria do not name this, and the
behaviour is visible in the code.

## Summary

Every round-2 finding that asked for a change is repaired. The B3 blocker is closed, and the full
suite, the web suite, lint, typecheck, boundaries, build and the schema regeneration all pass on
comb/RL-5. Each round-3 test failed first on a tree without its repair. The developer and the
test-writer each stayed on their own side. One new suggestion (S10) is open, and it does not block
approval.
