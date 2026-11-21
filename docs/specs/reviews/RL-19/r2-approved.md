Verdict: APPROVED | Round: 2 | Blocking-open: 0

# Review of the RL-19 spec, round 2

This is a cold review of `docs/specs/RL-19.md`, revision 2 (commit 56841a1 on `spec/RL-19`), against
round 1 (`r1-changes-requested.md`, on 4f6d138). I read `git diff 4f6d138 56841a1 -- docs/specs/RL-19.md`
and the whole spec again, and checked the new claims against the code:
- `src/cli/hub-commands.ts`: `findPreset` / `findPresetSource` (112-128), `goal new --preset` (230),
  relay start (277-289), `mesh preset ls` / `show` (565-583);
- `src/cli/pulse-commands.ts`: `presetSnapshot` (42-57, wraps errors in `Usage`), its callers
  `pulse add` (185) and `pulse update --preset` (215), the `Usage` → exit 2 mapping (296-299);
  `src/main.ts:239-241` (an uncaught error exits 1);
- `src/core/presets.ts`: `parsePreset` (186-192, ignores unknown top-level keys), `presetText`
  (207-211);
- `src/hub/service.ts`: `presetChecks` (3475-3517) and its callers `createPulse` (3574),
  `updatePulse` (3680-3690), `goalFromPreset` (3798); `pulseWarnings` (3618-3623); `createWithPlan`
  (3855-3868, the fire path); `retargetItems` (6035-6080); `health` trial handling (4480-4501);
- `src/store/hub-store.ts`: `listArtifacts` (916-933), `listReviews` (1000-1021), `listItems`
  (1029-1033), `listPulses` (1168-1174, not deleted by default); `src/store/dialect.ts` (`binary`,
  `stepOrder`);
- `src/protocol/hub.ts` (`HUB_FEATURES` 760, `BySeverity` 896), `src/protocol/review.ts`
  (`StoredReview` 121-140, `ItemRow` 205-224), `src/core/finding-step.ts` (`lineageRepo`,
  `targetRepo` 39-48), `src/core/review.ts` (`lineageOf` 103);
- `test/helpers/pulse-kit.ts` (`RELAY_PARAMS` with an `agent` param, so AC-03's two lineages on one
  preset and repo are buildable), `calib-kit.ts`, `health-kit.ts`, `review-kit.ts`;
- `docs/guide/operations.md` (42, 97-99), `docs/guide/scheduled-reviews.md` (292, 503),
  `docs/guide/concepts.md` (`## Pulse health` 899-977).

Constraints hold: no cost field (Out line 32, AC-11), no composite score (line 33), generic names
(`alpha`, `beta`, `gamma`, `relay-a`, `pA`), release written `0.1.38`, schema 12, no migration
(lines 195-198, 211, 221).

## Round-1 findings

1. **RESOLVED.** CLI behaviour is now explicit: `presetText` writes `kind` (line 168),
   `findPresetSource` rejects an invalid `kind` with `presetKindProblem` (171-174), core `parsePreset`
   still drops it so stored snapshots fire (164-167), Compatibility and the operations sentence say
   an older CLI drops `kind` (211-213, 224-225), and AC-12 tests `mesh pulse add` both ways. The
   exit code for two of the four callers needs a word (new finding 2).
2. **RESOLVED.** `lineages` is a count (line 112), and AC-04 (line 240) fixes the run order (t1 < t2)
   and gives exact `lineages`, `open`, `pulse`, `lastRaisedAt` and `latestReport.ref` for every row,
   before and after the retarget. I checked the values against the home/source rule: (beta, relay-a)
   has contributing lineages `relay-a|beta|…` (home) and `relay-a|alpha|…` (via X1), source = home →
   pB, t1, RB; after A1 → gamma, (gamma, relay-a) has no home lineage → pA, t2, RA; (alpha, relay-a)
   keeps its row by the lineage-repo rule with zeros. All consistent.
3. **RESOLVED.** Home and source lineages (lines 79-83) take `kind`, `pulse`, `lastRaisedAt` and
   `latestReport` from the audit of the row's own repo when there is one; AC-04 pins it.
