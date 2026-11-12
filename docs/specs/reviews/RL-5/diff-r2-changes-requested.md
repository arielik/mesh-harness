Verdict: CHANGES REQUESTED | Round: 2 | Blocking-open: 1

# Review of the RL-5 diff, round 2

This is a cold review of `git diff feat/relay-design...comb/RL-5` (comb/RL-5 at 8137753) against
`docs/specs/RL-5.md` as it stands on comb/RL-5. I read the earlier rounds first: the spec reviews
`r1-changes-requested.md` and `r2-approved.md`, then `diff-r1-changes-requested.md`. Since round 1 the
branch gained a3ce089 (developer: fixes for B1, B2, S2-S5, Open questions for S6) and b992094
(test-writer: T1-T3), combined in 8137753.

## Checks

I exported comb/RL-5 with `git archive` into a scratch folder and ran
`pnpm install --frozen-lockfile --prefer-offline` there. For the failed-first check I exported the
round-1 combine (6d62a58, without a3ce089) and copied the three test files of b992094 over it. Nothing
was checked out in the integration worktree.

| Check | Tree | Result |
|---|---|---|
| `pnpm lint` | comb/RL-5 | pass |
| `pnpm typecheck` | comb/RL-5 | pass |
| `pnpm boundaries` | comb/RL-5 | pass |
| `pnpm build` | comb/RL-5 | pass |
| `pnpm test` | comb/RL-5 | **fail**: 93 files, 2047 passed, 100 skipped, 1 failed: `src/protocol/roster.test.ts > test_AC01_parse_roster_key` (see B3) |
| `pnpm schemas` | comb/RL-5 | the regenerated `schemas/hub-api.openapi.json` is byte-identical to the committed one |
| `pnpm test:web` | comb/RL-5, after `pnpm build` | pass: 43 tests, the 5 AC-22 roster tests included |
| `test/roster-daemon.test.ts`, `test/roster-replicas.test.ts` (vitest) | 6d62a58 + b992094 tests | `test_AC09_refused_push_waits_for_rescan` fails, as it should; the replicas SQLite leg passes (it cannot fail on SQLite, see S9) |
| `test/e2e-web/roster.spec.ts` (playwright) | 6d62a58 + b992094 tests, after `pnpm build` | `test_AC22_empty_rules_no_zero` fails with a text node `"0"`, as it should |

Not run:
- `pnpm check` as one command. I ran its five parts separately.
- The Postgres legs of the store contract, of m46 and of `test/roster-replicas.test.ts`
  (`MESH_TEST_PG_URL` is unset). CI runs them. I judged AC-03 and the B2 repair on the SQLite leg.
- The real `claude` binary. The tests use the fake executable.

## Test discipline

- **The developer changed no test.** a3ce089 touches `docs/specs/RL-5.md`, `src/daemon/daemon.ts`,
  `src/hub/service.ts`, `src/protocol/roster.ts` and `web/src/roster.tsx` only. Round 1's S1 did not
  happen again.
- **The test-writer changed no product code.** b992094 touches `test/roster-daemon.test.ts`,
  `test/roster-replicas.test.ts` and `test/e2e-web/roster.spec.ts` only.
- **The combine** took the tests from test/RL-5 (`git diff test/RL-5 comb/RL-5 -- '*.test.ts' test/`
  is empty) and the product code from impl/RL-5.
- **No assertion on source text.** The new tests drive the daemon, the hub over HTTP and the page.
- **Failed first.** T1 and T3 fail on the tree without a3ce089 (table above). T2 is the replicas test;
  its SQLite leg passes either way (S9).

## Round-1 findings

| Round 1 | Status |
|---|---|
| B1 refused push retried every flush | Fixed. A 4xx leaves `pushedSeq` at the scan's `seq`; T1 proves it. The spec text and Open questions say how 5xx and transport errors are retried. See S8 for a remaining edge. |
| B2 `pushCatalog` without `serialize()` | Fixed. `pushCatalog` and `saveCatalogSource` call `this.store.serialize()` first inside the transaction, as the other read-then-write paths of the hub do. SQLite leg of the replicas test passes; the Postgres leg was not run here. |
| S1 developer edited tests | Not repeated. |
| S2 stray `0` | Fixed; T3 failed first and passes now. |
| S3 long source ids | Fixed in code and spec (`CATALOG_REPO_MAX` 200, `ROSTER_KEY_MAX` 330), but the repair breaks the AC-01 test (B3). No test for the new 422 (S7). |
| S4 v2 plan with a pinned key | Fixed (`proposePlan` passes `goal.agents`). No test (S7). |
| S5 calibrator cleared on re-registration | Fixed, documented in the route contract and Open questions. No test (S7). |
| S6 push gaps | Recorded in Open questions as open, conservative reading kept. Accepted. |

