Verdict: APPROVED | Round: 2 | Blocking-open: 0

# Review of the RL-10 diff, round 2

Cold review of `git diff eee5fc0..impl/RL-10` (head eaa02aa, the developer's fix commit
"diff review r1 suggestions") against `docs/specs/RL-10.md` (base `docs/specs/RL-9.md`). I read the
spec rounds r1, r2 and r3 and the diff round `diff-r1-approved.md` first, oldest first.

Read: `src/hub/service.ts` (`findingIndex`, `findingStepsOf`, `syncDisposition`, `syncFold`,
`closeFinding`, `noteFinding`, the dispositions batch of `submitReview` and its `listed twice` check,
`applyDisposition` and its two callers, `revertDisposition`, `isRevertable`, `syncRevert`,
`droppedBy`, `pruneEvents`, `emit`, the work index `Work.byFinding` / `index` / `indexed` / `put`,
`loadTopic`, `loadAllTopics`, `workGoal`, `findings`, `retargetSteps`, `finishWork`, `writeWork`'s
`render`, `retargetItems` and its permission), `src/core/finding-step.ts` (`keyPathRepo`),
`src/protocol/review.ts` (`TargetRepo`, `ReviewKey`), `src/protocol/hub.ts` (`RetargetRequest`),
`docs/guide/concepts.md`, `docs/plan/implementation-plan.md`.

No CLAUDE.md. Hard rules applied: mesh-harness stays generic (nothing team-, company- or
person-specific in the fix), staging and committing by name. None broken.

## Process checks

| Check | Result |
|---|---|
| The developer changed no test | **Yes.** `git log eee5fc0..impl/RL-10 --no-merges --stat` lists one commit (eaa02aa) touching `docs/guide/concepts.md`, `docs/plan/implementation-plan.md`, `src/hub/service.ts`, `src/protocol/hub.ts`, `src/protocol/review.ts` only; `git diff eee5fc0..impl/RL-10 -- test` is empty. |
| No assertion on source text | Unchanged since round 1 (no test changed). |
| Every criterion has a test that failed first | Unchanged since round 1 (no test changed). |
| Run here | `vitest run` of `retarget-hub`, `retarget-cli`, `docs-rl10`, `schemas`, `sink-hub`, `sink-cli`, `sink-goals` on eaa02aa: 7 files, 172 tests passed. `pnpm check` (2662 passed) as stated by the caller. |

## Round-1 findings

| Finding | Status |
|---|---|
| S1 cross-goal lookups | **Fixed.** See "S1 in detail". |
| S2 API table / concepts wording | **Fixed.** The `POST /v1/items/sink` row states the RL-10 permission; concepts says "a live finding step of the lineage (not one moved away)". |
| S3 revert reopens every topic | **Fixed as asked, with a new weakness** (R1 below). |
| S4 caller text through `render` | **Partly fixed** (R2 below). `ReviewItem.repo` and `RetargetRequest.repo` now refuse control and private-use characters. |
| T1, T2 | Observations; nothing to do. |

### S1 in detail: the indexes hold

**`findingIndex` (fold, disposition batch).** It reads one step list per clean-audit goal, keeps the
steps of the lineage at their home id and not moved away, in `cleanAuditGoals` order: the same set
and order `findingStepsOf` returned per fp. The developer's claim that a stale entry is harmless
holds:
- `closeFinding` re-reads the goal's steps and gates on the fresh state (`cur.state` ready or
  blocked), so a stale "ready/blocked" entry can never close a step twice or close one that changed.
- Nothing inside these loops holds or un-holds a step. The loops only call `closeFinding`
  (ready/blocked → done/dropped, then `settle`, which moves steps only between ready and blocked and
  ends offers) and `noteFinding` (an `addNote`, no step write). No claim, release, reopen, create or
  move runs in them, and `applyDisposition` does not sink. So the held/not-held split the index
  shows is the true one for the whole loop, and a ready↔blocked change by `settle` does not matter
  (both close).
- A step can be visited twice only through a repeated fp: the batch refuses `listed twice` (422)
  before anything is written, and `f.resolved` / `again` come from the fold, one entry per fp and
  disjoint (the `again` loop acts only on `done` steps that existed before the call, which is what
  the old fresh read saw for a step not in `resolved`).
- No step or clean-audit goal is created inside the loops, so the index cannot miss one; no index
  miss can create a duplicate step (these paths never create) or skip a close.

