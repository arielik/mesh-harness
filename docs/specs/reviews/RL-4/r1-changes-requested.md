Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 1

# Review of spec RL-4, round 1

I reviewed `docs/specs/RL-4.md` (commit 5f62f56) cold. I checked it against
`docs/analysis/2026-11-12-pulse-relay-roster.md` (REQ-8, R-3, §5.3, §5.6, §5.7, §5.9, §6, §9 S4, OQ-2,
OQ-3) and `docs/analysis/2026-11-12-claude-cli-spike.md`, which says nothing about skills in
interactive sessions. I also checked it against `docs/specs/RL-2.md` (problems, disposition checks,
applying, the review route) and against the code on `feat/relay-design`:
- `src/protocol/{review,goal,hub,hub-api,tools,skill,config}.ts`
- `src/core/{policy,review,claims,redact,roles,trail}.ts`
- `src/store/hub-store.ts` (`review_item`, `item_history`, `listDispositions`, `SCHEMA_VERSION`)
- `src/hub/service.ts` (`emitReady`, `claimInTx`, `assignStep`, `assignGoal`, `offerableSteps`,
  `acceptStep`, `noteStep`, `stepInputs`, the review route), `src/hub/app.ts` (route table, idempotency
  middleware)
- `src/daemon/tools.ts` (`brief`, `mesh_review` reply, offline handling)
- `src/cli/mesh-commands.ts` (`mesh run`), `src/cli/hub-commands.ts` (`mesh next`), `src/cli/ledger.ts`
  (`exportLedger`), `src/cli/tui/render.ts` (`renderOffers`, `OFFERS_FOOTER`)
- `src/claude/skill.ts`, `web/src/mine.tsx`, `test/helpers/`, `test/schemas.test.ts`, `docs/events.md`

`docs/specs/reviews/RL-4/` did not exist before this round, so every finding is NEW. None is a REPEAT
or a REGRESSION-OF-OWN-REPAIR.

## Checks

This is a spec review, so there is no code to build. I did not run `pnpm lint`, `pnpm typecheck`,
`pnpm boundaries`, `pnpm test`, `pnpm build` (together `pnpm check`), `pnpm schemas` or
`pnpm test:web`. I used only `git`, `grep`, `sed`, `cat` and file reads. I did not run the `claude`
binary.

## What already matches the code

- **No migration.** `Step`, `Round` and item history are JSON values in `step`, `review_item` and
  `item_history`; `Step.read`, `Round.read`, `via`, `answer` and the `revert` entry fit without a schema
  change. `DispositionRow` is derived from history entries in `listDispositions`, so widening `via` there
  and in `DispositionEntry` is enough and RL-2 rows still parse.
- **Never offered.** The offer paths are exactly `assignStep`, `assignGoal` (through
  `offerableSteps`) and `emitReady` (stick); the ready consumers are `GET /v1/steps?ready=1` (used by
  `mesh next`, `mesh_next`/`mesh_context` and the daemon's autopilot at `daemon.ts:994`). The spec names
  all of them.
- **Claim.** `mesh run --step` claims through `POST /v1/steps/:id/claim`, so the 403 reaches the CLI;
  the prompt is `claudeArgv`'s first argument after `claude`, as AC-15 asserts.
- **Defaults.** `policyOf` feeds the stored `Step.policy` (`materialize`), and the hub's `runOf`/
  `isRaising` read `Step.policy`, so filling `consumes` in `policyOf` keeps a debrief from being seen as
  a raising step by `file`. `validatePolicies` uses `PlanStep`s, so the spec is right to say it must
  apply the defaults itself.
- **Idempotency.** The app middleware stores any 2xx JSON reply under `(Idempotency-Key, user)`, so
  AC-22 holds for both new POST routes without new code.
- **Privacy of exports.** `exportLedger` exports only front matter; notes live in the trail body, so
  "notes may carry reasons and titles" does not contradict RL-2 AC-24 or this spec's AC-14.
- **Redaction.** `redactSecrets` replaces a `ghp_` token with exactly `[REDACTED]` (AC-08).
- **Authorization.** `allowed("member", …, scope)` lets a `goals:read` token reach only the routes
  that declare that scope, which matches the table.
- **Generic.** No team-, company- or person-specific name; `alice`/`bob`/`carol` are test users.

## Findings

### F1 (blocker, NEW) The debrief's own record can undo a revert and refuses a change of mind

Decision wrong. Two paths apply debrief decisions: `mesh_dispose` during the session, and the
debrief's own record at the end (`dispositions` = "every decision recorded", per the skill body and
the `mesh_dispose` "No item left" reply). The `already` rule only covers a record entry whose
disposition equals the latest `mesh_dispose` **and** whose item state still equals it. Everything else
goes through RL-2 check 6. Two failures follow:

