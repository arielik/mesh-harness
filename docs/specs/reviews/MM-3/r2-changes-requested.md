Verdict: CHANGES REQUESTED | Round: 2 | Blocking-open: 1

# Review of spec MM-3, round 2

Reviewed cold: `docs/specs/MM-3.md` (Draft revision 2, commit a097137). I read round 1
(`r1-changes-requested.md`) first. I checked the spec against `docs/analysis/2026-11-11-my-mesh-and-assign.md`
(section MM-3, Safety and privacy, Not in scope) and against the code on `feat/my-mesh-assign`:
- hub: `src/hub/service.ts` (`goalTx`, `machineOf`, `claimStep`, `releaseStep`, `ask`, `answer`, `sync`, `inbox`, `tick`) and `src/hub/app.ts` (route table, idempotency);
- store: `src/store/hub-store.ts` (`serialize`);
- core: `src/core/{claims,visibility}.ts`;
- daemon: `src/daemon/hub-link.ts` (`syncedSessions`, `sessionMetadata`), `src/daemon/daemon.ts` (the SessionStart bind), `src/daemon/tools.ts`;
- tests: `test/m46-replicas.test.ts`.

## Checks

This is a spec review, so there is no code to build. I ran none of `pnpm lint`, `pnpm typecheck`,
`pnpm boundaries`, `pnpm test`, `pnpm build` (`pnpm check`), `pnpm schemas` or `pnpm test:web`. I
used only `git`, `grep`, `sed` and file reads.

## Round 1 findings

| Finding | Status |
|---|---|
| B1 borrowed `sid` | Fixed: the "Caller machine" rule, plus AC-35. The fix causes B4 below. |
| B2 concurrency | Fixed. Assign, accept, decline, withdraw, expiry, stick, offer-end and claim all run in `goalTx`, and AC-36 covers it. `goalTx` = `store.tx` + `serialize()` (the `events` lock on Postgres; `BEGIN IMMEDIATE` on SQLite), so no store contract change is needed. `tick()` already runs in `goalTx`. |
| B3 offerer cannot answer | Fixed: `toUsers` gains `offer.by`, plus AC-37. |
| S1 daemon retry | Fixed: `Idempotency-Key: offer-<message id>` and ack after the hub answers, plus AC-39. The `app.ts` idempotency is keyed by (key, user) and replays only 2xx, which fits. |
| S2, S3 offer outlives its step / release | Fixed ("Offer ends with its step", "Release", AC-38). |
| S4 decline policy | Fixed. |
| S5 privacy of the named session | Fixed (Privacy paragraph, concepts guide). |
| S6 `steps` share and named sessions | Fixed (how-to, Open questions). |
| S7 `context.step` | Fixed. |
| S8 who updates `inventory.test.ts` | Fixed. |
| S9 `GoalAssignResult.auto` | Fixed. |

No round 1 finding is open again as a REPEAT.

## Blockers

### B4 (REGRESSION-OF-OWN-REPAIR, from the B1 fix) A `sid` the hub has no record of is refused, which breaks accept for every session the hub has not synced

The new rule ("Hub HTTP API", Caller machine) says:
- a `sid` is used only when the hub has that session, it is the caller's and it sits on the token's machine;
- otherwise, on assign, accept, decline, or a claim of a step with an open offer → 403 `session <sid> is not yours on this machine`.

The hub often has no record of a legitimate session:
- **`shareSessions: steps`.** `syncedSessions` (`hub-link.ts:56`) sends only sessions that hold a
  step. `steps` is still a valid level, and existing configs keep it (MM-1). It is also what the
  daemon sends under `me` until the hub confirms the level (`hub-link.ts:290`). An idle, step-less
  session is therefore never known to the hub.
- **A fresh session under any level.** `mesh run --step` and the default `launchStep` bind at
  `SessionStart`. `daemon.ts:769` posts `/claim {sid}` right away, before any sync has carried
  the new session.

The result contradicts the spec's own criteria:
- AC-20, auto-accept of an idle session under `deliver`: the daemon's `POST /accept {sid}` gets 403 under `steps`, and races the sync under `me`.
- AC-21 (`launch`) and AC-27 (`mesh accept --launch`): the launched session's bind-claim of the offered step gets 403, so the offer is never accepted and the session holds nothing.
- AC-23 (`/local/accept`) and AC-24 `mesh_accept`: the same failure for any session the hub has not seen yet.
- AC-24 `mesh_assign` from a coordinating session that holds no step, under `steps`: 403 on assign. The design names exactly this case ("Coordinator: any session that uses `mesh_assign`").

