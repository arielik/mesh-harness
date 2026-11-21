Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 2

# Review of the RL-20 spec, round 1

This is a cold review of `docs/specs/RL-20.md`, revision 1 (commit 3f4d88a on `spec/RL-20`). I used RL-12 and
RL-19 as the format and rigor bar. I checked the spec against:
- `src/hub/service.ts`: `presetChecks` (3479-3521), `createPulse` (3578-3617), `pulseWarnings`
  (3626-3662), `pulseDetail` (3674-3686), `updatePulse` (3689-3731), `goalFromPreset` (3803-3830),
  `createWithPlan` (3836-3889, which re-instantiates at 3877), `slotGoal` (6372-6390), `sinkTopic` /
  `checkSinkTopics` (6105-6115), `topicName` (7273-7278), `resolveRoster` / `pinAgents`
  (6814-6876), `agentCopyVisible` (6726-6728), `authenticate` / `actingFor` /
  `checkTargetForPerson` (2121-2165) and `resolveProfile` (865-870);
- `src/hub/app.ts`: `body()` (79-88), the error handler (~545-551), the auth middleware (~553-571),
  the route wrapper with idempotency (573-593) and the GET-only web fallback (`app.get("*")`);
- `src/auth/tokens.ts` `verify` (54-62) and `src/core/roles.ts` `allowed` (53-59);
- `src/protocol/pulse.ts` (`PresetSnapshot`, `PulseParams`, `checkedAgents`, `PulseDetail`
  231-238), `hub-api.ts` (`HubApiRoute` 73-92, `hubOpenApi` 481-544), `hub.ts` (`HUB_FEATURES` 760),
  `goal.ts` (`TopicName` 11-13, plan-step `sink` 516, `PlanStep` 526-534) and `roster.ts` (`AgentDef`);
- `src/core/presets.ts` (`presetKindProblem`, `parsePreset` and `instantiate` 258-306, including the
  sink normalisation at 276), `src/core/dag.ts` (`validatePlan`) and `src/core/policy.ts`
  (`validatePolicies`);
- `src/store/hub-copy.ts` `TABLES`, `test/helpers/{world,pulse-kit,roster-kit}.ts` and
  `test/schemas.test.ts` (route parity).

These claims are correct:
- **422 `details` order.** The order is: repo, kind, a parse error (which stops the list), an
  instantiate error (which stops the list), `validatePlan` + `validatePolicies`, the first step,
  profiles, then roster pins. This matches `presetChecks` 3482-3516.
- **sha256 check.** It runs first, as a 400 (3480).
- **Auth texts.** The on-behalf 400 and the 401/403 texts match `actingFor` (2142) and app.ts:577.
- **Sink topics in `steps`.** `instantiate` already trims and lowercases sink topics
  (presets.ts:276). The check's `steps` and `PulseDetail.steps` both give `"ci"` for `" CI "`
  without a topic lookup.
- **A slot's goal gets the same plan.** `createWithPlan` re-instantiates the stored text with
  `pulse.params` (3877, through `slotGoal` 6374-6382).
- **Pins.** `pinAgents` pins only keys containing `/`, keyed by the string as written, with
  `AgentDef` values (6856-6876).
- **No writes in the helpers.** `resolveProfile`, `resolveRoster` and `pinAgents` only read.
  `checkSinkTopics` changes only the in-memory steps.
- **Idempotency.** It lives entirely in the app wrapper (app.ts:581-591), so a route-level `read`
  flag is enough to skip it.
- **Owner rules.** There is no cost field, no composite score and no company, team or product name.

## Findings

1. **BLOCKING: the sink-topic case has a second 400 that the spec does not cover.**
   - **What create does today.** `sinkTopic` calls `topicName` (service.ts:6107). `topicName` throws
     400 `bad topic "<name>": a topic is 1-40 characters: lowercase letters, digits, '.', '_' or '-',
     starting with a letter or digit` (service.ts:7273-7278, goal.ts:11-13). This happens for a name
     that passes the plan schema but is not a valid topic name. The schema only requires
     `min(1).max(40)` for `sink.topic` (goal.ts:516). Examples: `sink: {topic: "ci/nightly"}`,
     `"a b"`, or a `{param}` that fills to such a name.
   - **What the spec says.** Lines 109-117 name only `unknown topic <t> (define with: mesh topic
     add <name>)`.
   - **Why it breaks the spec.** An implementation that follows the spec does one of two things:
     - It lets the `bad topic` HubError escape. The check then answers 400 instead of 200 with
       `ok: false`, which breaks "Reply 200 ... for a body that passed the checks above" (line 80).
     - It reports nothing. That breaks "check gives `ok: true` ⇒ create passes the preset checks"
       (line 117).
   - **Fix.**
     - Say that the check turns **any** 400 from `sinkTopic` into a problem with its exact `error`
       text. That covers both a bad name and an unknown topic (including `all`).
     - Keep one problem per distinct topic, in step order, after the problems of (1).
     - Add a `bad topic` case to AC-02: create's 400 `error` must equal the check's problem.

