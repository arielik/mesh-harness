Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 3

# Review of spec MM-3, round 1

Reviewed cold: `docs/specs/MM-3.md` (Draft revision 1, commit 35a94f1). I checked it against
`docs/analysis/2026-11-11-my-mesh-and-assign.md` (sections MM-3, Safety and privacy, Not in scope)
and the code on `feat/my-mesh-assign`: `src/hub/{app,service,config}.ts`, `src/core/{claims,visibility}.ts`,
`src/store/hub-store.ts`, `src/protocol/{goal,hub,hub-api}.ts`, `src/daemon/{daemon,hub-link,tools}.ts`,
`test/schemas.test.ts`, `test/helpers/world.ts`, `src/daemon/inventory.test.ts`. There are no earlier
MM-3 rounds, so every finding is NEW.

## Checks

This is a spec review, so there is no code to build. I ran none of `pnpm lint`, `pnpm typecheck`,
`pnpm boundaries`, `pnpm test`, `pnpm build` (`pnpm check`), `pnpm schemas` or `pnpm test:web`. I
used only `git`, `grep`, `sed` and file reads.

## What already matches the code

- **No migration.** Steps (`step.value`), goals (`goal.value`) and machine facts (`machine.extra`)
  are JSON columns on both engines. `message.to_sid` is `NOT NULL TEXT`, so `""` can be stored.
  `SCHEMA_VERSION` stays 6.
- **Older daemons.** A v0.1.10 daemon acks a message with no matching session as `failed`
  (`hub-link.ts` `pullInbox` → `receive` → `"unknown"`). The Compatibility section describes this
  correctly.
- **Route rule.** `member` with no scope means service tokens get 403 (`allowed()`). AC-07 checks
  this. `HUB_API` has `tag`, and the OpenAPI route-table test (`test/schemas.test.ts`) compares
  method, path, rule and scope, so AC-33 can fail.
- **Releases and stick.** `releaseStep` emits `step.released` and not `step.ready`, so "a released
  step is not re-offered" holds. Every other path that makes a step ready emits `step.ready`
  (create, approve, done, gate, resume, replan), so the stick hook has one place to attach.
- **POST idempotency.** It is generic in `app.ts`: only 2xx JSON replies are stored.
- **Scope.** No creep. `POST /v1/goals/:id/withdraw` is the only route not in the design, and the
  design's "until withdrawn" needs it (open question 2). `mesh setup --accept/--assignments` is the
  minimum needed to set config the design names. Names are generic.

## Blockers

### B1 (NEW) The offering and accepting machine is taken from a `sid` the caller supplies, so a caller can bypass the claim guard and fake a `machine:` match

These rows take the machine from the client-supplied `sid`:
- the assign route: "`byMachine`: machine of sid (else of the token)";
- accept: "the machine of `sid` (else of the token) is not `offer.to.machine`";
- the claim guard: "a claim whose machine (of `sid`, else of the token) is the target machine succeeds".

The existing `machineOf(actor, sid)` (`service.ts:751`) looks the sid up in the hub session table
and never checks that the session belongs to the caller. Session sids of step-holding sessions are
listed to every member in `/v1/live`. Two failures follow:
1. **Claim guard bypass.** Carol claims or accepts a step offered to bob's machine B. She passes
   the sid of any session on B and gets 200, though the guard's whole point is to answer
   `409 <id> is offered to <B>`.
2. **Fake `machine:` match.** Alice's machine policy is `["machine:m1"]` (m1 is her other
   machine). Carol assigns with a sid of a session on m1. `byMachine` becomes m1, so `auto: true`.
   Alice's daemon then claims and pastes a brief into one of her sessions, or, with
   `assignments: "launch"`, starts a process. This breaks the design's safety rule: "starting a
   process on a machine because of a hub message happens only … for senders its policy accepts".

