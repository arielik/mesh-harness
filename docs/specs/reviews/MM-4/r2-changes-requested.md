Verdict: CHANGES REQUESTED | Round: 2 | Blocking-open: 1

# Review of spec MM-4, round 2

I reviewed `docs/specs/MM-4.md` cold, as of commit 29adfc6. I read round 1
(`r1-changes-requested.md`) first, then the diff 3c725c8..29adfc6, then the whole spec. I checked it
against `docs/analysis/2026-11-11-my-mesh-and-assign.md` (MM-4, Safety and privacy, Not in scope) and
against the code on `feat/my-mesh-assign`:
- `src/hub/{app,service}.ts`: `createApp` catch-all, `findMachine`, `findSessionOn`,
  `resolveTarget`, `autoFor`, `assignStep`, `assignGoal`, `say`
- `src/cli/hub-client.ts` (`hubFetch`)
- `src/store/hub-store.ts` (`listSessions`, one implementation for SQLite and Postgres)
- `src/core/{offers,repo-id,visibility}.ts`
- `src/protocol/{hub,goal}.ts`
- `src/daemon/daemon.ts` (offer handling, `launchStep`, `applyEvent` step binding)
- `test/helpers/world.ts` (`restart`, `makeDaemon`, `log`, `clock`, `hook`)

## Checks

This is a spec review, so there is no code to build. I did not run any of these: `pnpm lint`,
`pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm build` (together `pnpm check`),
`pnpm schemas`, `pnpm test:web`. I used only `git`, `grep`, `sed`, `cat` and file reads.

## Round 1 findings

| Finding | State |
|---|---|
| B1 AC-02 rank position | Fixed. Each pair now makes the winner worse on every later key it can be worse on. I checked that every example pair can be built: `listSessions({live: true})` filters on state only, not on time, so an offline machine can still hold idle sessions. A `repo: false` machine can have no idle candidate (a session in the repo would make `repo` true), and "it can be worse on" covers that. Equal `lastSeen` for the id pair is reachable with the fixed World clock. |
| B2 AC-13 "may launch" | Fixed. Now "calls `launchStep` (exactly one more call)", and the case before 120 s is stated. |
| B3 Compatibility vs catch-all | Fixed. `app.get("*")` answers 200. `hubFetch` turns a non-JSON body into `{}` and throws only at status ≥ 400. So the `suggestions`-array check in the CLI row is reachable, and AC-09 tests it with a stub server. |
| S1 AC-15 signed-in user | Fixed. |
| S2 `session` is a hint | Fixed (type row and Open questions). |
| S3 `MessageResult.to` | Fixed ("for display only"). |
| S4 CLI arg combinations | Fixed (usage row and AC-10). |
| S5 `--stick` hint | Fixed via `SuggestView.steps`. |
| S6 `team=1` exposure in docs | Fixed (concepts row). |
| S7 AC-13 gaps | Taken in, but the double-count case cannot fail. See B1 below. |
| S8 session source | Fixed (`listSessions({live: true})` plus `state !== "ended"`, the same source `findSessionOn` uses). |

## Blockers

### B1 (REGRESSION-OF-OWN-REPAIR): AC-13 "no double count" cannot fail on launches or acks
The case added for round 1's S7 runs like this:
1. `maxSessions: 2` and one live session.
2. An offer launches.
3. The launched session appears holding the step.
4. A new auto offer must not launch, and is acked `listed`.

With a cap of 2, a correct count (2 live) and a double count (3) both refuse step 4. So the
`launchStep` count and the ack cannot tell them apart (rule 3). The defect comes from my own
round 1 suggestion, which used the same numbers.

Only the clause "the log line names `2 live sessions`" could fail. But World has no surface where a
test can see it (rule 4). `makeDaemon` passes
`log: (l) => process.env.WORLD_LOG && console.log(...)`, nothing records the line, and the
test-side note under "Client methods" only allows extending `World.restart` for `maxSessions`.

**Fix.**
- Use `maxSessions: 3` with one live session. An offer launches. The launched session appears
  holding that step (World `hook(p, "SessionStart", pid, {}, {step})`, then wait for the bind). A new
  auto offer then **calls** `launchStep`: 2 live, so a place is free. A double count (3) would list
  it instead.
- If the log line stays in the AC, name its surface. For example, the test side may record
  `log` lines on the World person (`p.logs`). Otherwise drop the log assertion.

## Suggestions (not blocking)

- **S9 (NEW): when an older hub refuses `mesh say <m>/<s>`, the CLI does not print exactly
  `toSid or toStep is required`.** The old hub throws a `ZodError`, and `app.onError` answers it as
  `{error: "invalid request", details: [": toSid or toStep is required"]}`. `hubFetch` then
  prints `invalid request\n  - : toSid or toStep is required`. No AC asserts this. Still, correct
  the Compatibility line to say "the hub's `invalid request` text with the refine detail", or add a
  CLI mapping like the suggest one if a clearer message is wanted.
- **S10 (NEW): `steps` for a step target that has an open offer.** The type row says
  `steps` = "the offerable step ids". It also says "a step target: `[target]`". These conflict
  for a step whose offer is open: suggest still answers it with 200 (AC-08), but that step is not
  offerable. MM-3 `assignStep` refuses it with 409 `<id> is already offered to …; withdraw it
  first`, so the CLI's `Assign with: …` hint would fail. Settle this one way:
  - say that a step target always gives `[target]`, and accept the hint;
  - or say it gives `[]` when the offer is open, and print a `mesh withdraw <S>` hint instead.

  Then add the case to AC-08 or AC-09.
- **S11 (NEW): a launched session can be counted twice until it is bound.** In `applyEvent`, the
  daemon sets `step` on a new session only after the hub's `/claim` reply (an async `update`).
  Between `SessionStart` and that reply, the session is live but does not yet "hold that step", so
  its pending launch is counted too. That errs on the safe side (it refuses, never over-launches).
  Still, say that a session also counts as holding the step once its `SessionStart` names it
  (the `X-Mesh-Step` hint or the placeholder's step), or record this as accepted under Open
  questions.
- **S12 (NEW): `MessageResult.to` when both `toSid` and `to` are sent.** The route row says
  `toSid` wins and `to` is ignored. The type row says `to` is "present only when the request used
  `to`". Write "present only when `to` decided the target (absent whenever `toSid` is given)" so a
  blind test knows what to expect.

## Scope

No scope creep found. The changes in round 2 (`SuggestView.steps`, the old-hub check in the CLI, and
the extra AC cases) each answer a round 1 finding and are recorded under Open questions. Out is
unchanged: no MCP tool, no migration, no store interface change, no new events. Authorization
(`member`, no scope), idempotency (`HubClient.post` sends a key, and the messages route is already
covered by the generic idempotency layer) and privacy (`sessionVisible` on the one session source)
still match the code.

## Summary

All three round 1 blockers are fixed correctly, and so are seven of the eight suggestions. One
blocker remains: the new "no double count" case of AC-13 uses `maxSessions: 2`. With that cap, a
double count produces the same launches and acks as a correct count, and the only other check (a
log line) has no test surface. Change the cap to 3 and assert a launch.
