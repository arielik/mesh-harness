Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 1

# RL-21 diff review, round 1 (commit 845fb64)

Cold review of `git show 845fb64` against docs/specs/RL-21.md (revision 3, approved). Security came
first: I tried to break the rights rules as the code is written, then mutated the guards in a scratch
copy to see whether the tests catch the change.

Baseline: in the copy, `tsc --noEmit` is clean and the full `vitest run` passes (145 files,
2938 passed, 107 skipped). The two RL-21 files pass 25 of 25.

## Security attack summary (no hole found in the code)

- **Name forms.** `resolveTarget` (src/hub/service.ts:633-661) checks `own()` on the resolved machine
  row in every branch (1-part, 2-part with a machine, the 2-part `<user>/<nick>` fallback, 3-part)
  before it calls `session()`. Every form that reaches another person's row gets
  `403 machine-not-yours`: bob's id, `bob/box`, `bob/box/<sid>`, `<id>/<sid>`, a missing session, or a
  bare ref that equals another machine's id. A row owned by someone else is refused and a name that
  matches nothing is 404, so a wrong name can only fail closed.
- **Nicknames.** `findMachine` (service.ts:599) looks a bare nickname up only among the acting
  person's machines (`machineByNickname(actor.userId, …)`), so bob's `box` never stands in for ann's.
- **Case.** `Bob/box` gives 404 and `Ann` gives `user-unknown`: `getUser` and `machineByNickname`
  compare exactly.
