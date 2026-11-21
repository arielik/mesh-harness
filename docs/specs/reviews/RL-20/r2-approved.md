Verdict: APPROVED | Round: 2 | Blocking-open: 0

# Review of the RL-20 spec, round 2

This is a cold review of `docs/specs/RL-20.md`, revision 2 (commit 7a4e42f on `spec/RL-20`). It covers
the diff since round 1 (`git diff 3f4d88a HEAD -- docs/specs/RL-20.md`), checked again against the code:
- `src/hub/service.ts`: `presetChecks` 3479-3521, `createPulse` 3577-3617, `pulseWarnings` 3626-3662,
  `sinkTopic` 6106-6110, `checkSinkTopics` 6113-6115, `pinAgents` 6856-6876, `topicName` 7273-7278;
- `src/core/policy.ts`: `validatePolicies` 43-110;
- `src/core/review.ts`: `isRaising` 153-155 and `runOf` 161-179;
- `src/core/dag.ts`: `validatePlan` 27-49;
- `src/core/presets.ts`: `presetKindProblem` 192-202, `PresetStep` 17 and `instantiate` 258-306;
- `src/protocol/goal.ts`: `TopicName` 11-13, `HEADLESS_DEFAULTS` 181, `StepPolicy` and `PlanStep`
  470-534;
- `src/protocol/review.ts`: `ItemState` 10 and `Disposition` 13;
- `src/protocol/hub-api.ts`: the info text at 522.

## Round-1 findings

1. **B1, the sink topic's second 400: RESOLVED.**
   - Spec lines 122-128 now say that every 400 from `sinkTopic` is a problem, with its exact text, one
     per distinct refusal text, in step order, after the problems of (1).
   - AC-02 has a `ci/nightly` case, and the 400 `error` of create must equal the check's problem.
   - **The rules match the code.** `sinkTopic` (service.ts:6106-6110) does two things:
     - It calls `topicName`. `topicName` throws 400 `bad topic "<raw>": <first zod issue>` when the
       trimmed, lowercased name fails `TopicName` (service.ts:7273-7278). The regex is
       `^[a-z0-9][a-z0-9._-]{0,39}$` (goal.ts:11-13).
     - It throws 400 `unknown topic <name> (define with: mesh topic add <name>)` when the name is
       `ALL_TOPIC` or has no topic row.
   - Those are its only two throws.
   - **A sink topic like `ci/nightly` gets as far as `sinkTopic`.** The preset schema reaches
     `sink.topic` only through `PlanStep`'s `min(1).max(40)` (goal.ts:516, presets.ts:17), so
     `parsePreset` and `instantiate` accept it.
   - **A topic that trims to `""` is not a sink-topic problem.** It fails `PlanInput.parse` inside
     `instantiate` (presets.ts:305). It is therefore an instantiate error without a prefix, which the
     widened parenthesis at line 113 now covers.
   - **Create stops at the first refusal, which is also what the check reports.** `checkSinkTopics`
     runs only when (1) found nothing (service.ts:3517-3519) and stops at the first throw. That
     matches "create's 400 names the first" in AC-03.
   - See finding N1 below for the `<raw>` placeholder.

2. **B2, AC-01 fails `validatePolicies`: RESOLVED.** I traced the revised AC-01 preset through the
   create path:
   - **`parsePreset` / `instantiate`.** `kind: review` is a `StepKind` other than `design`
     (goal.ts:36, 529). `output: review-record`, `consumes: [open]` (an `ItemState` other than
     `resolved`) and `may_set: [accepted, dismissed]` (both `Disposition`s) are all valid in the
     schema (goal.ts:507-513).
   - **`validatePlan` gives no errors.** It has two steps, and neither `audit` nor `file` is the
     reserved `design`. The ids are unique, the dep `audit` exists and there is no cycle
     (dag.ts:27-49).
   - **`validatePolicies` gives no errors** (policy.ts:43-110):
     - **The sink rule (l.57).** `file.may_set` includes `accepted`.
     - **The `profile`/`budget`/`agent` rule (l.77).** Both steps are headless.
     - **`may_set` needs `consumes` (l.102).** `file` has `consumes`.
     - **`consumes` needs a raising run (l.107).** `runOf(file)` walks `deps` and finds `audit`.
       `audit` has `output` and no `consumes`, so `isRaising` is true (review.ts:153-155, 161-179).
     - **No other rule applies.** There is no `when`, gate, debrief, `sla`, `auto_accept`,
       `blind`, `target` or `inputs`.
   - **The first-step rule passes.** `audit` is the only step with no deps, and it is not a gate
     (service.ts:3507-3508).
   - **Profiles pass.** Both steps use the default `read-only` profile (goal.ts:181), the same as
     every existing headless preset test.
   - **Pins.** Only `audit`'s roster key is pinned. `checker` has no `/`, so it is skipped
     (service.ts:6866).
   - **Sink.** `" CI "` → `"ci"` (presets.ts:276), which is defined. `presetKindProblem` gives no
     problem for a text without a top-level `kind` (presets.ts:199).
   - **Result.** The check answers `ok: true`, and create answers 201.

