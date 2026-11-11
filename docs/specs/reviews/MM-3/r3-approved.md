Verdict: APPROVED | Round: 3 | Blocking-open: 0

# Review of spec MM-3, round 3

Reviewed cold: `docs/specs/MM-3.md` (Draft revision 3, commit 7dfd9d2). I read round 1
(`r1-changes-requested.md`) and round 2 (`r2-changes-requested.md`) first, then the whole spec, then
the revision 3 diff (`git diff 42486ac 7dfd9d2`). I checked it against
`docs/analysis/2026-11-11-my-mesh-and-assign.md` (MM-3, Safety and privacy, Not in scope) and the
code on `feat/my-mesh-assign`:
- `src/hub/service.ts`: `machineOf`, `claimStep`, `message`, `sync`, `inbox`;
- `src/daemon/daemon.ts`: the `SessionStart` bind claim (`applyEvent`);
- `test/helpers/world.ts`: default `shareSessions`, `restart`, the per-person `fetch` wrapper, `startHubAgain`.

## Checks

This is a spec review, so there is no code to build. I did not run `pnpm lint`, `pnpm typecheck`,
`pnpm boundaries`, `pnpm test`, `pnpm build` (`pnpm check`), `pnpm schemas` or `pnpm test:web`. I
used only `git`, `grep`, `sed` and file reads.

## Round 2 findings

| Finding | Status |
|---|---|
| B4 unknown sid refused (REGRESSION-OF-OWN-REPAIR) | Fixed. The "Caller machine" rule now defines a **foreign `sid`**: one the hub has that belongs to another user, or to another machine than the token's. Only a foreign `sid` gets 403. A `sid` the hub does not know is used as given, and the offer checks still use the token's machine. The accept and claim rows use the term, and AC-35 and the new AC-40 test it. Open questions records the change. |
| S10 report-back to an unknown offering session | Not addressed. REPEAT, see below. |
| S11 AC-35 clause that the API cannot build | Not addressed. REPEAT, see below. |
| S12 test seams for AC-36 and AC-39 | Not addressed. REPEAT, see below. |

### B4 checked against the code

- **Both B1 holes stay closed.** A borrowed sid of bob's session on B is known to the hub, so it is
  foreign: AC-35 gives 403. An unknown sid on carol's machine C opens nothing, because the guard
  uses the token's machine C. AC-40 gives 409 on claim and 403 `not to this machine` on accept.
  The `machine:` fake match also stays closed. `byMachine` is the token's machine, or absent for a
  token without a machine. It is never looked up from an unknown sid.
- **The bind path works.** `daemon.ts` `applyEvent` posts `/v1/steps/<id>/claim {sid}` at
  `SessionStart`, before any sync, using the daemon's machine token. With an open offer to that
  machine, the caller machine is the target, so the claim is an accept. AC-40 (launch) and AC-27
  then hold.
- **"The next sync attributes it to the token's machine" is true.** `sync()` calls
  `upsertSession(s, actor.userId, machine)` and skips only sessions of another user. Under `steps`,
  `syncedSessions` sends the session once it holds the step.
- **AC-40 can be built.** World's default `shareSessions` is `"steps"` (`world.ts:117`), so
  "never synced" is the default state of an idle session.
- `OfferLine.accepted` already allows "only the machine name when the hub has no session record",
  so it fits an accept by an unknown sid.

No new contradiction between criteria. AC-20, AC-21, AC-23, AC-24 and AC-27 no longer conflict with
AC-35.

## Blockers

None.

## Suggestions (non-blocking)

- **S10 (REPEAT) Report-back to an offering session the hub does not know is dropped.** Revision 3
  makes this more likely. AC-40 now states that `mesh_assign` from a step-less session under
  `steps` is accepted with `bySid` = that sid. But `HubService.message()` (`service.ts:197`)
  queues nothing for a sid it has no record of. That coordinator gets no `offer_*` message at all,
  and World's default level is `steps`. The spec states the rule ("none when it is absent, unknown
  or ended"). The gap still appears in neither the how-to nor Open questions. Either:
  - queue to `offer.byMachine` with `toSid = bySid` when the session is unknown;
  - or add the gap to Open questions and the how-to ("under `shareSessions: steps` a coordinator
    session that holds no step hears nothing back; use `me`"), and add an AC-19 case that fixes
    the behaviour.
- **S11 (REPEAT) AC-35's "bob's token on B with the sid of carol's session on B".** `sync()`
  records a session with the syncing token's user and machine, so the API cannot create carol's
  session on B. Say the test seeds it through `w.hubStore.upsertSession`, or use bob's own session
  on his other machine B2. The second case is reachable and tests the "another machine" half of
  the foreign rule.
- **S12 (REPEAT) Name the test seams for AC-36 and AC-39.** World runs one hub (`startHubAgain`
  replaces it). The per-person `fetch` wrapper fails a request *before* it reaches the hub
  (`p.offline`), not after the hub committed. Say that the test side adds both seams:
  - a second hub on `w.hubStore`;
  - a "drop the next response" switch on the wrapper.

  Then the developer will not build product hooks for them.
- **S13 (NEW) Check that the report-back session belongs to `offer.by`.** A sid that is unknown at
  assign time is stored as `bySid` without an owner check. If the hub later records that sid for
  another user, `offer_*` texts go to that user's session. Those texts include the decline note,
  the done/failed summary and the question text. Sids are random, so this is unlikely. It costs one
  condition: send the report-back only when the hub's record of `bySid` has `userId === offer.by`.
  Say so in the Report back paragraph.

## Scope, consistency, privacy

- **Scope.** Revision 3 changes only the Caller machine rule, the accept and claim rows, AC-35, the
  new AC-40 and one Open questions entry. There is no scope creep, and names stay generic.
- **Routes.** There are still seven new routes, all `member` with no scope. AC-33 compares them
  with the OpenAPI route-table test, so it can fail.
- **Stores.** No migration, and `SCHEMA_VERSION` stays 6. `MachineRow.accept` is covered on both
  engines by AC-06. Concurrency still relies on `goalTx`, with no store contract change.
- **Idempotency.** The daemon's `Idempotency-Key: offer-<message id>` is unchanged and fits the
  generic POST replay in `app.ts`.
- **Privacy.** An unknown sid carries no data to the hub beyond the id itself. S13 is the only new
  privacy edge.

## Acceptance criteria

All 40 criteria name a surface and can fail. AC-31 and AC-33 are partly review-only, as in earlier
rounds, which is acceptable. AC-40 can fail on each clause, and its FAIL column is concrete.

## Counts

Blockers 0. Suggestions 4 (S10–S13). Total 4: NEW 1, REPEAT 3, REGRESSION-OF-OWN-REPAIR 0.