The test-writer cannot satisfy AC-20/21/27 and AC-35 together as written unless every World session
is synced under `me` first. That would hide the defect, not test it.

Fix:
- Refuse a `sid` only when the hub **has** that session and it belongs to another user, or to a
  machine other than the token's machine. That alone closes both B1 holes.
- A `sid` the hub does not know, sent with a machine token: the caller machine is the token's
  machine, and the `sid` is used as given (`bySid`, the holder sid). The claim records it, and the
  next sync attributes it to that machine (`upsertSession(s, actor.userId, machine)`).
- A `sid` the hub does not know, sent with a token that has no machine: no caller machine, as today.
- Restate the 403 condition in the route rows and in AC-35, and add criteria (World):
  - under `shareSessions: steps`, the daemon auto-accepts an `auto` offer for an idle session the hub has no record of (200, `accepted`);
  - `mesh accept <step> --launch` / `launchStep` with a brand-new sid ends `accepted`;
  - `mesh_assign` from a step-less session under `steps` returns 200 with that `bySid`;
  - an unknown sid on carol's machine C still gets 409 `<id> is offered to <B>` on claim and 403 `… not to this machine` on accept. This shows that an unknown sid opens nothing.

## Suggestions (non-blocking, all NEW)

- **S10 Report-back to an offering session the hub does not know is silently dropped.**
  `HubService.message()` (`service.ts:197`) queues nothing when `getSession(toSid)` is missing.
  Under `steps`, a coordinator session holding no step is unknown, so it gets no `offer_*` message.
  This holds once B4 is fixed too. The rule "none when it is absent, unknown or ended" is
  consistent, but the main user story ("nobody hears back") then fails silently on the default
  level of every existing setup. Either:
  - queue the report-back to `offer.byMachine` with `toSid = bySid` when the hub has no session record; the daemon delivers by sid as usual;
  - or state the gap in the how-to and Open questions, and add a World case in AC-19 that fixes the chosen behaviour.
- **S11 AC-35's "bob's token on B with the sid of carol's session on B" cannot be built through the
  API.** A machine is one user's installation, and sessions are recorded with the syncing token's
  user and machine. Say the test seeds that session through the store (`upsertSession`), or replace
  the clause with "bob's token on B with the sid of bob's own session on machine B2" (another
  machine of the same user). That case is reachable and exercises the "on this machine" half of the rule.
- **S12 Name the test seams AC-36 and AC-39 need.** AC-36 needs two hubs on one store. Today that
  is built with `startHub` in `test/m46-replicas.test.ts`, not with `World`. AC-39 needs "the hub's
  reply is lost once". Say which hook the test side adds: for example, a `World` option or a
  `HubLink` fetch wrapper that drops one response after the hub committed. Then the developer
  knows not to build a product hook for it, and the blind test and the code agree on where the
  fault is injected.

## Scope, consistency, privacy

- No scope creep beyond round 1. The new text (Caller machine, Concurrency, Privacy, Offer ends
  with its step, Release, Questions on an offered step) repairs findings only. Names stay generic.
- Routes: seven new routes, all `member` with no scope. AC-33 compares them with the OpenAPI
  route-table test (method, path, rule, scope), so AC-33 can fail.
- Stores: no migration, and `SCHEMA_VERSION` stays 6. `MachineRow.accept` is covered on both
  engines by AC-06.
- Moving `claimStep` into `goalTx` changes the comment on `saveStepFrom` ("A claim does not wait
  for goalTx's lock"). The developer should update that comment. This is not a finding against the spec.

## Acceptance criteria

All criteria name a surface and can fail. AC-31 and AC-33 are partly review-only, as in round 1,
which is acceptable. B4 makes AC-20, AC-21, AC-24 and AC-27 contradict AC-35 as written.
Add the criteria named under B4.

## Counts

Blockers 1 (B4), suggestions 3 (S10–S12). Total 4: NEW 3, REPEAT 0, REGRESSION-OF-OWN-REPAIR 1.
