Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 3

# Review of the MM-3 diff, round 1

Reviewed cold: `git diff feat/my-mesh-assign...comb/MM-3` (head `e2259d4`), against
`docs/specs/MM-3.md` (revision 3 plus the implementation open questions). I read the spec review
rounds `r1`–`r3` first, then the role files, the spec, the test plan
(`docs/specs/plans/MM-3-test-plan.md`), the commit split (developer commits `1c094b8`…`d91715e`,
`0dd6e5f`; test-writer commits `b5da088`, `f54e99d`, `f86b075`; merges `a8761fd`, `085c8bb`,
`e2259d4`) and the full diff of `src/hub/service.ts`, `src/hub/app.ts`, `src/hub/config.ts`,
`src/store/hub-store.ts`, `src/core/offers.ts`, `src/daemon/daemon.ts`, `src/daemon/hub-link.ts`,
`src/daemon/tools.ts`, `src/cli/offer-commands.ts`, `src/cli/mesh-commands.ts`, `src/cli/tui/tui.ts`,
`src/cli/show.ts`, `src/protocol/*`, `web/src/*`, and the docs.

This is the first diff round. Every finding is NEW.

## Checks

I ran these on an exported copy of `comb/MM-3` (`git archive`, in a scratch folder; nothing was checked
out in the integration worktree):

- `pnpm check` (= `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm build`): passes.
  57 test files, 987 passed, 61 skipped. The Postgres legs were **skipped** (`MESH_TEST_PG_URL` unset),
  so the AC-06 contract and the AC-36 Postgres leg did not run.
- Fail-first: the new and changed test files on an export of `feat/my-mesh-assign` (the base) with
  `vitest run`. Every new MM-3 test failed there except seven (see S5).
- A probe test (not committed) for B1 below, on the `comb/MM-3` export.

Not run: `pnpm schemas` (`test_AC33_openapi_current` passes, so the committed document is current),
`pnpm test:web` (Playwright; there are no MM-3 Playwright tests to run, see B3), any Postgres leg.

## Blockers

### B1 (NEW, impl) Two auto offers in one inbox pull bind both steps to one session

`src/daemon/daemon.ts:555` starts `handleOffer` without awaiting it, for every machine-wide message
of one pull. Each call runs `pickSession(this.sessions, …)` (line 620) and then awaits the hub accept.
The session is marked as holding the step only after the reply (`bindOffered`, line 628). So two
`auto` offers in one pull both pick the same idle, step-less session. The hub accepts both with the
same `sid`, because a claim does not check whether the sid already holds a step.

Probe (on the export, not committed): bob's machine B with one idle session in `svc`; bob assigns
goal `G1` with two ready steps from B2 to `m2` (`auto: true`, two messages); one `pullInbox`.
Result: `G1.a` and `G1.b` are both `claimed`, both `offer.state: "accepted"`, both held by the same
sid. Locally the session is bound only to `G1.b`, so `G1.a` is held at the hub by a session that
is not working on it. A goal assign (AC-17) or a stick (AC-18) produces this case.

This breaks the spec's daemon contract: auto-accept picks a session that "holds no step"
(`pickSession`), and the brief is queued for that session's one step.

Expected: offers handled in one process never pick a session that another offer already picked.
For example, handle machine-wide offers one at a time, or reserve the picked sid (mark it
taken/bound) before the hub call and release it when the hub refuses. The second offer then finds
no idle session: it is listed (or launched under `launch`). Add a World test (test-writer) for two
auto offers and one idle session: one offer accepted and bound, the other `listed` and still
`offered` at the hub.

### B2 (NEW, test) AC-27 has no test

No `test_AC27_*` exists in the diff. The test plan names `test_AC27_launch_accepts_and_starts` in
`test/m45-cli.test.ts`, but that file is not changed. `mesh accept <step> --launch`
(`src/cli/offer-commands.ts`, `acceptCommand`) is never run by any test, so AC-27 cannot fail.
(The `test_AC27_*` names in `src/daemon/hub-link.test.ts` belong to MM-1.)

Expected: a CLI test with the fake runner. A step offered to this machine; `mesh accept <step>
--launch` makes the same tmux call as `mesh run <repo> --step <step>`; after the new session's first
hook (a sid never synced, which also covers the AC-40 launch clause), the hub has
`offer.state: "accepted"` held by that sid. It must fail on the base.

### B3 (NEW, test) AC-32 has no test

`test/e2e-web/mine.spec.ts` and `test/e2e-web/goals.spec.ts` are not changed, and no `test_AC32_*`
exists. The test plan lists five Playwright tests. The Mine tab "Assigned to you" section, the
`Decline` button, the empty text and the step panel `p.offer` (`web/src/mine.tsx`,
`web/src/goals.tsx`) are untested, so AC-32 cannot fail. Its surface is Playwright, which is not in
`pnpm check`, but the criterion still needs a test.

Expected: the Playwright tests from the test plan. An offer seeded through the hub API; `li.offer`
with the step id and `mesh accept <step>`; `Decline` removes it within 20 s and the hub has it
`declined`; with no offers, `Nothing is assigned to you.`; the goal page step panel `p.offer` equals
`offerText`.

## Suggestions

### S1 (NEW, process) The developer edited tests

