Verdict: APPROVED | Round: 2 | Blocking-open: 0

# Diff review RL-15, round 2 (commit 1110491)

Reviewed `git show 1110491` (the answer to `diff-r1-changes-requested.md`) against docs/specs/RL-15.md
and the code at the branch head. On a scratch copy: test/sla-hub.test.ts, test/overlap-hub.test.ts,
test/schemas.test.ts and src/core/sla.test.ts pass (4 files, 98 tests). The generated schemas are
current: `Carry.fps` now has `minItems: 1` in schemas/hub-api.openapi.json. The refine has no JSON
Schema form, which is expected.

## Round-1 findings

1. **RESOLVED (was BLOCKING): AC-07 reopened debrief.** The commit adds
   `test_AC07_reopened_debrief_new_cycle` (test/sla-hub.test.ts:62). The debrief breaches at `t` and
   emits one assignee event. The person then records the debrief, and a later `check` step closes
   `fail` with `reopen: [D]`, so D is `ready` again with a new `since` t2. At t2 + 1h there is still
   only one event. At t2 + 2h the test asserts a second assignee event with `since: t2` and `dueAt: t2 + 2h`,
   and `overdue` = `{since: t2, assigneeAt: t2 + 2h}`. The reset path is now pinned at the hub, not
   only by the pure unit test. M10 is now caught (see the mutation table). The AC-07 wording is back
   to the approved text. The Surfaces column reads "World (clock); `slaState` also unit-tested",
   which only adds to the approved surface.

2. **RESOLVED: approved-spec edits.** The Status line now records revision 4, which is the record
   round 1 asked for. Each change is judged below under "Revision 4".

3. **RESOLVED: a goal-creating fire replaces the queued slot.** `test_AC03_fire_replaces_queued`
   (test/overlap-hub.test.ts:113) fires G, starts its run, and makes a manual fire that is `queued`
   behind G. It then finishes G's headless steps. A manual non-trial fire made before the next tick
   creates a goal, and the test asserts that the queued slot becomes `skipped` with the exact
   `pulse.skipped {pulse, slot, reason: "overlap", running: G, replacedBy: <fired slot>}` payload.
   This matches spec "Queue", last sentence. M15 is now caught.

4. **Non-blocking, agreed: the "never auto-accepted again by D" guard is not discriminated.** No
   test was added. AC-09 as written ("the next ticks do not accept E again") is met with or without the
   guard, because the agent-`confirmed` check already refuses E after the revert. The guard only
   matters if an agent confirms E again later. It stays optional. M8 still survives.

5. **RESOLVED (spec aligned) / test non-blocking: carry cap order.** Revision 4 changes the spec to
   the code's order: most severe, then first seen, then `fp` (`byItemOrder`, src/hub/service.ts:312).
   That is the hub's single item order (RL-2 AC-16 and §497, and the order debrief items already use),
   so choosing it over a separate severity-then-fp order is consistent and simpler. The spec calls it
   the "RL-4 item order", but the order is defined in RL-2 (the code comment says RL-2). This is a
   wording nit and does not need a round. The 1000 cap is still untested (M31). That is acceptable:
   a test would need more than 1000 carried items, and the cap is a one-line `slice`.

6. **RESOLVED: `Carry.fps` schema.** src/protocol/pulse.ts:134 now has `.min(1).max(1000)` plus a
   strict-ascending refine, which enforces both uniqueness and sorting. The hub writes only non-empty
   entries (`if (fps.length)`, service.ts:5573), sorted by `.sort()`, and fps within a lineage are
   unique. So no write the hub makes is rejected.

7. **RESOLVED: enum-widening note.** docs/guide/concepts.md:503 lists the new values: `overlap`
   `queue`/`supersede`, slot state `queued`, `goal.dropped` reason `superseded`, `via` `auto-accept`
   and attention kind `debrief_overdue`. That matches the Compatibility list.

8. **Non-blocking, agreed: AC-12 via `pulse update`.** `pulse add` and `pulse update` share the
   `--overlap` parser (src/cli/pulse-commands.ts:127). Low risk.

9. **Non-blocking, agreed: per-tick transaction and attention read cost.** Acceptable at the current
   scale. Worth filtering with `slaState` before opening the `goalTx` if the hub grows.

## Revision 4

- **AC-04: trial goal after slot 1, `superseded` = `[T, G1]`. ACCEPTED.** The contract defines a
  waiting goal as including trial goals (Common names), and slot 1 is a non-trial fire under
  `supersede`. A trial goal that was already waiting when slot 1 fired would therefore be superseded
  by slot 1. The approved AC contradicted the contract, and the revision fixes the AC rather than the
  contract. For the order: "in slot order" (Supersede, and the `PulseSlot.superseded` type) is the
  store's `listSlots` order, which is newest first (hub-store contract `test_AC05_listSlots`,
  `test_RL12_listSlots_before_since`). T's manual slot (`manual:<ulid>` at T0 + 1h) is newer than
  slot 1, so `[T, G1]` is right. `test_AC04_supersede` also asserts that the `pulse.superseded` events
  come in that order. Nit: the contract could say "newest first" explicitly. It is not a blocker,
  because the AC now states the order and the test pins it.
- **AC-09: the later change of F is a fold that resolves it. ACCEPTED.** "A later change of F by
  another step" covers a later goal's audit record folding F to `resolved`: the latest history entry
  is then no longer the auto-accept, so it is not revertable (409) under the RL-4 rule the Revert
  contract refers to. `test_AC09_revert` asserts `resolved` and then 409. The 409 path and the failure
  condition are unchanged.
- **Carry cap order. ACCEPTED** (see finding 5). The code and the spec now agree. Nothing that reads
  the carry depends on the order of the cut, because the kept fps are re-sorted by `fp`.

## Fail-first mutations (scratch copy, never the worktree)

The worktree was copied with `cp -a` to a scratchpad directory. Each mutation was applied alone,
then `node_modules/.bin/vitest run test/sla-hub.test.ts test/overlap-hub.test.ts` was run, and
service.ts was restored (diff-checked) after each.

| # | Mutation | Result | Failing tests |
|---|---|---|---|
| M10 | `debriefSlaTick`: `prev?.since === sla.since ? { ...prev } : …` → `prev ? { ...prev } : …` | CAUGHT | test_AC07_reopened_debrief_new_cycle (1 failed, 21 passed) |
| M15 | `fireSlot`: removed `if (p.overlap === "queue" && !o.trial) await this.replaceQueued(...)` | CAUGHT | test_AC03_fire_replaces_queued (1 failed, 21 passed) |

Both mutations that survived round 1 and that this commit targeted are now caught. Two round-1
survivors remain, M8 and M31, and both are agreed as non-blocking.
