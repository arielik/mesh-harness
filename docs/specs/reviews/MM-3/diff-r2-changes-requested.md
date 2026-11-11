Verdict: CHANGES REQUESTED | Round: 2 | Blocking-open: 1

# Review of the MM-3 diff, round 2

Reviewed cold: `git diff feat/my-mesh-assign...comb/MM-3` (head `a6b1d8a`), against
`docs/specs/MM-3.md` (revision 3 plus the open questions). I read the spec rounds `r1`–`r3` and
diff round 1 first. This round looks at the commits after round 1 (head `e2259d4`):
developer `78bfca9`, `906db7c`; test-writer `379f534`, `7121175`; merges `48d4473`, `62608d8`,
`a6b1d8a`. The merges add nothing beyond their parents except the resolved list of open questions
in the spec.

## Checks

On exported copies (`git archive` into a scratch folder; nothing was checked out in the integration
worktree):

- `pnpm check` (= `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm build`) on
  `comb/MM-3`: passes. 57 test files, 990 passed, 61 skipped. The Postgres legs were **skipped**
  (`MESH_TEST_PG_URL` unset).
- `pnpm test:web` (Playwright) on `comb/MM-3`: **fails**, 18 passed, 1 failed, 2 did not run (B1).
  A probe on the scratch copy only (not committed), with the goal title changed: 21 passed.
- Fail-first of the new vitest tests:
  - on the pre-fix head `e2259d4` with the new test files: `test_AC27_launch_accepts_and_starts`,
    `test_AC20_two_offers_one_idle_session` and `test_AC40_launch_new_sid` fail;
    `test_AC27_launch_other_machine_offer` passes (a refusal test; the refusal already existed);
  - on the base `feat/my-mesh-assign`: both AC-27 tests fail (no `mesh accept`).
- Not run: `pnpm schemas` (no route changed this round; `test_AC33_openapi_current` passes), any
  Postgres leg, Playwright fail-first on the base (the base has no `section.offers`, so the AC-32
  tests cannot pass there).

## Round 1 findings

- B1 (two auto offers, one session): **fixed**. `offerSids` keeps a picked session out of other
  picks (`src/daemon/daemon.ts:642`); `test_AC20_two_offers_one_idle_session` failed first and passes.
- B2 (AC-27 untested): **fixed**. `test_AC27_launch_accepts_and_starts` compares the tmux calls with
  `mesh run <repo> --step <step>`, checks `accepted` and the new sid as holder. Failed first.
- B3 (AC-32 untested): the five Playwright tests exist, but one is broken and stops two others. See B1
  below.
- S1 (developer edited tests): **fixed** this round. `78bfca9` and `906db7c` change no test;
  `379f534` and `7121175` change no product code.
- S2 (offer kept on reopen and takeover): **fixed** in code and recorded as an open question. No test
  (S2 below).
- S3 (probe on every pull): **fixed** (`retryDue`, `src/daemon/hub-link.ts:351`). No test (S2 below).
- S4 (AC-40 launch clause): **fixed** by `test_AC40_launch_new_sid` and the AC-27 test.
- S5 (seven tests passed on the base): no action needed; they guard unchanged behaviour.
- S6 (`offersHandled` grows): **fixed** (`forgetOffers` after each pull).
- S7 (stale comment): **fixed**.

## Blockers

### B1 (REGRESSION-OF-OWN-REPAIR, test) The AC-32 offer-row test fails, and the decline test never runs

`test/e2e-web/mine.spec.ts:205` names the goal `"Offers on Mine"`. Its link is on the page, so
`openMine` (`page.getByRole("link", { name: "Mine" })`, line 41, not exact) matches two links:

```
Error: locator.click: Error: strict mode violation: getByRole('link', { name: 'Mine' }) resolved to 2 elements:
    1) <a class="" href="#/mine">Mine</a>
    2) <a href="#/goal/G10">Offers on Mine</a>
```

`test_AC32_mine_offer_row` fails, and `test_AC32_decline` and `test_AC32_live_attention_code` do not
run. So the row text, `mesh accept <step>` and the `Decline` clause of AC-32 have no passing test, and
`pnpm test:web` is red. The product is fine: with the title changed to one without "Mine" (probe on
the scratch copy), all 21 Playwright tests pass.

Expected: a goal title without the word "Mine" (or `openMine` with `exact: true`), and `pnpm test:web`
green.