## Findings

### B3 (blocker, REGRESSION-OF-OWN-REPAIR, test): `pnpm test` fails: AC-01 still asserts the old 200-character key limit

`src/protocol/roster.test.ts`, `test_AC01_parse_roster_key`, lines 114-118:

```ts
// Length: 200 parses, 201 does not.
const key = (n: number) => `${"s".repeat(n - 4)}/rev`;
...
expect(P.parseRosterKey(key(201))).toBeUndefined();
```

The S3 repair (a3ce089) changed the `parseRosterKey` contract in the spec and in
`src/protocol/roster.ts` from "length ≤ 200" to "length ≤ `ROSTER_KEY_MAX` (330)". The test was not
updated, so a 201-character key now parses and the assertion fails. comb/RL-5 does not pass
`pnpm test`, which is a hard rule of the repo. The product code matches the revised spec; the test is
stale. The developer was right not to edit it, but neither the fix commit nor the spec asked the
test-writer to update it, and the combine was not run green.

Expected: the test-writer changes the length assertions to the revised contract: a key of exactly
`ROSTER_KEY_MAX` (330) characters parses, 331 does not (and a full-id key `<200-char id>/<64-char
name>@<64 hex>` parses). Run `pnpm test` on the combined branch before handing it to review.

### S7 (suggestion, NEW, test): the revised contracts of the round-1 repairs have no tests

a3ce089 changed four contracts in the spec, and no test checks any of them:
- `POST /v1/catalog-sources` with a repo id longer than 200 characters → 422
  `repo id <id> is over 200 characters` (`test/roster-hub.test.ts`, AC-07).
- Re-registering a source without `calibrator` keeps the stored one (`test/roster-hub.test.ts`,
  AC-07; today line 158 always sends `calibrator`).
- A v2 plan that repeats a key already pinned on the goal is accepted after the name left the source,
  and approval keeps the v1 pin (`test/roster-hub.test.ts`, AC-19).
- A full-id key at the 330 limit parses (covered once B3 is fixed).

Expected: one assertion for each, written against the spec. If the test-writer wants them under an
AC, the spec's AC-07/AC-19 rows can name them; the Open questions already record the decisions.

### S8 (suggestion, NEW, impl): a 5xx on one source makes the refused sources of the same pass resend every flush

`src/daemon/daemon.ts`, `catalogPassOnce`. A 5xx or transport error on any push sets
`this.pushedSeq = 0`, which makes the next flush redo the whole pass, including the pushes of other
sources that the hub refused with 4xx in the same pass. With two catalog sources checked out, one
refused deterministically (for example the 8 000 000 total) and one hitting a lasting 5xx, the refused
push is POSTed again on every flush. A deterministic 5xx (a hub bug) also loops on every flush; the
Open questions record that part as open.

Expected: keep a per-source record (for example the `(repo, commit, digest)` refused at this scan
`seq`) and skip it until the next rescan, or apply a back-off to the 5xx retry. Not blocking: it needs
two failures at once and the spec leaves 5xx open.

### S9 (suggestion, NEW, test): the concurrent-push test cannot fail on SQLite

`test/roster-replicas.test.ts`. The SQLite leg passes on the tree without the `serialize()` repair,
as its own header comment says (SQLite serialises writers). Only the Postgres leg, which is not run
here, can show B2's race, and even there five rounds of two pushes may not hit the window. This is
acceptable as a regression guard for CI, but it is not proof that the repair works.

Expected: nothing required. A stronger guard would hold the first push inside its transaction (for
example a test hook or a store wrapper that delays after `putCatalogDefs`) so the race is forced on
Postgres.

## Summary

Every round-1 blocker is repaired, and T1 and T3 failed first. One blocker is open: the S3 repair left
the AC-01 test asserting the old key limit, so `pnpm test` is red on comb/RL-5 (B3). S7 to S9 are
suggestions.