**`Work.byFinding` (placing work).** `index` registers a step only at `${wg.gid}.${local}` (the
same key the old scan read), from `loadTopic` for stored steps and from every `put` (placeholder
goals included, since their steps carry the placeholder gid). Entries are never removed, but
`indexed` re-reads `wg.all` and re-checks lineage and fp, so a stale entry returns the current step
(callers still filter `isMovedAway` / closed as before). `ord` is the insertion index and nothing
deletes from `w.goals`, so `findings` keeps the old insertion order; `retargetSteps` keeps its
`goal` filter and `goalSeq` sort. Equivalent to the round-1 scans.

**Retarget permission.** It now loads every topic of a non-dropped clean-audit goal into the work
(the same goal set as `cleanAuditGoals`) and checks `wg.owner` (= `goal.ownerId` for stored goals;
no placeholder exists yet). Reads only; `retargetSteps`' later `loadAllTopics` reuses `allGoals`
and the loaded topics. Same answer as before.

## impl_findings

No blockers.

### R1 (REGRESSION-OF-OWN-REPAIR, suggestion): `droppedBy` depends on events the hub prunes
`syncRevert` now reopens a topic's home step only when `droppedBy` finds a `step.dropped` event on
the step with `at === d.at` and `payload.reason === d.disposition`. The matching itself is sound:
`closeFinding` emits at the `now` it is given, which is `seenAt.at`, and the returned
`DispositionRow.at` is the same `seenAt.at` on both callers (record batch and `mesh_dispose`); the
reason is the disposition kind (`dismissed` / `deferred`), not the reason text, so deferred and
dismissed are told apart and the text never matters; `moved` and `reverted` drops never match. Two
drops in the same millisecond cannot confuse it in a way that matters: a step is dropped at most
once until reopened, and a same-ms, same-kind second disposition of the same item has `from` equal
to that kind, so its revert lands on a non-filed state and never reaches the reopen branch.

The weakness is retention. `pruneEvents` deletes events older than `events_retention_days`
(default 180), but a debrief disposition stays revertable for as long as it is the item's latest
history entry (`isRevertable`), which has no time bound (a dismissed item of a lineage that is not
audited again). Past retention, `droppedBy` is false, `topics` is empty and the revert silently
reopens nothing, where RL-9 and round 1 reopened the dropped home step. The spec's row ("the home
step of the topic of the goal whose step that disposition dropped") does not depend on events.

Suggestion: decide from the step itself, which is durable. `closeFinding` writes the dropped step
with `summary = "<disposition> by <decider>: <reason>"` and `updatedAt = now = d.at`; a step that
is still `dropped`, not moved away, with `updatedAt === d.at` and a summary starting with
`${d.disposition} by ` was dropped by this disposition (a later reopen and drop changes both). Or
keep the event check and fall back to the step fields when the event is gone. No test covers the
narrowing; one with a step dropped in a second topic by something else (the S3 case) would pin it.

### R2 (REPEAT of S4, nit): `--from-key-path` still bypasses `TargetRepo`
`retargetItems` with `from_key_path` takes the item's key `path` as the target repo through
`keyPathRepo`, which only rejects `/` and file extensions. `ReviewKey.path` is 1–500 characters
with no character class, so a key path with a private-use (`…`) or control character,
or longer than 300 characters, still becomes a stored `ItemRow.repo`, a goal's `sink.repo` and the
text of `retarget to …` / `filed for repo …` notes, which `render` rewrites. Harmless, as before;
running `keyPathRepo`'s result through `TargetRepo.safeParse` (and noting `bad` on failure) closes
it.

`TargetRepo` itself is right: probed with zod 4, `"  a  "` passes (trimmed), `"   "` fails (trim
before `min(1)`), 300 characters plus trailing spaces pass and a leading space plus 301 fails (trim
before `max(300)`), `\u0007`, `` and supplementary private use (`\u{F0000}`) fail. Format
characters (`\p{Cf}`, e.g. U+200B) pass; that is outside S4 and harmless.

## test_findings

None. No test changed since round 1.

## Checks

Run: the git checks above; `vitest run` of the seven RL-9/RL-10 files (172 passed); a zod probe of
`TargetRepo`. Not run here (stated green by the caller): `pnpm check` (2662), the Postgres store
suite, `pnpm schemas`.