Fix: for `byMachine`, the accept check, the claim guard and the decline policy check, take the
machine from the token (`actor.machineId`). Use `sid` only when that hub session belongs to
`actor.userId` and sits on the token's machine. Otherwise 403 (e.g. `session <sid> is not yours on
this machine`), or ignore it. Spell out the rule once under "Hub HTTP API". Add an acceptance
criterion (World):
- assign, accept and claim with another user's sid on the target machine are refused, or treated
  as made from the token's machine;
- a `machine:` rule never matches through a borrowed sid.

### B2 (NEW) Offer transitions are not atomic with claims, so the guard and the one-offer rule fail under concurrency (Postgres replicas)

The spec gives no rule on concurrency. In the code:
- `claimStep` runs in `store.tx` without `serialize()`. It saves through `saveStepIf(next, prev)`,
  which compares only `state` and `holder_user` (`hub-store.ts:640`).
- An offer changes neither column. The step stays `ready` with no holder.

So with two hubs on one Postgres (a supported setup, `test/m46-replicas.test.ts`):
- **Claim racing an assign.** A claim that read the step before the offer still passes its
  conditional update, and it overwrites `step.value`, which erases the offer. The target machine
  has already been messaged. The daemon's accept then gets 409, and a `step.offered` event points
  at an offer that no longer exists.
- **Two concurrent assigns.** Both pass the "already offered" check and both save. That gives two
  events, two machine-wide messages, and the last write wins.
- **Expiry or withdraw racing an accept.** An accept that read `offered` saves `accepted` over a
  committed `expired`/`withdrawn`, after `step.offer_expired` and the report-back were already sent.

Fix:
- State that assign, accept, decline, withdraw, expiry and the stick offer run in `goalTx`
  (`serialize()`).
- State that the claim save is conditional on the offer too. Either claim reads under the same
  lock, or `saveStepIf` also compares the offer state and `at`; the latter needs a store contract
  row and a contract test on both engines.
- Add a concurrency criterion like MM-2's AC-09 (two hubs on one store; the Postgres leg required
  when its URL is set):
  - concurrent assign + assign: exactly one 200 and one 409;
  - concurrent assign + third-party claim: never a claimed step whose last `step.offered` has no
    end event, and never a lost offer after a 200 assign;
  - concurrent expire + accept: exactly one of `step.offer_expired` / `step.accepted`.

### B3 (NEW) The `offer_question` report-back tells the offerer to run a command the hub refuses

The message text ends `Answer with: mesh answer <question id> <text>`. But `HubService.ask` sets
`toUsers` to the asker and the goal owner only, and `answer()` answers
`403 question <id> is not addressed to you` to anyone else who is not an admin (`service.ts:1036–1060`).
Under the spec's own rule, any member who may claim may assign. So on a team goal the offerer is
often neither, and the instruction the hub sends fails. AC-19 would then lock in a broken
instruction.

Fix, either one:
- when a question is asked on a step whose offer is `accepted`, add `offer.by` to `toUsers`, and
  say so in the route table with an acceptance criterion for an offerer who is not the goal owner
  answering it;
- or drop the `Answer with:` hint when the offerer is not in `toUsers`.

## Suggestions (non-blocking, all NEW)

- **S1 Idempotency of the daemon's accept.** Under (2) the spec says "Hub unreachable: the message
  stays unacked and is handled on a later pull". It also says "once per hub message id (a second
  pull of the same id does nothing)". These conflict. A lost reply to a successful
  `POST /accept` makes the retry answer 409 `has no open offer`. The daemon then acks `failed` and
  binds nothing, while the hub has the session holding the step. Specify:
  - the accept, decline and claim calls carry an `Idempotency-Key` derived from the hub message id
    (e.g. `offer-<id>`), so a retry replays the first 2xx;
  - the "handled" mark is recorded only after the hub answered;
  - where that mark lives (daemon store table, survives a restart?).

  The daemon store (`src/store/daemon-store.ts`) has no row for machine-wide messages today, so
  this is a contract change the spec does not list.
- **S2 An open offer on a step that leaves `ready` some other way.** A new plan can drop the step,
  or a replan can block it. The offer then stays `offered` forever: expiry and `GET /v1/offers`
  look only at `ready` steps, and the goal page keeps saying "offered to …". Say that such an offer
  ends as `withdrawn` with `reason` (e.g. `step dropped`), or that views ignore it.
- **S3 `offer_done`/`offer_failed` after a release.** `release()` keeps `offer` (it spreads the
  step), so after an accepted step is released and someone else claims it, the offerer still gets
  "offered to m2 is done". Limit the report-back to the holder that accepted, or end the offer on
  release.
- **S4 Which policy decline evaluates.** When the offer names a session that has an override, the
  decline row does not say whether it uses the session override or the machine policy. Assign uses
  "session override ?? machine". Say the same for decline.
- **S5 Privacy of a named target session.** `step.offer.to.sid`, `OfferLine.to`
  (`m2/<session name>`) and the `step.offered` payload `sid` reach every member (`GET /v1/steps`,
  goal page, event feed). This includes a `me` session of the offerer's own that is not otherwise
  visible to the team. Either state this as an accepted exposure in the Safety part (the owner
  chose to target it), or show the session part only to its owner.
- **S6 Under `shareSessions: steps` an idle session cannot be targeted.** The hub has no record of
  it, so `m2/perf` answers 404. Add this to Open questions or to the how-to, so the 404 is not
  read as a bug.
- **S7 `/local/accept` reads `GET /v1/steps/:id`,** which returns `StepView` (`{context, facts}`)
 . Name the field (`context.step`) so the
  developer and the blind tests agree.
- **S8 Who updates `src/daemon/inventory.test.ts`.** The Compatibility section says that test
  "is updated". Name the test-writer as the one who changes it, so the diff review's "developer
  changed no test" rule is not tripped.
- **S9 `GoalAssignResult.auto`** with `steps: []` (stick, nothing ready) is undefined by the
  contract. Say it is the policy verdict for the target at assign time.

## Acceptance criteria

All criteria name a surface and can fail. AC-31 (TUI keys) and AC-33 (docs) are partly review-only,
as in MM-1 and MM-2, which is acceptable. No criterion covers B1 or B2. Add the criteria named
above.

## Counts

Blockers 3 (B1–B3), suggestions 9 (S1–S9). Total 12: NEW 12, REPEAT 0, REGRESSION-OF-OWN-REPAIR 0.
