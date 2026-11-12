Verdict: APPROVED | Round: 2 | Blocking-open: 0

# Review of spec RL-3, round 2

I reviewed `docs/specs/RL-3.md` (revision 2, commit ec93bdc) cold. Before the spec I read round 1
(`r1-changes-requested.md`). I checked the spec against `docs/analysis/2026-11-12-pulse-relay-roster.md`
(REQ-1, REQ-2, §5.5, §5.6, §9 S3 and S4) and against the code on `feat/relay-design`:
- `src/hub/service.ts`: `goalTx`, `assignStep`, `setStick`, `claimInTx`, `markAccepted`, `acceptStep`,
  `declineStep`, `withdrawOffer`, `releaseStep`, `runReport`, `tick`, `describe` (`step.dropped`)
- `src/store/hub-store.ts` (`serialize`, `lock`) and `src/store/dialect.ts` (`LOCKS`)
- `src/hub/app.ts` (route scopes) and `src/protocol/hub-api.ts` (`HUB_API` rows with `query`)
- `src/core/review.ts` (`foldItems`: an accepted item stays accepted on repeat, as AC-22 needs)
- `src/daemon/runs.ts` (the `capacity:` release note), `src/daemon/daemon.ts` (`/local/goals` reads
  `/v1/live`), `web/src/mine.tsx` (uses fleet and offers, not live goals)
- whether the files that the Docs table and the AC surfaces name exist (`test/m46-ops.test.ts`,
  `test/helpers/relay-kit.ts`, `review-kit.ts`, `test/fixtures/claude/fake-claude/`, the docs files)

## Checks

This is a spec review, so there is no code to build. I did not run any of these: `pnpm lint`,
`pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm build` (together `pnpm check`), `pnpm schemas`,
or `pnpm test:web`. I used only `git`, `grep`, `sed`, `cat` and file reads. I did not run the `claude`
binary.

## Round 1 findings

All five blockers are fixed. I found no REPEAT.

| R1 | Status | Where |
|---|---|---|
| F1 | Fixed | **Tick**: Advance runs before Fire, a fire also retires pending slots, and `until` is computed from the due time. AC-28 covers ticks at the slot and 20 s late. |
| F2 | Fixed | Only a started goal is abandoned (Firing step 3). AC-10 is rewritten on an interactive step that has been claimed, and has a separate no-machine line (`missed`, never `abandoned`). The `>=` boundary makes "exactly at slot 4" hold. |
| F3 | Fixed | AC-11 uses window 1h, so the timeout is 20 min against an expiry of 30 min. The case where they are equal is specified (`step.offer_expired`, no withdraw, outcome `timeout`), and it matches `tick`'s `now - o.at < expiry` test. |
| F4 | Fixed | `deleteTopic` strips the topic from pulses. A fire that throws is recorded as `missed`/`error`, `nextAt` still advances, and the other pulses still run (AC-29). |
| F5 | Fixed | A future anchor is the first slot. AC-03 and AC-06 agree, and AC-06 has the `at` = now + 30d case. |
| F6 | Taken | Every pulse write re-reads the row inside `goalTx`. `goalTx` calls `serialize()`, which takes the global `events` lock, so the re-read decides from current state on Postgres too. AC-09 has the stale-read case. |
| F7 | Taken | `window?`/`maxGoalAge?` are stored as given. AC-15 has both lines. |
| F8 | Recorded | Open question "Ingest and `goals:write`". |
| F9 | Taken | But see N1. |
| F10 | Taken | `started_at` column, `(state, started_at)` index, `listSlots({pending})`. |
| F11 | Taken | `step.dropped {reason}` and its `describe` lines. AC-21 checks them. |
| F12 | Taken | A person's open offer makes the pulse wait. Candidates use the run step's `repo`. |
| F13 | Taken | `LOCKS.pulses`. This is harmless: the `goalTx` around it already serialises on `events`. |
| F14 | Taken | Lookup from the current directory is stated (CLI row, Open question). AC-07 names `presetText(parsePreset(old))`. |
| F15 | Taken | AC-13 now starts 1 min before S0 and names every slot. |
| F16 | Recorded | The TUI view is owned by S4. S4's design row already changes the TUI Mine view. |
| F17 | Taken | AC-04 wording. |

## Findings

None of these is a blocker. Every AC names a surface and can fail. The fixes add no scope beyond row S3,
and I found no team-, company- or person-specific names.

### N1 (suggestion, REGRESSION-OF-OWN-REPAIR): the 5-minute cron minimum depends on the second the pulse is saved, and can be bypassed