1. **A revert made during the session is silently undone.** While the debrief is `claimed`, the TUI
   `o` panel and the Mine page list the decision as revertable. The person reverts A (`accepted` →
   `open`). The skill does not know this and submits A `accepted`. The state is `open`, not `accepted`,
   so A is not `already`. Check 6 passes (`open` is consumed), so A is applied again with no `answer`.
   The revert, which design OQ-2 makes the only confirmation of a debrief decision, is lost.
2. **A change of mind fails the record.** `mesh_dispose` accepts a change within the round (AC-09:
   A `accepted` → `dismissed`). The skill then lists "every decision recorded". With both decisions, the
   record fails with `listed twice`. With only the first decision, A is `dismissed`, not consumed, and
   the record fails with 422 (this is exactly AC-10's first case). Either way the debrief cannot reach
   `mesh_done` without the agent guessing a rule the spec does not give.

Fix (pick one and state it in Interface contracts, the skill body, the `mesh_dispose` reply, AC-10 and
Open questions):
- (a) In a debrief record, an fp that has a debrief disposition by this step in the current round is
  never applied from the record. It is listed in `already` whatever the record says, or it is refused
  when the record differs from the latest one, with an exact text. A revert then sticks. Or:
- (b) The skill and the reply say "the latest decision per item". The `already` rule matches on "the
  latest debrief disposition of this step in this round", even when a later revert changed the state,
  and never re-applies it. A revert entry after it counts as "the person undid it".

Then add an AC: revert A in the UI while the debrief is held, submit the record with A, and A stays
`open` (no second history entry). Also cover a change of mind followed by the record.

### F2 (suggestion, NEW) Near-match leaves out the rename case the design names

Design §5.3: "a renamed file shows as resolved + new, with a near-match on rule and symbol". The spec
defines a near-match only as same `rule` and same `path`. Add "or same `rule` and same defined `symbol`
and another `path`" to `DebriefItem.nearMatches` and AC-06. If you keep it out, record it in Open
questions as a deviation.

### F3 (suggestion, NEW) Transactions for the new writes are not stated

RL-2 puts every review write in `goalTx` with `store.serialize()` first, so two goals of one lineage
never fold or dispose over each other. Postgres with several replicas depends on that. The spec does not
say it for `POST …/dispositions`, `POST …/dispositions/revert` or `POST …/read`. The revert needs it
most: "revertable" is a check-then-write against `item_history`. A fold from another goal of the same
lineage that commits in between makes the revert undo a later fold, which is what the Open questions
say can never happen. State that all three run in `goalTx` (serialized), as `submitReview` does.

### F4 (suggestion, NEW) `acceptStep` is a claim path the assignee check does not name

`acceptStep` claims through `claimInTx`. A step that is offered and then replanned to `mode: debrief`
keeps its open offer (`endOffersLeavingReady` only ends offers of steps that leave `ready`). Then
anyone on the target machine can accept it. Put the assignee check in `claimInTx`, so it covers claim,
accept and take. Alternatively, say that a replan to `debrief` withdraws an open offer. Add the case to
AC-04.

### F5 (suggestion, NEW) `GET /v1/debriefs` has no store path, and the TUI polls it every 5 s

`decided` needs every disposition whose `decider.user` is the caller, across all lineages.
`listDispositions` has no decider or time filter, so it reads and parses all of `item_history`, which
grows with every fold. `debriefs` likewise needs every step of every goal. The TUI calls this every 5 s
per terminal. Name the store access, for example a `listDispositions` filter on `at ≥` and the step ids
of debrief steps. If you add a store method, it needs a `hub-store.contract.test.ts` case on SQLite and
Postgres. Say that in Interface contracts and in AC-24 or a new AC.

### F6 (suggestion, NEW) The person's verbatim `answer` becomes team-visible; record it

`answer` is stored on the history entry and on `DispositionRow`. It is therefore served by
`GET /v1/items` (`goals:read`), by `DebriefView.decided` (any member, `goals:read`) and by
`GET /v1/steps/:id/reviews`. That follows design OQ-3's default (team-visible), but this is the first
field holding a person's own words in a review. Add an Open questions entry. Also say whether the hub
redacts `answer` and `reason` when the route is called without the daemon (the web never calls it; a
token can).

### F7 (suggestion, NEW) 409 text differs from RL-2 for the same condition

The `dispositions` route says `<id> round <n> already has its review record`. RL-2's review route says
`<id> round <n> already has a review record`. Use RL-2's text, or give a reason for the difference.

### F8 (suggestion, NEW) Body schema of `POST /v1/steps/:id/read` is unnamed

`HUB_API` entries carry a `body` zod schema, and the OpenAPI test compares against them. Name it, for
example `ReadRequest = z.object({}).strict()` in `src/protocol/hub.ts`, and say whether an unknown key
gives 400.

### F9 (suggestion, NEW) Web "Mark as read" on a step in a state that refuses it

The step panel shows `Mark as read` "while `read` is absent or for another round". On a `blocked` or
`done` debrief that button posts and gets 409. Show the button only in `ready`, `claimed` and `paused`
(else no button and no `Read by`), and say so in AC-20.

### F10 (suggestion, NEW) TUI behaviour when `debriefs()` fails is unspecified

`GET /local/debriefs` returns 409 without credentials and fails while the hub is offline. The spec does
not say what the `o` panel shows then. The likely intent is that offers still render, the DEBRIEFS and
DECIDED sections are absent, and the badge counts offers only. A blind test of AC-18 cannot know.

### F11 (suggestion, NEW) An admin can submit a debrief's own record but cannot dispose

RL-2's review route allows the holder **or an admin**. Applied to a debrief, an admin's record decides
items with `decider {person, admin}` and `via: debrief-session`, while `POST …/dispositions` is
holder-only and claims are assignee-only "also for admins". Either restrict a debrief record to the
holder, or record in Open questions why an admin may close a debrief.

### F12 (suggestion, NEW) AC-21 "as before" has no reference

"Runs through claim/assign/done with the same states, events and offers as before" names no baseline.
Either point at the existing tests that must stay unchanged, or list the concrete event sequence. The
other parts of AC-21 (via, `already: []`, `TOOLS`, hashes, version) can fail as written.

## Scope

No scope creep. The routes beyond design §6 (`GET /v1/steps/:id/debrief`, `GET /v1/debriefs`, the
dispositions and revert routes, the daemon local routes) are the minimum to deliver §5.7's
"Assigned to you", pre-read rendering and one-key revert. `mesh skill --debrief` and the doctor lines
follow the existing `mesh` skill. The Out list and the Open questions record what the row leaves out
(`audit-relay` debrief stage, missed slots in the TUI), each with a reason.

## Summary

12 findings, all NEW: 1 blocker (F1), 11 suggestions. F3 and F4 are the most important suggestions
for correctness on Postgres and for the assignee-only rule.