4. **RESOLVED.** Lines 61-65 now say those steps submit raising records with no items; AC-06 names a
   hub-opened calibration goal and a spot-check goal with submitted records.
5. **RESOLVED.** Line 116 states the difference from `runReportOf` is intended.
6. **RESOLVED.** `listItemsIn` is ordered by `lineage`, then `fp`, binary on both stores (189-190;
   `dialect.binary` exists for Postgres), and AC-10 checks the order across chunks.
7. **RESOLVED.** Lines 195-198 say read 3 scans `review_record` and why no index is added.
8. **RESOLVED.** `BySeverity` becomes exported, unchanged (91-92).
9. **RESOLVED.** The operations sentence is given verbatim with scope, schema 12, no migration, the CLI
   note, and where it goes (207-214); the feature-list change is fixed (`efficiency`,
   `findings-rollup`, `health`, release 0.1.38).
10. **RESOLVED.** AC-05 says `days=45`; dropped goals and partial records are stated (61, 67);
    `^\d{1,3}$`, `days=` and `days=0365` are in the table and AC-07; `kind` is glossed as the
    preset's top-level `kind` (110) and the guide subsection covers it (203); `health-kit.ts` is in
    the test surface (229-230).

## New findings

### 1. non-blocking: "Snapshots stored before this release are never re-checked" is not true for a params-only pulse update

Spec lines 175-177. `updatePulse` runs `presetChecks(body.preset ?? p.preset, …)` whenever `preset`
**or** `params` is in the body (service.ts:3686-3689). So once `presetChecks` gains the `kind`
problem, a pulse whose stored snapshot carries an invalid `kind` (possible only from an API client
that posted raw text before this release, since an older CLI drops `kind`) gets 422 on an update of
`params` alone. Either say so ("a params-only update of such a pulse is refused until its preset is
re-sent") or apply the `kind` check only to a preset given in the request body (create, ingest, an
update with `preset`). Either is fine; pick one so the implementer does not guess. Firing is not
affected: `createWithPlan` (3868) and `pulseWarnings` (3620) call `parsePreset`, not `presetChecks`.

### 2. non-blocking: "exit 2" holds for `mesh pulse add/update`, not as written for `mesh goal new --preset` and relay start

Spec lines 171-174 say `findPresetSource` "fails with that text (… exit 2, nothing sent)" for all four
callers. `findPresetSource` throws a plain `Error`; only `presetSnapshot` turns it into `Usage` → exit
2 (pulse-commands.ts:44-47, 296-299). `mesh goal new --preset` (hub-commands.ts:230) does not catch,
so the error reaches `main.ts:239-241` → exit 1; relay start (hub-commands.ts:283-288) maps to exit 2
only a message that starts with `preset `, else rethrows → exit 1. Nothing is sent in any case, so
the behaviour is safe. Say which it is: e.g. "exit 2 for `mesh pulse add/update`; `mesh goal new` and
relay start exit as they do for any invalid preset file today", or make the message start with
`preset <name>: ` (then relay start exits 2 too) and wrap `goal new`. AC-12 tests only `pulse add`,
so it stays testable as is.

### 3. non-blocking: `mesh preset ls` would list a file with a bad `kind` as valid

`mesh preset ls` parses repo files with `parsePreset` directly (hub-commands.ts:571), which by line
164 drops an invalid `kind` silently, while `mesh preset show` (583) goes through `findPresetSource`
and would fail. Optional: have `ls` show `invalid: kind must match …` through `presetKindProblem`, so
the listing agrees with `pulse add`. Not needed for any criterion.

### 4. non-blocking: AC-05 test setup note

AC-05 moves the clock 40 days. If the lineage comes from a scheduled pulse, a tick during that time
fires catch-up slots whose records fall in the window and the lineage is present at the default.
Building that lineage from a goal without a schedule (e.g. `goals/from-preset` or a disabled pulse),
or never ticking in between, avoids a flaky case. A test-design hint, not a spec change.

## Verdict

No blocking findings. The data model, reads and criteria are exact and match the code; findings 1
and 2 are wording fixes the author can make with the implementation.