The F9 fix measures the minimum "between the first two slots after the save time". For an irregular
cron, that gap depends on when the pulse is saved:
- `0-4 * * * *` saved at hh:03:30 has its first two slots at hh:04 and (hh+1):00, a gap of 56 min. It is
  accepted, and then fires five slots an hour, one minute apart.
- The same body saved at hh:10 is rejected with `fires more often than every 5m`.

So the validation is not deterministic, and the 422 text does not hold for crons it accepts. With
`overlap: allow` this is a goal per minute. The defaults have the same problem:
`0 9 * * 1-5` saved on a Friday gets `maxGoalAgeMs` 6 d, but saved on a Monday it gets 2 d.

Fix: measure the cron period as the smallest gap between consecutive slots over a fixed horizon after
the save, for example 8 days (minute stepping, about 11 500 matches). Use that value for both the
minimum check and the defaults. Add an AC-06 case such as `0-4 * * * *`, which must give the 422 at any
clock.

### N2 (suggestion, NEW): it is not said whether `hub_down` rows emit `pulse.missed`

Two places emit `pulse.missed` explicitly: Advance step 2 and the error path. **Fire due pulses**
records `hub_down` rows but names no event for them. The Events table ("goal when the slot had one")
suggests that slots without a goal do emit it, but a blind test of AC-13 or AC-21 cannot tell. State it
either way. If they emit, cap it at one event per row (at most 10 per tick).

### N3 (suggestion, NEW): when the `accepted` outcome is written, and for which offer

The spec says "When the run step is claimed by an accepted offer, the last try's outcome is
`accepted`", but it does not say when this is written:
- at the accept (`acceptStep`/`markAccepted`, an RL-1/MM-3 route that would then write the slot);
- or at the next Advance. Advance step 3 runs only while the step is `ready`, so it never sees the claim.

The sentence also does not say that only an accept of the pulse's **own** offer counts. A person's
offer to machine E (F12) that is accepted would otherwise mark the last pulse try (A) as `accepted`, and
then the window end reports `expired` for a machine that never accepted.

Note that `releaseStep` deletes an accepted offer, so the outcome cannot be derived later from
`step.offer`. Say "written in `acceptStep` when the accepted offer is the one to the last tried machine",
or something equivalent. AC-11 and AC-12 read `tried[].outcome`.

### N4 (suggestion, NEW): the manual-fire error path inherits "saves `nextAt` as above"

The error paragraph ends with "and saves `nextAt` as above". "A manual fire whose transaction throws is
recorded as above" then reads as advancing `nextAt`, which contradicts "does not change `nextAt`" in the
fire route. Add "(a manual fire leaves `nextAt` unchanged)".

### N5 (suggestion, NEW): `HUB_API` query entries

`HUB_API` rows carry a `query` map, which feeds the OpenAPI document. The spec adds query `mine` on
`GET /v1/pulses` and `pulses` on `GET /v1/goals`, but it does not say that these go into `query`, and the
summary of `GET /v1/goals` ("All goals, or those with the given topics") becomes inaccurate. AC-27 checks
only rule and scope. Name both query entries and add them to AC-27.

### N6 (suggestion, NEW): `POST /v1/steps/:id/run` gains a side effect that is not listed under Compatibility

Advance step 1 says the `run.started` report "also sets `startedAt` at once". That makes `runReport`,
an RL-1 route, write `pulse_slot` (found through `goal.refs`). The text is clear enough to build, but
Scope and Compatibility do not list the change. Add one line.

### N7 (suggestion, NEW): design says "a maintained 5-field cron parser"

Design §5.5 asks for a maintained parser. The spec defines its own grammar and exact error texts in
`src/core/schedule.ts`, which implies a hand-written one. Either is defensible: no new dependency, and
the vectors pin DST behaviour. But the divergence should be an Open question that records the choice.
If a library is used, it must still produce the documented messages and vectors.

### N8 (suggestion, NEW): the S3 dogfood is not mentioned

Row S3 of §9 includes "**dogfood**: agent-only `audit-relay` on mesh-harness". The spec has no
criterion or Open question for it. A real run cannot be an AC (no real `claude` in tests), so record in
Open questions that the dogfood run is an operational step after release. Otherwise the row is narrowed
without saying so.

## Summary

0 blockers; 8 suggestions: 7 NEW (N2–N8) and 1 REGRESSION-OF-OWN-REPAIR (N1, from the F9 fix). There
are no REPEATs. All round-1 blockers (F1–F5) are fixed. The suggestions F6, F7 and F9–F15, F17 are
taken, and F8 and F16 are recorded. The verdict is APPROVED. N1 and N3 are the ones most worth fixing
before tests are written.