2. **BLOCKING: AC-01's preset fails `validatePolicies` as described, so the AC cannot pass.**
   - **The rules it breaks.**
     - A step with `sink` needs a stage that may set `accepted` (policy.ts:57).
     - `may_set` needs `consumes` (policy.ts:101).
     - `consumes` needs an earlier step, reached through deps, with `output: review-record` that
       raises items (policy.ts:104-105).
   - **What AC-01 gives.** `audit` (headless, roster key) and `validate` (`deps: [audit]`, headless,
     repo agent `checker`, `sink: {topic: " CI "}`), with none of the fields above.
   - **Result.** A correct implementation answers `ok: false` with `sink in step validate needs a
     stage that may set accepted`, and create answers 422.
   - **Fix.**
     - In AC-01, give `audit` `output: review-record` and give `validate` `consumes: [open]` (or
       similar) and `may_set: [accepted]`.
     - Say the same for the sink presets of AC-02 and AC-03. "Each in a preset otherwise valid"
       covers them, but naming it once avoids the trap.

3. non-blocking: **"Writes nothing" is not literally true of authentication.**
   - `Tokens.verify` writes `token.lastUsed` (`touchToken`) when more than 60 s have passed since
     the token's last use (tokens.ts:60). It does this on every authenticated route, reads included.
   - Line 41 ("no ... other row") and AC-08 hold only because the World clock does not move. AC-08
     requires the rows of every hub table to be identical, and `token` is in `TABLES`
     (hub-copy.ts:16).
   - Suggested wording: "writes nothing beyond what authenticating any request writes (a token's
     `lastUsed`, at most once a minute)".
   - In AC-08, either state that the World clock stays fixed across the snapshot and the calls, or
     leave the token's last-used column out of the comparison.
   - Also state that no daemon activity runs between the snapshot and the comparison, or take the
     snapshot only after the daemons are quiet. World daemons can write `hsession` rows and events.

4. non-blocking: **The check's `kind` flag.**
   - `presetChecks` checks `kind` only when `o.kind` is set (~3487-3491).
   - Create and ingest pass `kind: true`. Update passes it only for a new preset (3698).
   - The spec lists the kind problem unconditionally (line 97), which implies `kind: true`. Say so
     in the split ("the collecting function with `kind: true`, as create"), so the implementer does
     not copy the update default.

5. non-blocking: **`warnings` when `ok` is false, and for a service caller.**
   - **When `ok` is false.** `pulseWarnings` takes a `Pulse` and reads `p.agents` for roster keys
     (3639-3642). The spec wants warnings even for a preset that instantiates but is not ok
     (line 86). Say that the warnings then use the pins that did resolve, and that a key that failed
     to resolve gives no warning.
   - **For a service caller.** A repo agent's copies are filtered by `agentCopyVisible`
     (6726-6728): `share: "all"`, or `share: "me"` on the viewer's own machine.
     - A service token checks as itself, but its create runs on-behalf as the person. So the check
       can show fewer repo-agent warnings than the person's create would.
     - AC-04 uses a member, so it is fine.
     - Add one sentence saying the warnings are those the caller sees, and that a service sees only
       `share: all` copies.

6. non-blocking: **Cookie callers.**
   - A dashboard session (cookie) that sends a `POST` from another origin gets 403
     `cross-origin request refused` (app.ts ~565-568). The GET reads do not have this rule.
   - The Source section names a dashboard client. Add a sentence under the route: "a browser session
     must call from the hub's own origin, as for every `POST`; other clients use a token".

7. non-blocking: **OpenAPI info text and the parity test.**
   - `hubOpenApi` says "POST routes accept an idempotency key header for safe retries"
     (hub-api.ts:522). A read `POST` that ignores the key makes this wrong. Reword it in the same
     change, for example "POST routes other than reads accept ...".
   - Line 59 makes `read` two copies of one flag: one in `HUB_API` and one in the app's route table.
     The parity tests (`test/schemas.test.ts` 148-151 and similar) compare only method, path, rule
     and scope. Have them compare `read` too.

8. non-blocking: **An older hub's answer.**
   - Line 176 says an older hub answers "with the web fallback (a `POST` to an unknown path → 404)".
   - The web fallback is `app.get("*")`, so it never sees a `POST`. A `POST` to an unknown path gets
     Hono's default not-found: a 404 with plain text, not JSON.
   - Reword to "a 404 (not JSON)".

9. non-blocking: **Details of the `steps` definition.**
   - `instantiate` also fills in the defaults from the preset's own `params:`
     (`{...p.params, ...opts.params, ...}`, presets.ts ~263), not only the `params` from the body.
   - It also drops `must_cover` when the plan has no acs (presets.ts ~269).
   - Both are true of create and of a slot's goal, so the behaviour does not change. But "`{repo}`
     and every param are substituted" (line 87) should say "every param, from `params` or the
     preset's `params:` defaults".
   - A param named `goal` is overridden by "this goal" because of the order of `vars`, as at create.
     It is worth one clause.

10. non-blocking: **Instantiate errors include the zod parse of the plan.**
    - `instantiate` ends with `PlanInput.parse` (presets.ts ~305).
    - So a step that fills to an invalid plan step is an "instantiate error" with the zod text and
      no `preset <name>:` prefix (service.ts ~3497-3500). Examples: an empty `repo`, a sink topic
      that trims to `""`, or a title over 200 characters after substitution.
    - The spec's parenthesis (line 100) lists only unknown params and budgets. Widen it so a tester
      does not expect a prefix.

11. non-blocking: **Heading for the operations sentence.**
    - Line 162 puts the sentence under `## Upgrading to 0.1.38`, but the release is `0.1.39`.
    - If the release renames the heading, as earlier releases did, say "under the current
      `## Upgrading to …` heading". That way the AC-10 docs test pins the right heading at release
      time.