## Suggestions

### S1 (NEW, test) The launch tests send the first hook without `X-Mesh-Step`

`test_AC27_launch_accepts_and_starts` (`test/m45-cli.test.ts`) and `test_AC40_launch_new_sid`
(`test/assign.test.ts`) send the new window's `SessionStart` with `World.hook`, which passes no
`X-Mesh-Step` header. A real hook sends it: `mesh run --step` puts `MESH_STEP` in the window
(`src/cli/mesh-commands.ts:563`) and the installed hook sends `X-Mesh-Step: ${MESH_STEP}`
(`src/claude/installer.ts:37`). With that header, the code before `906db7c` already claimed with the
new sid (`stepHint`). So these tests failed first only because of the harness. The test-writer's open
question ("on the pre-change base … `holderSid` stays unset") is true only for a hook without the
header. The fix `906db7c` (bind a taken-over placeholder's step when the hook has no hint) does no
harm. It adds a path for agents or hooks that do not send the header.

Expected: also cover the real path (the first hook with the step header, e.g. by letting `World.hook`
pass hook headers), and correct the open question so it says the gap is a hook without
`X-Mesh-Step`.

### S2 (NEW, test) The round 1 fixes S2, S3 and S6 have no tests

These behaviour changes are not tested:

- an `accepted` offer is removed on reopen (`src/core/dag.ts:161`, `:172`), on a dropped step
  (`dag.ts:134`), on a replan of the design (`src/hub/service.ts:989`) and on a takeover
  (`service.ts:1457`);
- an offline pull keeps the probe backoff unless an offer waits for a retry
  (`src/daemon/hub-link.ts:351`);
- handled offers are forgotten after an ack (`forgetOffers`).

They are open-question decisions, not ACs, so this is not a blocker.

Expected (test-writer): World tests. After a takeover (and after a reopen) of a step with an accepted
offer, the step has no `offer`, and the later holder's `step.done` sends no `offer_done`. A hub-link
test: offline with `retryDue` false, there is no `/health` before the backoff; with it true, there is
one at once.

### S3 (NEW, impl) A retry after a lost reply may pick a different session, or none

`src/daemon/daemon.ts:644`–`658`: when the hub call fails without an answer, `finally` drops the
picked sid from `offerSids`. The hub may already hold the step for that session. Until the retry,
another offer can pick the same session (the B1 case again, across pulls). On the retry,
`pickSession` runs again. If no idle session is left, the offer is launched or acked `listed`,
although the hub has it `accepted` for the first session. The replay binding (line 655) helps only
when a session is picked again.

Expected: keep the picked sid per message id until that message is acked, keep it reserved, and send
the same sid on the retry.

### S4 (NEW, impl) `POST /local/accept` does not reserve its session

`src/daemon/daemon.ts:695` leaves out sessions that offers reserved. It does not reserve its own pick
during its hub call, so an auto offer handled at the same time can pick the same session. Expected:
add the sid to `offerSids` around the `/accept` call, as `handleOffer` does.

### S5 (NEW, docs) Open-question labels name the wrong round

`docs/specs/MM-3.md:416`, `:421`, `:426` say "round 3 S2/B1/S3". These are findings of diff review
round 1 (spec round 3 was an approval with other findings). Expected: "diff round 1 …".

## Checked and found correct

- `offerSids` is reserved before the first `await` (no gap between pick and reserve) and released in
  `finally`. A named target session that another offer reserved makes the offer fall to launch or
  listed, not to another session (AC-03 holds).
- The replay binding binds the holder the hub names only if that session is live here.
- `forgetOffers` forgets only offers whose ack the hub took and that the inbox no longer lists. Offers
  still in flight are kept in `offersAwaitingRetry`.
- Removing an accepted offer on reopen, dropped steps, design replan and takeover touches no other
  offer state. Offers on steps that leave `ready` still end through `endOffersLeavingReady`.
- `906db7c`: the placeholder sid survives the takeover (`bind` clones the placeholder), so
  `placeholders.has(sid)` is right. The claim uses `bind:<sid>:<step>` as its idempotency key and is
  sent once per session and step.
- Privacy, auth, and SQLite/Postgres parity are unchanged since round 1 (this round changes no store
  code and no route).
- No new test asserts on source text. No team-, company- or person-specific names.
