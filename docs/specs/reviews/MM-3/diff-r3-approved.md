Verdict: APPROVED | Round: 3 | Blocking-open: 0

# Review of the MM-3 diff, round 3

Reviewed cold: `git diff feat/my-mesh-assign...comb/MM-3` (head `385d5c1`), against
`docs/specs/MM-3.md` (revision 3 plus the open questions). I read the spec rounds `r1`–`r3` and diff
rounds 1 and 2 first. This round looks at the commits after round 2 (head `a6b1d8a`): developer
`ade0cd2`, test-writer `9a649dc`, merges `47979a6`, `385d5c1`. The merges add nothing beyond their
parents.

## Checks

On exported copies (`git archive` into a scratch folder; nothing was checked out in the integration
worktree):

- `pnpm check` (= `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm build`) on
  `comb/MM-3`: passes. 57 test files, 997 passed, 61 skipped. The Postgres legs were **skipped**
  (`MESH_TEST_PG_URL` unset).
- `pnpm test:web` (Playwright) on `comb/MM-3`: passes, 21 of 21, including all five AC-32 tests.
- Fail-first of this round's new tests, on the pre-fix head `e2259d4` with the `comb/MM-3` test files
  and `test/helpers/world.ts`:
  - fail there: `test_AC38_take_removes_and_no_done_after`, `test_AC38_reopen_removes_and_no_done_after`,
    and the hub-link test "without an offer waiting for a retry, an offline pull sends nothing before
    the probe backoff";
  - pass there (expected, they guard behaviour that already worked): `test_AC27_launch_accepts_and_starts_step_header`,
    `test_AC40_launch_new_sid_step_header` (the header path bound the sid before `906db7c`, as round 2
    S1 said), and the two hub-link tests for a waiting retry (`0dd6e5f` already probed at once).
    AC-27 and AC-40 keep their earlier tests that failed first.
- Not run: `pnpm schemas` (no route or protocol change this round; `test_AC33_openapi_current`
  passes), any Postgres leg (no store change this round), Playwright fail-first on the base (the base
  has no `section.offers`).

## Round 2 findings

- B1 (AC-32 test broken by the goal title): **fixed**. `openMine` uses `exact: true` and the goal is
  titled `"Offers for bob"`; `pnpm test:web` is green.
- S1 (launch tests without `X-Mesh-Step`): **fixed**. `World.hook` takes hook headers; both launch tests
  have a `_step_header` twin; the open question is corrected.
- S2 (round 1 S2/S3/S6 untested): **partly fixed**. Takeover, reopen and the offline-pull probe are
  tested now. Dropped step, design replan and `forgetOffers` are not (S3 below, REPEAT).
- S3 (retry may pick another session): **fixed** in code (`offerPicks` keeps the pick per message
  until acked or no longer pending; a retry sends the same sid). No test (S2 below).
- S4 (`mesh accept` does not reserve): **fixed** in code (`localPicks` around the hub call). No test
  (S2 below).
- S5 (open-question labels): **fixed** ("diff round 1 …").

## Blockers

None.

## Suggestions

### S1 (NEW, impl) A retry reuses its reserved session without checking it is still free

`src/daemon/daemon.ts:653`–`656`: on a retry, the session in `offerPicks` is used again if it has not
ended, even when it now holds a step. The reservation keeps other offers and the default
`mesh accept` away, but a hook with `X-Mesh-Step`, the agent's own claim, or `mesh accept --session`
(S4) can still bind it meanwhile. If the first call never reached the hub, the retry then accepts a
second step for the same sid (the hub does not check that the sid already holds a step) and
`bindOffered` overwrites the local step. In the other direction, if the reserved session ended, the
fallback picks a new session while a replayed answer names the ended sid; the code then binds the new
session locally although the hub holds the step for the ended one.

Expected: on a retry, reuse the reserved session only if it holds no step or holds this step; when the
replayed answer names a sid that is no longer live, do not bind another session locally (list the
offer or log it) rather than diverge from the hub.

### S2 (NEW, test) The round 2 S3/S4 repairs have no tests

`ade0cd2` changes the daemon's offer reservation, but no test failed first for it:
- after a lost reply, a second auto offer in a later pull does not pick the reserved session, and the
  retry sends the same `sid`;
- an auto offer handled while `POST /local/accept` waits for the hub does not pick that session.

Expected (test-writer): World tests with a hub call that times out once (as the AC-39 tests do) and
two auto offers / one `mesh accept` racing an auto offer, asserting the sids sent to `/accept`.

### S3 (REPEAT of round 2 S2, test) Dropped step, design replan and `forgetOffers` are untested

The accepted offer is also removed for a step dropped by a new plan (`src/core/dag.ts:134`) and on a
design replan (`src/hub/service.ts:989`), and handled offers are forgotten after an ack
(`forgetOffers`, `src/daemon/daemon.ts:606`–`611`). No test covers these. Open-question decisions,
not ACs, so not a blocker.

Expected (test-writer): a World test per hand-over path asserting no `offer` and no `offer_done`
afterwards, and a daemon test that an acked offer no longer listed is dropped from the handled set.

### S4 (NEW, impl) `mesh accept --session` ignores reservations

`src/daemon/daemon.ts:705`: a named target is taken even when an in-flight or retrying auto offer
reserved it (`reservedForOffer`). The person chose the session, so this is minor, but the two offers
then race for one session as in round 1 B1. Expected: refuse with 409 ("session is being given an
offered step") when the named session is reserved.

## Checked and found correct

- `offerPicks` is set before the first `await`; refusal deletes it before the ack; success binds,
  then deletes it, then acks. `forgetOffers` drops picks only for messages neither pending nor in
  flight. `localPicks` is added synchronously after the pick and released in `finally`.
- Developer commit `ade0cd2` changes only `src/daemon/daemon.ts` and the spec's open questions (no
  test). Test-writer commit `9a649dc` changes only tests, the test helper `test/helpers/world.ts` and
  the spec's open questions (no product code).
- No new test asserts on source text. No team-, company- or person-specific names.
- Privacy, auth, and SQLite/Postgres parity are unchanged since round 2 (this round changes no hub,
  store or route code).
