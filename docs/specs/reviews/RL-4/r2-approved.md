Verdict: APPROVED | Round: 2 | Blocking-open: 0

# Review of spec RL-4, round 2

I reviewed `docs/specs/RL-4.md` at commit d5ebdb9 (revision 2) cold. First I read round 1
(`r1-changes-requested.md`). I checked the spec against `docs/analysis/2026-11-12-pulse-relay-roster.md`
(REQ-8, §5.3, §5.6, §5.7, §6, §9 S4, OQ-2, OQ-3), `docs/specs/RL-2.md` (problems, disposition checks
1..6, "Applying a disposition", the review route) and the code on `feat/relay-design`:
- `src/protocol/review.ts` (`HistoryBase`, `DispositionEntry`, `DispositionRow`, `ItemRow`), `src/protocol/goal.ts`
  (`Goal`, `StepPolicy`, `Step`), `src/protocol/hub.ts` (`ReviewResult`), `src/protocol/hub-api.ts` (`HUB_API` shape)
- `src/core/roles.ts` (`allowed`)
- `src/store/hub-store.ts` (`step` and `item_history` tables on SQLite and Postgres, `listSteps`,
  `listDispositions`)
- `src/hub/service.ts` (`claimStep`, `claimInTx`, `acceptStep`, `takeStep`, `noteStep`, how the review
  route applies dispositions, the `item.disposed`/`review.recorded` events)
- `src/cli/mesh-commands.ts` (`mesh run` flags: `--prompt`, `--session`, `--socket-name`, `--no-tui`),
  `src/claude/skill.ts`, `docs/events.md`

## Checks

This is a spec review, so there is no code to build. I did not run `pnpm lint`, `pnpm typecheck`,
`pnpm boundaries`, `pnpm test`, `pnpm build` (together `pnpm check`), `pnpm schemas` or
`pnpm test:web`. I used only `git`, `grep`, `sed`, `cat` and file reads. I did not run the `claude`
binary.

## Round 1 findings