3. **N1 (round 1 #3), authentication's `lastUsed` and daemons in AC-08: RESOLVED.**
   - Lines 60-63 name the token refresh as authentication's own write, not the route's.
   - AC-08 (line 210) fixes the World clock and excludes daemon syncing.

4. **N2 (round 1 #4), the `kind` flag: RESOLVED.** Lines 99-100 say `kind: true`, as create and
   ingest do (service.ts:3583, 3807).

5. **N3 (round 1 #5), `warnings` when not ok and for a service caller: RESOLVED.** The line-95 row
   now says three things:
   - The warnings use only the pins that resolved.
   - A roster key that does not resolve gives no warning.
   - A service token sees only the copies of machines shared with everyone.

6. **N4 (round 1 #6), cookie callers: RESOLVED.** Lines 64-66.

7. **N5 (round 1 #7), the OpenAPI text and the `read` parity: RESOLVED.**
   - Lines 67-68 change the info text (hub-api.ts:522).
   - AC-10 (line 212) now requires the `read` flag to match between `HUB_API` and the app, and the
     document's wording.

8. **N6 (round 1 #8), an older hub's answer: RESOLVED.** Line 191 says "a plain-text 404".

9. **N7 (round 1 #9), placeholder sources and `goal`: RESOLVED.** The `steps` row (line 96) now
   states the `vars` order of `instantiate` (presets.ts:262): the preset's defaults, then the body's
   `params`, then `repo` and `goal`.
   - One point is still left implicit: the `must_cover` drop when the plan has no acs (presets.ts:271).
     It does not change behaviour, so I am not raising it again.

10. **N8 (round 1 #10), the instantiate errors: RESOLVED.** Lines 112-114 cover the plan-shape error
    from `PlanInput.parse`, which has no prefix (service.ts:3497-3500).

11. **N9 (round 1 #11), the operations heading: RESOLVED.** The operations section and AC-10 both say
    "the current `## Upgrading to …` heading".

12. **"Otherwise valid" for the sink presets of AC-02/AC-03 (part of round 1 #2): PARTIAL,
    non-blocking.**
    - The spec does not say that those presets need the AC-01 relay shape (`may_set` including
      `accepted`, `consumes`, a raising step before them).
    - AC-01 is now a worked example of a valid sink step, and "each in a preset otherwise valid"
      (line 204) covers the rest.
    - Even so, an AC-03 test that writes `unknown dep + unknown sink` with a bare sink step gets one
      more 422 detail (`sink in step … needs a stage that may set accepted`, policy.ts:57). It still
      passes, because AC-03 compares with create's `details`, whatever they are. So this cannot make a
      test wrong. It can only make a test less focused.

## New findings

N1. non-blocking: **`<raw>` in the `bad topic` text is the instantiated topic, not the preset's text.**
   - `checkSinkTopics` passes `s.sink.topic` after `instantiate` has already trimmed and lowercased it
     (presets.ts:276, service.ts:6114).
   - So `topicName`'s `"${raw}"` (service.ts:7276) quotes the normalised name. For example,
     `sink: {topic: " CI/Nightly "}` gives `bad topic "ci/nightly": …`, not `bad topic " CI/Nightly ": …`.
   - Spec line 123 writes `bad topic "<raw>"` next to "(trimmed, lowercased)". A tester could read
     `<raw>` as the text in the preset.
   - The equivalence with create holds anyway, because the check and create share `sinkTopic`.
   - Suggested wording: `bad topic "<t>": <rule>`, where `<t>` is the step's `sink.topic` after
     substitution, trimmed and lowercased.

N2. non-blocking: **The collecting function must not mutate `steps` when a sink topic fails.**
   - `checkSinkTopics` rewrites `s.sink` in place (service.ts:6114).
   - The check keeps going past a refusal to collect every sink problem. Its reply has no `steps` when
     `ok` is false, so the mutation cannot be seen.
   - Even so, the shared function should check each step's topic through `sinkTopic` inside a
     try/catch, collect each 400's `error`, and leave the throwing wrapper (create, update, ingest)
     keeping today's first-throw behaviour. Otherwise "keep their statuses, messages and order of
     checks" (line 193) could break.
   - This is an implementation note. The spec text already requires the right observable result.

N3. non-blocking: **`warnings` need a pins map, not a `Pulse`.**
   - `pulseWarnings` takes a `Pulse` and reads `p.agents`, `p.preset` and `p.params`
     (service.ts:3626-3642).
   - To compute "from the pins that resolved" before any pulse exists, the implementation must either
     build a stand-in `{preset, params, agents}` from `pinAgents(...).agents` or narrow the signature
     to those three fields.
   - Either way works. Narrowing the signature is the cleaner choice, because it keeps create and the
     check on one function, which is what AC-04's "create returns the same warnings" relies on.

No blocking findings remain. Both AC-01 and the sink-topic rules are consistent with the code.