- **Sessions.** `findSessionOn` searches only the resolved machine (which is already the person's).
  `session()` then compares `hs.userId`, so a session of another user on the person's shared machine
  gets `session-not-yours`. Sid prefixes only search that machine.
- **Admin.** `actingFor` returns `roles: ["member"]` and no `machineId`. `assignStep` has no branch on
  role, so act-for gains no admin rights (AC-07).
- **Permission surface.** `headlessRun` (service.ts:885-900) requires the target to be the caller's
  own machine, refuses a session target or a stick, and enforces a declared profile, a pinned goal
  and, under act-for, `profile-not-yours`. `headlessGuard` still rejects unknown or unpinned names.
- **Header on suggest.** app.ts passes `write: POST || onBehalfOfRequired`, so a `steps:assign`
  service that sends no header gets `400 on-behalf-of-required`, with or without `team=1`.
  `suggestStep` also refuses `team` under act-for before it reads anything.
- **Idempotency.** The key is `${via}>${userId}` (app.ts). A replay for another person runs again
  rather than returning the first answer (AC-16; a mutation proves it).
- **Attribution.** `offerStepMessage` sets `offer.by` to the person and `offer.via` to the service,
  with no `bySid` or `byMachine` (a `sid` is refused earlier and an act-for actor has no machine).
  `step.offered` has `user` = the person and `payload.via`. The message has `data.by`, `data.via` and
  ends with ` (via svc)`. `OfferView.via` is set. All are asserted (AC-04, AC-07, AC-11, AC-14, AC-22).
- **Existing `error` texts.** Unchanged. The edits to assign.test.ts and suggest.test.ts only add
  `code`, and AC-17 checks a pulse refusal that has neither a code nor a changed text.

## Findings

1. **BLOCKING: AC-10 "sessions only ann's" has no test that catches a regression.**
   src/hub/service.ts:2061 filters the sessions passed to `suggest()` to `hs.userId === actor.userId`
   under act-for. Removing that filter (mutation M5) passes all 25 RL-21 tests, and assign.test.ts
   plus suggest.test.ts (231 tests) as well. The filter does matter. A probe in the copy put a
   session of bob on ann's `share: all` machine and called act-for suggest:
   - with the filter, the result was `idle: 0` and no `session`;
   - ann's own token got `idle: 1, session: "bob-on-ann"`;
   - without the filter, the service would see bob's session id and be pointed at a target that the
     assign then refuses.

   test_AC10_suggest_only_persons (test/step-assign-for.test.ts:253) only has sessions on each owner's
   own machines. The machine list is already limited to ann's, so the loop at line 264-267 can never
   fail. Fix: add a session of another user on `ann-box`, for example
   `k.w.hubStore.upsertSession(idle("bob-on-ann", { name: "intruder" }), "bob", c.ann.machine, k.w.clock)`
   as in test_AC06_session_not_yours. Then assert that ann-box's suggestion has `idle: 1` and
   `session: "ann-s1"`, and that `bob-on-ann` appears nowhere in the reply.

2. **Non-blocking (test gap, pre-existing code): AC-06 clause "a session on bob's machine named
   through ann's machine is not found (404 session-unknown)" is not tested.** No test sends
   `box/bwork` or `box/bob-s1` act-for. Removing `hs.machineId === m.id` in `findSessionOn`
   (service.ts:618, mutation M15) passes every RL-21, assign and suggest test. Under act-for the
   `session-not-yours` check still refuses it (with 403 instead of 404), so nothing is exposed. For an
   own-token assign, though, the mutant would let `m2/<sid on another machine>` build an offer whose
   `to.sid` is on a different machine. Suggest: add `box/bwork` → `404 session-unknown` to
   test_AC06_own_session.

3. **Non-blocking: the `machine-not-yours` text of the headless override differs from the spec.**
   service.ts:888 answers `machine not yours: <to> (a headless mode or profile is for your own
   machines)`. The spec's code table gives `machine not yours: <to>`. The text is new and `code` is
   the stable key, so clients are unaffected. Either drop the suffix or note it in the spec.

4. **Non-blocking hardening: the `profile-not-yours` condition relies on plan validation.**
   service.ts:895 skips the check whenever `step.policy?.profile !== undefined`, even when the step is
   not declared headless. For a non-headless step `profile-mismatch` does not apply, so a step that
   carried a stray `policy.profile` would let a service name another person's registered profile.
   Today that cannot happen: `validatePolicies` rejects a profile without `mode: headless`
   (src/core/policy.ts:77) on both plan paths. Tying the exemption to `declared &&
   step.policy?.profile !== undefined` would make the rule match the spec's wording ("a declared
   profile admits only itself") without depending on that.

5. **Info (accepted in the spec): `refuseHeadlessAccept` in the claim branch.**
   service.ts:2906 refuses any claim from the target machine of a headless offer, including a claim
   without a sid from the machine token. That matches the spec ("the accept branch of claim") and the
   compatibility note. The run path accepts through `/accept` without a sid, which AC-14 and AC-19
   exercise end to end.

## Mutation table

Each mutation was applied alone in a scratch copy
(/tmp/claude-1015/-home-ghost2-vpc-devel-mesh-harness/1309aed3-426f-4a87-8d98-c622fcf70a9b/scratchpad/rl21mut),
which was then run with test/step-assign-for.test.ts and test/step-assign-for-run.test.ts, then
restored. The real worktree was never changed.

| # | Mutation | Result | Caught by |
|---|---|---|---|
| M1 | machine ownership check in `resolveTarget` (`own()`) disabled | caught | AC05_other_machine_every_form, AC07_admin_grants_nothing |
| M2 | session ownership check (`session-not-yours`) disabled | caught | AC06_session_not_yours |
| M3a | act-for `sid` refusal removed | caught | AC09_act_for_options |
| M3b | act-for `stick` refusal removed | caught | AC09_act_for_options, AC20_profile_choice |
| M4 | suggest `team=1` refusal under act-for removed | caught | AC09_act_for_options |
| M5 | `suggestView` session filter (`hs.userId === actor.userId`) removed | **survived** (also survives assign.test.ts and suggest.test.ts) | none, see finding 1 |
| M6 | `onBehalfOfRequired` dropped from the `write` flag in app.ts | caught | AC02_header_required |
| M7a | `refuseHeadlessAccept` made a no-op | caught | AC18 |
| M7b | `refuseHeadlessAccept` removed from the claim branch only | caught | AC18 |
| M7c | legacy arm (`step.policy.mode === "headless"`) removed | caught | AC18 |
| M8 | tick reverted to declared mode only (no `runHeld`) | caught | AC19_run_held_narrow |
| M8b | `runHeld` no longer checks `kind === "print"` | caught | AC19_run_held_narrow |
| M9 | `profile-not-yours` check disabled | caught | AC20_profile_choice |
| M10 | own-machine rule for `mode`/`profile` disabled | caught | AC13_override_own_machine_only |
| M11 | idempotency key per service only (not `via>person`) | caught | AC16_idempotency_per_person |
| M12 | `owner` not passed to `resolveTarget` | caught | AC05, AC06_session_not_yours, AC07 |
| M13 | 2-part form looks the session up before the machine ownership check | caught | AC05 (`<id>/no-such-session` → 404) |
| M14 | `deciderOf` reverted to declared mode only | caught | AC19_run_held_narrow |
| M15 | `findSessionOn` machine filter removed (pre-existing) | **survived** (also survives assign.test.ts and suggest.test.ts) | none, see finding 2 |
| M16 | `actingFor` accepts a service account as the person | caught | AC03_unknown_person |
| M17 | `via` dropped from the offer | caught | AC04, AC07, AC11, AC14 |
| M18 | the override does not mark the offer headless | caught | AC11, AC12_pinned, AC14, AC18, AC19 |

## AC coverage

AC-01 to AC-22 each have a test. Each one fails under a matching mutation, except the session
clause of AC-10 (finding 1, blocking) and the cross-machine session clause of AC-06 (finding 2,
non-blocking because act-for still refuses it with 403).