| R1 | Status | Where |
|---|---|---|
| F1 (blocker) record undoes a revert / refuses a change of mind | **Fixed.** Option (a) taken. "Session decision" is defined as the latest debrief disposition of this step in the current round, whatever happened since. A matching record entry goes to `already`, a differing one gets an exact problem text. The skill body and the `mesh_dispose` reply say "latest decision per item". AC-10 (c) covers a revert during the session and (d) a change of mind, including `listed twice`. Both can fail. | Interface contracts, debrief record, AC-10, Open questions |
| F2 near-match on rename | Fixed (`DebriefItem.nearMatches`, AC-06 A3 case, Open questions). | |
| F3 transactions | Fixed (**Transactions** paragraph). | |
| F4 `acceptStep` claim path | Fixed (check in `claimInTx` and `takeStep`; AC-04 accept case). See r2 F1 for one gap in the wording. | |
| F5 store path for `GET /v1/debriefs` | Fixed (store filters, `updatedAt` on dispose, AC-25 contract + World). See r2 F4. | |
| F6 `answer` team-visible | Fixed (Open questions; the hub does not redact; the daemon does). | |
| F7 409 text | Fixed (RL-2's text). | |
| F8 `ReadRequest` | Fixed. | |
| F9 web read button states | Fixed (step panel, AC-20). | |
| F10 TUI on `debriefs()` failure | Fixed (TUI paragraph, AC-18). | |
| F11 admin record | Fixed (holder only, 403, AC-10 (f), Open questions). | |
| F12 AC-21 baseline | Fixed (named test files). See r2 F5. | |

None is a REPEAT.

## What matches the code (new in revision 2)

- `item_history.step` and `step.updated_at` are real columns on both SQLite and Postgres
  (`hub-store.ts` migrations), so `listDispositions({steps})` and `listSteps({updatedSince})` need no
  migration.
- `claimStep` (with or without an open offer), `acceptStep` and the offerer path all go through
  `claimInTx`. `takeStep` calls `takeOver` directly. The spec puts its check in exactly these places.
- The review route applies dispositions in one loop (`service.ts` ~1046) and emits one
  `item.disposed` per applied entry. Adding `via`, `answer` and the `already` branch fits there.
- `noteStep` emits `step.noted` with no payload, so the note texts (titles, reasons) stay out of
  events, which keeps AC-14 consistent.
- The `--session`, `--socket-name`, `--no-tui` and `--prompt` flags of `mesh run` exist, so
  `mesh debrief` can delegate as AC-15 describes.
- `allowed("member", …, "goals:read")` lets a read token reach `GET /v1/steps/:id/debrief` but not
  `GET /v1/debriefs`. This matches the table and the Open questions entry on `answer`.

## Findings

### F1 (suggestion, REGRESSION-OF-OWN-REPAIR) Claim with an open offer: 403 "before the claim rules" vs `claimStep`'s offer routing

The repair of r1 F4 says that every holder path refuses a non-assignee with 403, "checked before the
claim rules", and that the check lives in `claimInTx`. But `claimStep` routes an open offer before it
reaches `claimInTx`. A caller who is neither on the target machine nor the offerer gets
`409 <id> is offered to <machine>` and never reaches the check. On a step that a replan turned into a
debrief, with its offer still open, a blind test of "bob claims → 403" would therefore get 409. Pick
one and state it:
- the assignee check runs in `claimStep` before the offer branch (then it is 403 on every path);
- or the 409 offer text stands for that case.

AC-04 covers only the accept path, so either reading passes it today.

### F2 (suggestion, NEW) `mesh_dispose` check 6 exception uses "latest disposition entry", not the latest history entry

`POST …/dispositions` lets check 6 pass "when the item's latest disposition entry is this step's in
the current round". A fold by another goal of the same lineage can come after that disposition and
before the next `mesh_dispose` while the debrief is held. For example, a pulse slot runs and marks A
`resolved`. The latest *disposition* is still the debrief's, so the change of mind overwrites the
fold's state. The revert rule guards against exactly this by using the latest history entry of any
kind ("Revertable"). Use the same rule here: check 6 passes when the latest `item_history` entry of the
fp is this step's debrief disposition, or this step's revert, in the current round. Optionally add an
AC case (fold in between → 422 `item <fp> is resolved; …`).

### F3 (suggestion, NEW) Reverting a deferral that replaced a deferral keeps the wrong `until`

The revert sets `until` "removed unless the restored state is `deferred`", which keeps the row's
current `until`. Take A `deferred` (until X), then a change of mind to A `deferred` (until Y). Reverting
the second decision restores `deferred` but leaves `until` = Y, not X. RL-2's apply code never clears
`until` (`service.ts` ~1055). The earlier value is in the previous history entry (its `until`). Say
that a restored `deferred` takes `until` from the latest earlier disposition entry of the fp whose
`to` is `deferred`, or record the simplification in Open questions.

### F4 (suggestion, REGRESSION-OF-OWN-REPAIR) Compatibility says both filters use existing columns; `since` has none

Compatibility says "the two new store filters use existing columns (`step.updated_at`,
`item_history.step`)". `listDispositions({since})` filters on `at`, but `item_history` has no `at`
column (only `seq, lineage, fp, step, value`). `at` lives in the JSON value. Say that `since` is
applied after parsing, within the rows the `steps` filter selects. Then no implementer adds a column,
which would need a migration that `SCHEMA_VERSION unchanged` forbids. Also note in the Open questions
entry on store access that `step` has no index on `updated_at`. `listSteps({updatedSince})` then reads
the step table on every 5-second TUI poll. That is acceptable at today's size, but say it.

### F5 (suggestion, REGRESSION-OF-OWN-REPAIR) AC-21 and Compatibility list different allowed test changes

AC-21 (the repair of r1 F12) allows existing tests to change for `ReviewResult.already`. The
Compatibility section lists only `TOOLS`, `OFFERS_FOOTER`, `HUB_API` and the setup/doctor output. Add
`ReviewResult.already` (tests that compare a whole `ReviewResult` or a `review.recorded` payload) to
Compatibility, so the test-writer and the reviewer of the diff use the same list.

## Scope

No scope creep. Revision 2 adds two store filters (`updatedSince`, `steps`/`since`), the holder-only
rule for a debrief record and the `already`/problem rule. Each one answers a round 1 finding and stays
inside the row. The Out list is unchanged and still has a reason for each item.

## Summary

All 12 round 1 findings are fixed, and the round 1 blocker F1 is closed. This round has 5 findings,
all suggestions: 2 NEW (F2, F3), 3 REGRESSION-OF-OWN-REPAIR (F1, F4, F5), 0 REPEAT. Every AC names a
surface and can fail. No hard rule is broken. Verdict: APPROVED. I recommend folding F1..F5 into the
spec before implementation, but none of them blocks it.
