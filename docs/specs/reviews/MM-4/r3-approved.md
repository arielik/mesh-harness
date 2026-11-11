Verdict: APPROVED | Round: 3 | Blocking-open: 0

# Review of spec MM-4, round 3

I reviewed `docs/specs/MM-4.md` cold, as of commit df07016. I read round 1
(`r1-changes-requested.md`) and round 2 (`r2-changes-requested.md`) first, then the diff
4a10b2b..df07016 (one line: AC-13), then the whole spec. I checked it against
`docs/analysis/2026-11-11-my-mesh-and-assign.md` (MM-4, Safety and privacy, Not in scope) and
against the code on `feat/my-mesh-assign`:
- `test/helpers/world.ts`: `hook(p, kind, pid, extra, headers)` with `headers.step`, the fake
  `launchStep` that records calls and starts nothing, and `restart`
- `src/daemon/daemon.ts`: the launch call site (`deps.launchStep`) and the `SessionStart` step-hint
  bind (`stepHint`, `boundSteps`)
- `src/core/offers.ts`: `pickSession` (idle, no `step`, not `launching`, repo match)
- `src/hub/app.ts`: `app.onError` (the `ZodError` → `invalid request` + `details` reply)
- `src/cli/hub-client.ts`: `hubFetch` error text with `details`

## Checks

This is a spec review, so there is no code to build. I did not run any of these: `pnpm lint`,
`pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm build` (together `pnpm check`),
`pnpm schemas`, `pnpm test:web`. I used only `git`, `grep`, `sed`, `cat` and file reads.

## Round 2 findings

| Finding | State |
|---|---|
| B1 AC-13 "no double count" cannot fail | Fixed. The case now uses `maxSessions: 3`, one live session, one launch, then the launched session appears holding the step (World `hook(p, "SessionStart", pid, {}, {step})`, which exists with that signature; the daemon binds the step from the hint on `SessionStart`). A correct count gives 2 live, so the next auto offer **calls** `launchStep`. A double count gives 3 and lists it instead. The `launchStep` call count is a World surface (the fake records every call), so the criterion can fail. The log line assertion was dropped, so no surface-less clause is left. |
| S9 old hub `say` text | Not changed. See S9 below (REPEAT, suggestion). |
| S10 `steps` for a step with an open offer | Not changed. See S10 below (REPEAT, suggestion). |
| S11 count before the bind | Not changed. See S11 below (REPEAT, suggestion). |
| S12 `MessageResult.to` with both `toSid` and `to` | Not changed. See S12 below (REPEAT, suggestion). |

## Blockers

None.

## Suggestions (not blocking)

- **S9 (REPEAT): the Compatibility line for `mesh say` against a v0.1.11 hub is still inexact.** An
  old hub's `MessageRequest` refine fails as a `ZodError`. `app.onError` answers
  `{error: "invalid request", details: [": toSid or toStep is required"]}`, and `hubFetch` prints
  `invalid request\n  - : toSid or toStep is required`. No AC asserts this, so it does not block.
  Write "the hub's `invalid request` text with the refine detail" in the Compatibility line.
- **S10 (REPEAT): `steps` for a step target whose offer is open.** The type row says `steps` holds
  "the offerable step ids" and also "a step target: `[target]`". Suggest answers such a step with 200
  (AC-08), but MM-3 `assignStep` refuses it with 409 (`… is already offered to …; withdraw it
  first`), so the CLI's `Assign with: …` hint fails. Pick one reading (always `[target]`, or `[]`
  with a `mesh withdraw <S>` hint) and add the case to AC-08 or AC-09.
- **S11 (REPEAT): a launched session counts twice until its bind completes.** Between `SessionStart`
  and the `/claim` reply the session is live but does not yet hold the step, so its pending launch is
  counted too. This errs on the safe side. AC-13 avoids it by waiting for the bind. Record it under
  Open questions, or count a session as holding the step once its `SessionStart` names it.
- **S12 (REPEAT): `MessageResult.to` when both `toSid` and `to` are sent.** The type row says `to`
  is present "only when the request used `to`". The route row says `toSid` wins. Write "present only
  when `to` decided the target (absent whenever `toSid` is given)".
- **S13 (NEW): AC-13 does not say that the "one live session" is not an idle candidate.** The first
  AC-13 case states "(none idle in the repo)". The later cases (two offers in one pull, pending
  launch expiry, no double count, `{ok: false}`) say only "one live session". If a test writer
  makes that session idle, step-less and in the step's repo, `pickSession` hands the offer to it and
  `launchStep` is never called. The test would then fail for a reason the spec does not name. Say
  once for all of AC-13 that the live sessions are not idle step-less sessions in the offered
  step's repo (for example, a session in another repo or one mid-turn).

## Scope

No scope creep. Round 3 changed only AC-13. The Out list is unchanged: no MCP tool, no migration, no
store interface change, no new events. The points from rounds 1 and 2 still hold: the route rule is
`member` with no scope (AC-17 compares it with the route table), idempotency comes from the generic
layer on `POST /v1/messages`, and privacy uses `sessionVisible` on the one session source
(`listSessions({live: true})` plus `state !== "ended"`) on both SQLite and Postgres through the
shared store.

## Summary

The round 2 blocker is fixed: the "no double count" case of AC-13 now fails on a double count,
because it asserts a `launchStep` call that World records. No blocker is open. Four round 2
suggestions (S9 to S12) are still open, and one new suggestion (S13) asks AC-13 to say that its live
sessions are not idle candidates. None of them stops implementation.