Developer commits changed test files:
- `1c094b8`: `DaemonConfig` fixtures in `src/daemon/daemon.test.ts`, `src/daemon/inventory.test.ts`,
  `test/helpers/world.ts`, `test/m2-flow.test.ts`, `test/opencode.test.ts`;
- `8f6903c`: the MCP tool-list assertion in `test/m2-flow.test.ts`;
- `958595d`: `src/cli/tui/__snapshots__/render.test.ts.snap`;
- `d91715e`: the version pin in `test/schemas.test.ts`.

The role file forbids this ("Never create or edit a test, a fixture or a check"). The spec also
gives the inventory test update to the test-writer. The manual merge `a8761fd` kept the
test-writer's version of every one of these files: on `comb/MM-3` the snapshot is byte-equal to
`b5da088`, and the fixtures use the test-writer's `as DaemonConfig` form. So the tree has no
developer-written test content. This is not a blocker, but next time the developer should stop and
report that the type change breaks the fixtures.

### S2 (NEW, impl/spec gap) An accepted offer survives reopen and takeover

`release` removes an accepted offer, so later holders' work is not reported. Three other paths keep
the offer: `reopen` (`src/core/dag.ts:156`), `replan` reopening the design, and `takeStep`
(`src/hub/service.ts:1438`). Each leaves `offer.state: "accepted"` on a step that someone else then
works on. The next `step.done`/`step.failed` (`service.ts:1332`) or question then sends
`offer_done`/`offer_failed`/`offer_question` to the original offerer, and adds them to `toUsers`.
The spec defines only the release case. Its intent, "never reach the offerer for work a later holder
does", and the concepts guide sentence "Releasing an accepted step drops the offer, so later holders'
work is not reported" both suggest that reopen and takeover should do the same. Expected: an Open
question in the spec, and the same removal on reopen and takeover if the owner agrees.

### S3 (NEW, impl) `pullInbox` probes an offline hub on every pull

`src/daemon/hub-link.ts:344` (developer fix `0dd6e5f`) calls `probe(c, true)`, which skips the
backoff on every inbox pull (every `3 × deliveryMs` = 30 s, and on every wake). While the hub is
down, the daemon therefore sends `/health` every 30 s. The `PROBE_MAX_MS` backoff no longer holds,
and each failure doubles a backoff that the next pull ignores again. Expected: force the probe only
when an offer is pending a retry (an unacked machine-wide message seen before), or keep the backoff
and let AC-39 retry on the next due probe.

### S4 (NEW, test) AC-40's launch clause is untested

`test_AC40_launch_new_sid` from the test plan is missing. The hub side (an unknown sid from the
target machine accepts) is covered by the positive control in `test_AC40_carol_unknown_sid`, but
only via `/accept`. The launch path binds through the SessionStart `/claim`. Covered if B2's test is
written as described.

### S5 (NEW, test) Seven new tests passed on the base

`test_AC11_no_offer_unchanged`, `test_AC22_unknown_kind_failed`,
`test_AC22_session_messages_unchanged` (`test/assign.test.ts`), `test_AC29_old_snapshots_unchanged`
(`src/cli/show.test.ts`), `test_AC33_openapi_current` (`test/schemas.test.ts`),
`test_AC06_schema_version_6` and `test_AC06_machine_wide_message`
(`src/store/hub-store.contract.test.ts`). All of them guard unchanged behaviour that the spec
states, and each of these criteria also has tests that failed first, so nothing is lost. The
test-writer's report should list them as not fail-first.

### S6 (NEW, impl) `offersHandled` grows without bound

`src/daemon/daemon.ts:230` keeps every handled offer id for the life of the process. The entries
are small, but a long-running daemon never drops them. Expected: drop an entry once the ack
succeeded and the next inbox no longer lists the id.

### S7 (NEW, impl) Stale comment

`src/hub/service.ts:196`, on `saveStepFrom`, says "A claim does not wait for `goalTx`'s lock".
Since MM-3 a claim does wait (it runs in `goalTx`). Expected: update the comment.

## Checked and found correct

- Auth and visibility: caller machine and foreign-sid rules (`callerMachine`, `refuseForeign`) as in
  the spec. The claim guard, accept, decline and withdraw permissions. Ready-list filtering and
  ordering. `/v1/offers` and attention membership. Session targets limited by `sessionVisible`. All
  new routes are `member` with no scope (a service token gets 403).
- Concurrency: assign, accept, decline, both withdraws, claim, stick, offer-end paths and the expiry
  tick all run in `goalTx`. Expiry uses `saveStepIf`, so a double tick expires once.
- SQLite and Postgres parity: `accept` lives in the shared `machine.extra` JSON through one
  `touchMachine` code path (`forUpdate` dialect). No schema change; `SCHEMA_VERSION` stays 6.
- Idempotency: daemon accept and decline carry `Idempotency-Key: offer-<message id>`; AC-39 passes,
  including after a restart.
- No assertion on source text in the new tests (they read docs and generated files only). The
  test-writer commits change no product code.
- Docs: concepts, how-to, install guide, plan §5.6 (seven routes), events (five events), skill and
  OpenAPI are all updated. No team-, company- or person-specific names.
- AC-31 keys (review): `o` toggles the panel and refreshes every 5 s; ⏎ calls `client.accept`, `d`
  calls `client.decline`; the badge count comes from the same `offers()` call.
