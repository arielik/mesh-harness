# Test plan RL-4: Debrief

Spec: `docs/specs/RL-4.md` (revision 2, approved in review round 2).

Inputs read: `docs/specs/RL-4.md` (interface contracts, acceptance criteria, open questions); the role
file `assets/sdd/.claude/agents/test-planner.md`; the format of `docs/specs/plans/RL-3-test-plan.md`
(first 60 lines); the RL-2 disposition check texts in `docs/specs/RL-2.md` ("Applying a disposition",
checks 1..6, AC-13, AC-14); the file names of existing tests under `test/`, `test/helpers/`,
`test/e2e-web/`, `src/*/*.test.ts`, `src/cli/tui/*.test.ts`; the `describe` titles of
`test/review-hub.test.ts`, `test/schemas.test.ts`, `src/claude/skill.test.ts`,
`src/cli/tui/render.test.ts`, `src/store/hub-store.contract.test.ts`, `test/e2e-web/mine.spec.ts`; the
exported names and method signatures of `test/helpers/world.ts` (`World.start`, `login`, `person`,
`hook`, `tool`, `session`, `tick`, `flush`, `api`, `call`, `clock`, `stopHub`, `startHubAgain`,
`FAKE_CLAUDE`), `test/helpers/relay-kit.ts` (`Relay`: `call`, `goal`, `plan`, `stepOf`, `assign`,
`act`, `events`, `allEvents`, `inboxOf`, `offerMsg`, `upload`, `local`, `cli`; `MIN`, `DAY`, `GHP`,
`until`) and `test/helpers/review-kit.ts` (`Rk`: `start`, `goal`, `claim`, `review`, `reviewOk`,
`close`, `closeOk`, `submit`; `item`, `disp`, `rec`, `fp`, `fpOf`, `S`, `relayPlan`, `DAY_MS`,
`NOV19`); the header comment of the fake `claude` fixture.
Not read: `docs/specs/plans/RL-4-impl-plan.md` (the implementation plan); any implementation source of
this row or of the code it changes (`src/protocol`, `src/core`, `src/store`, `src/hub`, `src/daemon`,
`src/claude`, `src/cli`, `web/`), not even to check a name.

Planned black-box from the contracts. Every negative assertion has a positive control in the same test
or a named sibling, so a test cannot pass because nothing happened. Each criterion names at least one
mutation of the implementation that must turn one of its tests red; the implementer or reviewer applies
it once by hand, confirms red, and reverts.

Rules from the spec's AC preamble that every test follows: steps are found by id, items by fp, events by
`type` + `payload.step` (never by list position or count of the whole stream); no test runs the real
`claude` binary or tmux (CLI tests use a fake `runner`; World tests that start a run use `FAKE_CLAUDE`);
daemons that must know a repo or session have a git remote and `shareSessions: "me"`; World tests that
move the clock past 14 days give device tokens a longer max age (as `test/pulse-daemon.test.ts`). All
time comes from the World clock (`w.clock`), never `Date.now()`.

## Surfaces and files

| Surface | File | New or extended |
|---|---|---|
| unit, protocol (`StepPolicy`, `DisposeRequest`, `RevertRequest`, `ReadRequest`, `DispositionRow`, `ItemHistoryEntry`, `TOOLS`, `MESH_DEBRIEF_SKILL`) | `src/protocol/review.test.ts` (extended, `describe("RL-4 AC-01 schemas")`) and `src/protocol/debrief.test.ts` (new: AC-16 skill text, AC-21 `TOOLS`) | both |
| unit, core (`validatePolicies`, `policyOf`, `debriefAssignee`) | `src/core/policy.test.ts` | extended (`describe("RL-4 AC-02 debrief policies")`) |
| unit, `renderOffers` | `src/cli/tui/render.test.ts` | extended (`describe("RL-4 AC-17 debriefs in the o panel")`) |
| unit, TUI keys (fake TTY, fake `DaemonClient`) | `src/cli/tui/tui.test.ts` | new (see Risks: needs a test seam into `tui.ts`) |
| unit, daemon `brief()` | `src/daemon/brief-inputs.test.ts` | extended (`describe("RL-4 AC-13 debrief brief")`) |
| unit, skill install/status with a text argument | `src/claude/skill.test.ts` | extended (`describe("RL-4 AC-16 mesh-debrief skill")`) |
| `HubStore` contract (SQLite always, Postgres when `PG_URL`) | `src/store/hub-store.contract.test.ts` | extended (`describe("RL-4 store filters")`) |
| World: hub routes, claim, read, view, lists, dispositions, revert, record, context, events | `test/debrief-hub.test.ts` | new |
| World: daemon (`mesh_dispose`, `mesh_review` reply, local routes, offline) | `test/debrief-daemon.test.ts` | new |
| CLI: `mesh debrief`, `mesh run --step`, `mesh setup`/`doctor`/`skill --debrief`/`help`, `mesh ledger export` | `test/debrief-cli.test.ts` | new |
| schemas, route table, docs, skill, version, boundaries | `test/schemas.test.ts` | extended (`describe("RL-4 AC-23 docs and skill")`, `describe("RL-4 AC-24 checks, schema, boundaries")`) |
| Playwright | `test/e2e-web/mine.spec.ts` (AC-19), `test/e2e-web/goals.spec.ts` (AC-20) | extended (`test.describe("RL-4 AC-19 …")`, `test.describe("RL-4 AC-20 …")`) |
| existing tests the spec says change | tests comparing `TOOLS`, `OFFERS_FOOTER`, `HUB_API`, setup/doctor output, `ReviewResult` shape | updated by the test-writer (spec, Compatibility); nothing else in them changes (AC-21) |

### Test-side helper (new, `test/helpers/debrief-kit.ts`, built on `Relay` and `Rk`)

- `Dk.start(o?: {clock?, hubYaml?})` → `Relay.start(["alice", "bob", "carol", "dave"], {admins: ["bob"]})`;
  clock `NOV19`; `alice` and `bob` as daemons (`w.person(name, "svc", {shareSessions: "me"})`, the repo
  with a git remote); `carol` and `dave` as logins only (tokens). Cast: **alice** = goal owner and
  assignee, **bob** = admin, **carol** = member (used as the new owner in AC-04), **dave** = plain member
  (neither decider, owner nor admin; AC-11).
- Items (via `item(rule, {path, symbol, severity, title, evidence})`): `A` = rule `r.alpha`, path
  `src/a.ts`, symbol `fa`, S1, title `Alpha leak`, evidence `[{path: "src/a.ts", lines: [3, 5], note:
  "NOTE-A"}]`; `B` = rule `r.beta`, `src/b.ts`, S2; `C` = rule `r.gamma`, `src/c.ts`, S3. Fps from `fp()`.
- `relay()`: plan `[S.audit(), debrief, file]` where `debrief = S.step("debrief", {kind: "review", deps:
  ["audit"], mode: "debrief", output: "review-record", may_set: ["accepted", "dismissed", "deferred"]})`
  (no `consumes`, no `assignee`), `file = S.step("file", {deps: ["debrief"], output: "review-record",
  when: {open: true}, consumes: ["accepted"]})`. Returns `{G, AU, D, F}` (step ids from `stepOf`).
- `auditDone(items = [A, B, C], report = "REPORT-TEXT")`: alice claims audit, uploads a `report`
  artifact (`kind: "report"`, content `report`), records `rec({items})`, closes done (as
  `test/review-hub.test.ts` does) → debrief `ready`.
- `hold(p = alice)`: SessionStart hook on a fresh pid, `mesh_claim {step: D}` through `w.tool` → returns
  `pid`; `dispose(pid, fp, disposition, extra?)` = `w.tool(alice, pid, "mesh_dispose", {fingerprint,
  disposition, reason: "R-<fp>", answer: "ANS-<fp>", ...extra})`.
- `route(who, verb, body, idem?)` = `call(who, "POST", "/v1/steps/<D>/<verb>", body)` with an optional
  `Idempotency-Key` header (as `Rk.review(…, idem)` sends it).
- `history(fp)` = the item's entries from `GET /v1/items?lineage=…&fp=…` (or the item route RL-2 serves),
  `notes(D)` = the step's notes, `ev(type)` = `events(type, D)`.

## Criteria

Notation per test: **Setup / Stimulus → Expect. FAILS when … . Control: … . Mutation: …**

### AC-01 Schemas (unit, `src/protocol/review.test.ts`)

- `test_AC01_step_policy_mode_and_assignee`: `StepPolicy.safeParse` of `{mode: "debrief"}`,
  `{mode: "debrief", assignee: "@owner"}`, `{…, assignee: "bob"}` → success; `assignee: "@bob"`, `""`,
  `"a b"`, `"x".repeat(101)` → failure (the first with message `assignee is a user id or @owner`).
  FAILS when any value parses the other way. Control: `"bob"` and `"x".repeat(100)` pass in the same test.
  Mutation: regex `^\S{1,100}$` (accepts `@bob`) → red; drop `"debrief"` from the enum → red.
- `test_AC01_dispose_request_strict`: valid body (16-char base32 fp, `accepted`, reason, answer) parses;
  missing `answer`, `reason: ""`, `answer: ""`, fp `ABCDEFGHIJKLMNOP` (uppercase) / 15 chars, extra key
  `{x: 1}`, `until: "2026-1-1"`, `reason` of 2001 chars → each fails. FAILS when one of them parses.
  Control: the valid body and one with `until`, `link`, `sid` parse. Mutation: `answer` optional →
  red; `.strict()` removed → red.
- `test_AC01_revert_and_read_request`: `RevertRequest` `{fingerprint}` and `{fingerprint, reason}`
  parse, `{fingerprint, x: 1}` and `reason: ""` fail; `ReadRequest` `{}` parses, `{x: 1}` fails.
  Control: positive cases. Mutation: `ReadRequest = z.object({})` without strict → red.
- `test_AC01_read_route_400` (World, `test/debrief-hub.test.ts`): `POST /v1/steps/<D>/read {x: 1}` by
  alice → 400, `Step.read` absent. Control: `{}` → 200 in the same test. Mutation: route parses with a
  non-strict schema → red.
- `test_AC01_rl2_rows_parse_unchanged`: a literal RL-2 `DispositionRow` (`via: "stage"`, no `answer`) and
  RL-2 `ItemHistoryEntry` literals (fold, carry and `kind: "disposition"` as RL-2 stored them) parse and
  round-trip deep-equal; a `kind: "revert"` entry (`disposition: "accepted"`, `decider: {kind: "person",
  user: "alice"}`, `via: "ui"`, base fields) parses; `via: "debrief-session"` with `answer` parses;
  `via: "ui"` on a disposition entry fails; a revert with `decider.kind: "agent"` fails. FAILS when an RL-2
  row fails or a malformed one parses. Control: the positives. Mutation: `answer` required → red;
  `via: z.literal("debrief-session")` → red (stage rows fail).

### AC-02 Policies (unit, `src/core/policy.test.ts`)

- `test_AC02_exact_new_messages`: `validatePolicies` on four plans (each built from the relay fixture
  with one change): `audit` given `gate: true` + `mode: "debrief"` (or the gate form the plan API uses)
  → errors exactly `[step "audit": a gate step can't be a debrief]`; `file` with `assignee: "bob"` →
  exactly `[step "file": assignee needs mode: debrief]`; debrief without `output` → exactly
  `[step "debrief": a debrief step needs output: review-record]`; debrief without `may_set` → exactly
  `[step "debrief": a debrief step needs may_set (the decisions the person may record)]`. Compared with
  `toEqual` on the full error list. FAILS on a missing, extra or reworded message. Control:
  `test_AC02_fixture_valid` below. Mutation: emit both the gate message and the may_set message for a
  gate debrief → red; change one character of a message → red.
- `test_AC02_agent_on_debrief`: debrief with `agent: "auditor"` → exactly RL-1's `profile, budget and
  agent need mode: headless` message (copy the text from the existing RL-1 test in the same file).
  Mutation: skip that check for `mode: debrief` → red.
- `test_AC02_fixture_valid`: relay fixture → `[]`. Mutation: require explicit `consumes` → red.
- `test_AC02_no_raising_upstream`: plan `[debrief]` alone (no audit), deps `[]` → contains RL-2's
  `consumes needs an earlier step…` error (exact text copied from the RL-2 policy test). FAILS when the
  default `consumes` is not applied during validation. Control: fixture valid. Mutation: validate the
  raw policy without the default → red.
- `test_AC02_policyOf_defaults`: `policyOf(debrief)` has `consumes: ["open", "confirmed"]` and
  `assignee: "@owner"`; with explicit `consumes: ["open"]` and `assignee: "carol"` both are kept;
  `policyOf` of an interactive step with no `assignee` has no `assignee` key and no `consumes` added.
  Mutation: default `consumes: ["open"]` → red; overwrite explicit `assignee` → red.
- `test_AC02_debriefAssignee`: `(undefined, "alice")`, `({mode: "debrief"}, "alice")`,
  `({…, assignee: "@owner"}, "alice")` → `"alice"`; `({…, assignee: "bob"}, "alice")` → `"bob"`.
  Mutation: return `policy.assignee` verbatim → red.

### AC-03 Never offered (World, `test/debrief-hub.test.ts`, `describe("AC-03 never offered")`)

- `test_AC03_assign_409`: relay, `auditDone()`; alice `POST /v1/steps/<D>/assign {machine: bob's}` →
  409 `<D> is a debrief step: only alice runs it (mesh debrief <D>)`; no `step.offered` event for D; bob's
  inbox has no offer for D. Control: in the same goal a sibling interactive ready step `side` (added to
  the plan, no deps) assigned the same way → 2xx and one `step.offered`. Mutation: drop the debrief check
  in assign → red.
- `test_AC03_assign_checks_order`: assign on a `blocked` debrief (before audit done) → the existing
  state error (not the debrief text). FAILS when the debrief check runs first. Control: the ready case.
- `test_AC03_goal_assign_only_debrief`: relay, only `D` ready (audit done, no other ready step) → goal
  assign 409 `<G> has no ready step to offer`, no `step.offered`. Control: with `side` ready too, goal
  assign offers `side` only (one `step.offered` with step `side`, none with D). Mutation: count debriefs
  as ready in goal assign → red.
- `test_AC03_stick_no_offer`: goal with a stick to bob's machine; audit done → D `ready`;
  `w.flush()`; no `step.offered` for D, no message for D in bob's inbox. Control: `side` made ready
  through the same stick gets its offer message. Mutation: `emitReady` without the debrief filter → red.
- `test_AC03_ready_list`: `GET /v1/steps?ready=1` and `?ready=1&repo=svc` → neither contains D; both
  contain `side`. `mesh_next` (alice session) output does not mention D, does mention `side`.
  Mutation: drop the filter from the ready query → red.
- `test_AC03_tui_n_never_claims`: call the daemon's `assignNext` path the TUI `n` key uses (through the
  daemon client / local route it calls) with only D ready → D stays `ready`, no holder; with `side`
  ready → `side` claimed. Mutation: as above.

### AC-04 Claim (World + CLI, `describe("AC-04 claim")`)

- `test_AC04_admin_refused`: bob (admin) `POST /v1/steps/<D>/claim` → 403 `<D> is a debrief for alice;
  only they can take it`; `POST …/take` → same 403; step still `ready`, no holder, no `step.claimed`.
  Control: alice claim → 200, `claimed`, `holderUser: "alice"`. Mutation: allow admins → red.
- `test_AC04_take_from_holder`: alice claims; bob `take` → 403 same text, holder still alice. Mutation:
  check only in `claimInTx`, not `takeStep` → red.
- `test_AC04_named_assignee`: debrief with `assignee: "bob"`: alice (owner) claim → 403 `<D> is a debrief
  for bob; only they can take it`; bob → claimed. Mutation: owner bypass → red.
- `test_AC04_owner_resolved_at_claim`: fixture debrief; set the goal's `ownerId` to `carol` through the
  store (`w.hub.store` goal update, as other World tests reach the store); alice claim → 403 text naming
  `carol`; carol claim → claimed. FAILS when `@owner` was frozen at plan time. Mutation: `policyOf`
  stores the resolved owner id → red.
- `test_AC04_cli_mesh_run_step`: bob runs `mesh run svc --step <D>` through `r.cli(bob, …, {runner:
  fake})` → exit 1, stderr contains the 403 text, fake runner saw no tmux call, step `ready`. Control:
  alice the same → exit 0, runner called, step claimed.
- `test_AC04_accept_open_offer`: ready interactive step `x` assigned (offered) to bob's machine; owner
  replans the goal with `x` given `mode: "debrief"` (same id, assignee `@owner` = alice), offer left open;
  bob `POST /v1/steps/<x>/accept` → 403 same text, step unchanged (no holder, state as before). Control:
  alice `accept` is not refused by the assignee check (status ≠ 403 with the debrief text; either 2xx or
  an offer-specific error that is not the assignee text). Mutation: assignee check only in the claim
  route handler → red.

### AC-05 Pre-read (World, `describe("AC-05 read")`)

- `test_AC05_read_by_assignee`: D ready; alice `POST …/read {}` → 200 `{read: {user: "alice", at:
  <clock>, round: 1}}`; `GET` step has `read` equal; one event `step.read` for D with payload `{round: 1}`
  (plus user/goal/step). Second read after `clock += MIN` replaces `at`. Mutation: round 0 → red; append
  instead of replace → red.
- `test_AC05_read_refusals`: bob → 403 `<D> is a debrief for alice; only they can take it`; audit (not
  a debrief) → 409 `<AU> is not a debrief step`; fresh relay with D `blocked` → 409 `<D> is blocked`;
  unknown id → 404 `no step <id>`. None sets `read` or emits `step.read`. Control: alice's read in the
  previous test.
- `test_AC05_round_read_on_done`: alice reads, claims, submits the debrief record (`dispositions: []`),
  closes done → round 1 has `read: {user: "alice", at}` (equal to `Step.read.at`). Second goal: no read
  → round 1 has no `read` key. Mutation: copy `read` regardless of round → red (see next); never copy →
  red.
- `test_AC05_read_other_round`: (stale read) alice reads in round 1, the step is reopened to round 2
  (as RL-2 tests reopen), done without a new read → round 2 has no `read`. Mutation: copy without the
  round comparison → red.

### AC-06 Debrief view (World, `describe("AC-06 view")`)

- `test_AC06_view_fields`: `auditDone()`; `GET /v1/steps/<D>/debrief` by alice → `step: D`, `goal: G`,
  `assignee: "alice"`, `run: AU`, `lineage` (non-empty, equal to the items' lineage), `report.content:
  "REPORT-TEXT"`, `report.artifact.kind: "report"`, `items` fps `[A, B, C]` (toEqual, order), all
  `state: "open"`, `items[0].evidence` = `[{path: "src/a.ts", lines: [3, 5]}]` (no `note` key, string
  `NOTE-A` absent from the JSON), `decided: []`, no `read`. Same reply (deep-equal) for bob and for a
  `goals:read` token of carol. Mutation: order by `first.at` only → red (insert C before A in the
  record); keep `note` → red; report from the first round instead of the last → see next.
- `test_AC06_report_latest`: audit uploads two `report` artifacts (`R1`, then `R2`) → `content: "R2"`.
  Mutation: first upload wins → red.
- `test_AC06_near_matches`: goal whose audit raises A, `A2` (rule `r.alpha`, path `src/a.ts`, symbol
  `fb`), `A3` (rule `r.alpha`, path `src/moved.ts`, symbol `fa`), `A4` (rule `r.alpha`, path `src/z.ts`,
  symbol `fz`), `A5` (rule `r.alpha`, path `src/y.ts`, no symbol) → A's `nearMatches` fps set = `{A2,
  A3}` (each once, sorted by fp), A2's contains A, A4 and A5 not in A's. Entries carry `state`, `title`,
  `symbol`. FAILS on a missing or extra near-match. Mutation: same rule only → red (A4 appears); same
  path only → red (A3 missing); match an undefined symbol to an undefined symbol → red (A5 vs another
  no-symbol item: add `A6` rule `r.alpha` path `src/w.ts` no symbol; A5 must not list A6).
- `test_AC06_consumed_filter`: lineage where A was dismissed in an earlier goal and carried (as RL-2's
  carry tests do) → the new goal's view lists B, C only. Control: the earlier goal's view listed A.
  Mutation: list all items of the record → red.
- `test_AC06_errors_and_empty`: on AU → 409 `<AU> is not a debrief step`; unknown id → 404 `no step
  <id>`. D before audit's record → 200 `items: []`, `report` absent, `decided: []`. FAILS on a different
  status or a non-empty `items`. Control: `test_AC06_view_fields`. Mutation: 404 instead of 409 for a
  non-debrief → red.

### AC-07 `GET /v1/debriefs` (World + clock, `describe("AC-07 list")`)

- `test_AC07_states`: alice's list: D absent while `blocked`; present while `ready` (`items: 3`, `read:
  false`), after a read `read: true`, `claimed`, `paused` (via the pause route); absent after `done`.
  Summary fields `step, goal, title, repo, state`. Two debriefs → ordered by step id. bob → `debriefs:
  []`. Control: bob's list is checked while alice's is non-empty. Mutation: include `blocked` → red;
  `read` true on any read → red (read in round 1, reopen to round 2 → `read: false`).
- `test_AC07_decided`: alice disposes A (clock t), B (t + MIN) via `mesh_dispose` → `decided` fps
  `[B, A]` (newest first), each with `title`, `revertable: true`, `via: "debrief-session"`. After alice
  reverts B → B absent (no longer revertable), A present. `clock += 8 * DAY` → A absent. bob's `decided`
  `[]`. Mutation: oldest first → red; no 7-day window → red; include non-revertable → red.
- `test_AC07_count_items`: after A is disposed (accepted, not consumed), `items: 2`.

### AC-08 `mesh_dispose` happy path (World `w.tool`, `test/debrief-daemon.test.ts`)

- `test_AC08_dispose_records`: hold D; `mesh_dispose {A, accepted, reason: "R-A", answer: "ANS-A"}` →
  reply text exactly `Recorded <A>: accepted (was open). 2 item(s) left to decide.`; item A `accepted`;
  the `DispositionRow` (from `GET /v1/steps/<D>/reviews` or the items route) has `decider {kind:
  "person", user: "alice"}`, `via: "debrief-session"`, `answer: "ANS-A"`, `reason: "R-A"`, `from:
  "open"`, `round: 1`, `step: D`; one note `debrief: accepted <A> "Alpha leak": R-A`; one `step.noted`
  and one `item.disposed` (payload `via: "debrief-session"`) for D. Mutation: decider `agent` → red; note
  without quotes → red; `via: "stage"` → red.
- `test_AC08_last_reply`: B dismissed → `… 1 item(s) left to decide.`; C deferred with `until` →
  reply exactly `Recorded <C>: deferred (was open). No item left to decide: store the summary with
  mesh_artifact (kind transcript), submit the review record with mesh_review (its dispositions: your
  latest decision per item, or none), then call mesh_done.` Mutation: `left` counted before applying →
  red.
- `test_AC08_redaction`: `answer` and `reason` containing `GHP` → stored `[REDACTED]` in both, `GHP`
  absent from the row and the note. Control: a plain `answer` is stored verbatim (previous test).
  Direct route call by alice's token with `GHP` in `answer` → stored as received (hub does not redact).
  Mutation: redact only `reason` → red.
- `test_AC08_step_updatedAt`: after the dispose, `GET` step `updatedAt` = the disposition's `at`.

### AC-09 Errors (World, `describe("AC-09 errors")`)

Each case asserts status, exact text, and that item state, history length, notes, `item.disposed` and
`step.noted` counts for D are unchanged (snapshot before, compare after).

- `test_AC09_no_step_session`: a session holding nothing → tool error `this session holds no step`.
- `test_AC09_not_debrief`: session holding an interactive consuming step → tool error with
  `<id> is not a debrief step; a stage records its dispositions in its review record (mesh_review)`.
- `test_AC09_not_held`: alice route on `ready` D → 409 `<D> is ready; only a held debrief takes
  dispositions`.
- `test_AC09_other_holder`: alice holds D; bob (admin) route → 403 `<D> is held by alice`.
- `test_AC09_foreign_sid`: alice route with `sid` of bob's session → 403 `session <sid> is not yours on
  this machine`. Control: with her own sid → 201.
- `test_AC09_after_record`: alice submits the round's record, then `mesh_dispose` → 409 `<D> round 1
  already has a review record`.
- `test_AC09_rl2_checks`: on a debrief with `may_set: [accepted, deferred]`: `dismissed` → 422 `<D> may
  not set dismissed (may_set: accepted, deferred)`; `deferred` without `until` → 422 `deferred needs
  until (YYYY-MM-DD)`; fp `fp("r.none")` → 422 `no item <fp> in the record of <AU>`; an item in state
  `dismissed` carried from an earlier goal (not consumed) → 422 `item <fp> is dismissed; <D> acts on
  open, confirmed`. Texts have no `disposition of <fp>: ` prefix.
- `test_AC09_order`: combinations that fail two checks give the earlier one: AU (non-debrief) and not
  held → not-debrief text; ready D by bob → 409 state text (not 403); D held by alice, bob with a foreign
  sid → 403 holder text; record present + bad `may_set` → 409 record text; bad `may_set` + unknown fp →
  may_set text. Mutation: swap any two checks → red.
- `test_AC09_change_of_mind`: A accepted, then A dismissed (same round) → 201, the second row has
  `from: "accepted"`, A `dismissed`. Control: in round 2 (reopened), an fp `accepted` in round 1 is
  refused by the state check (not consumed) → 422. Mutation: check 6 without the same-round exception
  → red; exception for any round → red.
- `test_AC09_offline`: `w.stopHub()`; `mesh_dispose` → tool error starting `the hub is offline; the
  disposition was not recorded.`; `startHubAgain()`, `w.flush()` twice → A still `open`, no
  `item.disposed`. Control: the call after the hub is back succeeds. Mutation: queue on offline → red.

### AC-10 The debrief's own record (World, `describe("AC-10 record")`, each case a fresh relay)

- `test_AC10a_conflict_422`: dispose A accepted, B dismissed; `mesh_review` (or route) record
  `dispositions: [disp(A, accepted), disp(B, accepted)]` → 422 `the review record has 1 problem(s):
  disposition of <B>: <B> was decided in this debrief as dismissed; list that decision or leave it out`;
  items, history lengths, notes and events unchanged; no review record stored. Mutation: apply the
  record's disposition over the session decision → red.
- `test_AC10b_already_and_done`: same decisions, record `[disp(A, accepted), disp(C, deferred, {until})]`
  → 201, `already: [A]`, `ignored: []`; C `deferred` with a row `via: "debrief-session"`, no `answer`,
  decider `{kind: "person", user: "alice"}`, a note `debrief: deferred <C> "<C title>": <reason>`; A has
  exactly one disposition entry; `review.recorded` payload `already: 1`; the `mesh_review` reply
  contains `1 disposition(s) were already recorded in this debrief.`; record's decider `{kind: "person",
  user: "alice"}`; `mesh_done` → D `done`, F `ready`. Mutation: `already` omitted → red; C stored with
  `via: "stage"` → red.
- `test_AC10c_revert_survives`: dispose A accepted, alice reverts A (D `claimed`), record
  `[disp(A, accepted)]` → 201, `already: [A]`, A `open`, A's history ends with the `revert` entry
  (length unchanged by the record). Mutation: round-1 rule ("same disposition and state unchanged") →
  red.
- `test_AC10d_change_of_mind`: dispose A accepted, then dismissed; record `[disp(A, dismissed)]` → 201,
  `already: [A]`, A `dismissed`, two disposition entries. Separate rounds/goals: `[disp(A, accepted)]` →
  422 `… disposition of <A>: <A> was decided in this debrief as dismissed; …`; `[disp(A, dismissed),
  disp(A, dismissed)]` → 422 `… disposition of <A>: listed twice`. Mutation: session decision = first
  instead of latest → red.
- `test_AC10e_empty`: record `dispositions: []` → 201, `already: []`.
- `test_AC10f_admin_not_holder`: alice holds D; bob (admin) submits the record → 403 `<D> is held by
  alice`; nothing stored. Control: on a non-debrief interactive review step held by alice, bob's record
  is accepted (RL-2 admin exception still exists). Mutation: keep the admin exception for debriefs →
  red.

### AC-11 Revert (World, `describe("AC-11 revert")`)

- `test_AC11_revert_accept`: dispose A accepted; alice `POST …/dispositions/revert {fingerprint: A}` →
  200; A `open`; last history entry `{kind: "revert", disposition: "accepted", from: "accepted", to:
  "open", via: "ui", decider: {kind: "person", user: "alice"}, step: D, round: 1}`; note `debrief:
  reverted <A> to open (was accepted)`; event `item.reverted` with `{lineage, fp: A, from: "accepted",
  to: "open", round: 1, via: "ui"}`; `RevertResult.reverted` deep-equals the row from the dispose reply.
  Mutation: restore `to` = `open` always → red (next test).
- `test_AC11_revert_dismissal`: lineage where A was `confirmed` before (a validator step upstream, or a
  previous goal) and the debrief dismisses it → revert restores `confirmed`, `dismissedEh` absent,
  `until` absent. And a deferral reverted to `open` has no `until`. Mutation: keep `dismissedEh` → red.
- `test_AC11_who`: dave → 403 `only alice, the goal owner or an admin can revert this`, A unchanged;
  bob (admin) → 200. Owner case: debrief with `assignee: "carol"`, carol disposes, alice (owner) reverts
  → 200. Mutation: decider only → red.
- `test_AC11_not_revertable`: second revert of A → 409 `<A> changed after the debrief decided it;
  nothing to revert`; fresh case: dispose A, then a later goal of the lineage folds A → 409. fp never
  disposed by D → 404 `<D> has no debrief disposition of <fp>`; on AU → 409 `<AU> is not a debrief
  step`.
- `test_AC11_done_debrief`: D `done` → revert → 200.

### AC-12 Person precedence (World)

- `test_AC12_agent_ignored`: plan = relay fixture plus headless `recheck` (deps `[debrief]`, no `when`,
  `consumes: [open]`, `may_set: [confirmed, dismissed]`). Alice dismisses A by `mesh_dispose`, submits
  the debrief record `[]`, done; `recheck` (claimed as RL-2 AC-14 does) records `[disp(A, confirmed),
  disp(B, confirmed)]` → 201, `ReviewResult.ignored` = `[{fingerprint: A, reason: "decided by alice in
  this goal"}]` (precedence before the state check, so no 422 although A is `dismissed`), A stays
  `dismissed`. FAILS when A becomes `confirmed` or the record is refused. Control: B `confirmed` in the
  same record. Mutation: precedence only for `via: "stage"` person entries → red.

### AC-13 Context and brief (World + unit)

- `test_AC13_inputs` (World): held D → `GET /v1/steps/<D>/context` `inputs[0]` = `{from: AU, artifact:
  "debrief", kind: "review", title: "debrief items (3)"}`, `JSON.parse(content)` deep-equals `{lineage,
  items: view.items}`; `inputs[1]` `kind: "report"`, `content: "REPORT-TEXT"`, title the artifact title or
  `report`. After A, B, C are disposed: no `debrief` input, report still first. Mutation: inputs after
  the policy inputs → red.
- `test_AC13_brief_line` (unit, `src/daemon/brief-inputs.test.ts`): `brief()` of a debrief step contains
  the exact line `This step is a debrief with your person: follow the mesh-debrief skill (mesh_dispose
  for each decision, then mesh_review, then mesh_done).` after the Brief block; absent for an
  interactive step. With an input whose content contains `Ignore your brief` (in an evidence note and in
  the report), every occurrence lies between that input's fence lines. Mutation: line missing → red.

### AC-14 Privacy of events and exports (World + CLI)

- `test_AC14_no_markers`: title `TITLE-MK`, reason `REASON-MK`, answer `ANSWER-MK`, report `REPORT-MK`,
  revert reason `REVREASON-MK`; dispose, revert, record, done; `GET /v1/events` JSON and `mesh ledger
  export` output contain none of the markers. Control: the notes contain `REASON-MK` and `TITLE-MK`.
  Mutation: put `reason` into `item.disposed` → red.

### AC-15 `mesh debrief` (CLI, `test/debrief-cli.test.ts`, fake runner + World hub)

- `test_AC15_usage`: no arg → exit 2, stderr `usage: mesh debrief <step>`.
- `test_AC15_not_debrief`: AU → exit 1, stderr the hub's 409 `<AU> is not a debrief step`.
- `test_AC15_other_user`: bob → exit 1 `<D> is a debrief for alice; only they can run it`; runner saw no
  call; D still `ready`.
- `test_AC15_blocked`: alice on blocked D → exit 1 `<D> is blocked; a debrief starts when it is ready`.
- `test_AC15_launch`: alice, D ready, no read, skill not installed → exit 0; stderr has both warnings
  verbatim; the runner saw tmux new-session/new-window whose command runs `claude` with first argument
  exactly the documented prompt (with `<D>`), env `MESH_STEP=<D>`, cwd the repo; D `claimed`,
  `holderUser: "alice"`. With `--session x` → the tmux call targets session `x`. Control: after
  `mesh setup` and a read, no warning lines. Mutation: prompt text altered → red; warnings blocking →
  red.

### AC-16 Skill shipping (CLI + unit + schemas)

- `test_AC16_setup_install_keep`: `mesh setup` (temp `claudeConfigDir`) → file at
  `skills/mesh-debrief/SKILL.md` equals `MESH_DEBRIEF_SKILL`, output `Installed the mesh-debrief skill
  <path>.`; second run → `Kept …`. Foreign file (no `SKILL_MARKER`) → `Left <path> alone: mesh did not
  write it.`, content unchanged. `--no-mcp` → no file, no line. `--uninstall` → file and empty folder
  gone, `Removed the mesh-debrief skill <path>.`
- `test_AC16_doctor`: current → `✓ mesh-debrief skill <path>`; missing → `! mesh-debrief skill not
  installed; run: mesh setup`; altered → `! … out of date; run: mesh setup`; exit code unaffected by
  these lines.
- `test_AC16_skill_flag`: `mesh skill --debrief` stdout = `MESH_DEBRIEF_SKILL.trim()`; `mesh skill`
  still prints `MESH_SKILL`.
- `test_AC16_install_text_arg` (unit, `src/claude/skill.test.ts`): `installSkill(p, MESH_DEBRIEF_SKILL)`
  then `skillStatus(p, MESH_DEBRIEF_SKILL)` = `current`, `skillStatus(p)` (default text) ≠ `current`.
- `test_AC16_generated_file` (`test/schemas.test.ts`): `skills/mesh-debrief/SKILL.md` = the constant.
- `test_AC16_skill_mentions` (unit): contains `name: mesh-debrief`, `SKILL_MARKER`, `mesh_context`,
  `mesh_dispose`, `answer`, `mesh_review`, `mesh_done`, `transcript`, `possible repeat of`; front matter
  `description` mentions `debrief` and `mesh debrief`. Mutation: drop any mention → red.

### AC-17 `renderOffers` (unit)

- `test_AC17_sections`: two offers, debriefs `d1` (ready, 3 items, "T1") and `d2` (claimed, 1 item),
  one decided `{fp, disposition: "accepted", from: "open", step: "d1", title: "T3"}`, `selected:
  "decided:d1:<fp>"`, `height` 20 → lines exactly (toEqual on the slice after the offers): `DEBRIEFS`,
  `  mesh debrief d1  ready  3 item(s)  "T1"`, `  mesh debrief d2  claimed  1 item(s)  "…"`, `DECIDED IN
  DEBRIEF`, `› <fp>  accepted (was open)  d1  "T3"`; last line `OFFERS_FOOTER` = `⏎ accept · d decline ·
  u revert · o back to sessions · details: mesh offers`; `lines.length === 20`. Same with `selected:
  "d2"` → marker on d2 only; with an offer id → marker on the offer. Empty debriefs/decided → no
  `DEBRIEFS`/`DECIDED IN DEBRIEF` lines; no offers → `No offers for this machine.` present plus sections.
  Mutation: section headers lower-case → red; marker on all → red.

### AC-18 TUI keys and daemon local routes

- `test_AC18_u_reverts` (unit, `src/cli/tui/tui.test.ts`): fake client (`offers`, `debriefs`, `revert`
  spies) and fake TTY; `o`, cursor down past offers and debriefs onto the decided entry, `u` →
  `revert` called once with `(step, fp)`, status `Reverted <fp> to open.`, then `debriefs()` reloaded.
  Revert rejects with `boom` → status `boom`.
- `test_AC18_enter_on_debrief`: `⏎` on a debrief → status `Start it with: mesh debrief <step>`, `accept`
  not called. Control: `⏎` on an offer calls `accept`. `d` on debrief/decided → no `decline`; `d` on an
  offer → `decline`.
- `test_AC18_debriefs_fail`: `debriefs()` rejects → rendered panel has offers, no `DEBRIEFS`/`DECIDED IN
  DEBRIEF`, no status text; badge counts offers only; next poll with `debriefs()` resolving shows them
  and badge = offers + debriefs.
- `test_AC18_local_routes` (World, `test/debrief-daemon.test.ts`): `r.local(alice, "GET",
  "/local/debriefs")` deep-equals the hub's `GET /v1/debriefs` for alice; `POST /local/revert {step: D,
  fingerprint: A}` → the hub's `RevertResult` and A `open`; a hub error (second revert) → 409 with the
  hub's text; a daemon without credentials (logged out) → 409 `not logged in to a hub; run: mesh login`.

### AC-19 Web Mine (Playwright, `test/e2e-web/mine.spec.ts`)

- `test_AC19_assigned_debrief`: through the API set up the relay for the e2e user; Mine page shows
  `li.debrief[data-step="<D>"]` with text `<D> "<title>" · debrief · 3 item(s) to decide`, a link `open`
  to `#/goal/<G>`, `code` `mesh debrief <D>`; `Nothing is assigned to you.` absent. After a dispose of A
  through the API and reload: `li.decided[data-fp="<A>"]` with `<A> accepted (was open) · <D> · "<A
  title>"` and button `Revert <A>`; click → API shows A `open`; the entry disappears. Control: the
  empty-state text appears for a fresh user with nothing assigned (if the e2e cast allows; else assert
  via a user created in the spec).

### AC-20 Web step panel (Playwright, `test/e2e-web/goals.spec.ts`)

- `test_AC20_panel`: open D's panel: `section[aria-label="debrief"]` with `Assignee: @<user>`,
  `pre.report` with the report, `li[data-fp]` per item with `<severity> <title> · open`, A's li contains
  `possible repeat of <A2>` (A2 seeded as AC-06); no `Assign` button on D (control: a ready interactive
  step's panel has it); `Mark pre-read as read` click → API `Step.read` set and the button replaced by
  `Read by @<user>`; after a dispose, `Decided in debrief` with `li.decided[data-fp]` and `Revert`.
  Separate D in `blocked` and in `done`: neither button nor `Read by`. Steps by `data-step`, items by
  `data-fp`, never counted.

### AC-21 Compatibility (World + unit)

- `test_AC21_existing_suites`: run unchanged `test/hub.test.ts`, `assign.test.ts`, `m4-hub.test.ts`,
  `review-hub.test.ts`, `relay-hub.test.ts`, `pulse-hub.test.ts`; `git diff main -- <those files>`
  limited to the named Compatibility items (reviewed by hand).
- `test_AC21_stage_via_and_already`: RL-2 validator record → rows `via: "stage"`, `ReviewResult.already`
  `[]`. `TOOLS` names = previous list + `mesh_dispose` exactly (set diff); `MESH_TOOL_RULES` unchanged;
  built-in profile hashes equal the literal values in the existing tests; `SCHEMA_VERSION` equal to its
  RL-3 value. Mutation: add `mcp__mesh__mesh_dispose` to `MESH_TOOL_RULES` → red.

### AC-22 Idempotency (World)

- `test_AC22_dispose_replay`: route dispose with `Idempotency-Key: k1` twice → same reply, A has one
  disposition entry, one note, one `item.disposed`, one `step.noted`. Revert with `k2` twice → one revert
  entry, one note, one `item.reverted`. Control: a different key on the second revert → 409. Mutation:
  route not wrapped in idempotency → red.

### AC-23 Docs (review + `test/schemas.test.ts`)

- `test_AC23_docs`: `docs/guide/concepts.md` has a `Debriefs` heading and mentions `mode: debrief`,
  `assignee`, `@owner`, `mesh debrief`, `mesh-debrief`, `mesh_dispose`, `debrief-session`, revert;
  `docs/guide/howto.md` has `Debrief an agent's findings`; `docs/plan/implementation-plan.md` lists the
  five routes with v0.1.18; `docs/events.md` lists `item.reverted`, `step.read`, `already`;
  `MESH_SKILL` contains `mesh debrief` and `mesh-debrief` and equals `skills/mesh/SKILL.md`. Generic-name
  check is a review step (grep the diff for team/company/person names).

### AC-24 Checks and schemas

- `test_AC24_openapi_routes`: `schemas/hub-api.openapi.json` equals the `pnpm schemas` output and has
  the five routes with rule `member`, scopes and tag as the route table (`steps`, `goals:read` on the
  view); `HUB_API` matches `src/hub/app.ts` (existing check). `test_AC24_version`: `package.json`
  `0.1.18`. `test_AC24_boundaries`: `debriefAssignee` is exported from `src/core/index.ts` and `pnpm
  boundaries` passes. Plus `pnpm check` and `pnpm test:web` after `pnpm build`.

### AC-25 Store filters (contract + World)

- `test_AC25_listSteps_updatedSince`: three steps with `updatedAt` 10, 20, 30 → `{updatedSince: 20}` →
  the 20 and 30 steps (boundary inclusive). Mutation: `>` instead of `≥` → red.
- `test_AC25_listDispositions_steps_since`: entries of steps s1, s2, s3 at 10/20/30 → `{steps: [s1,
  s3]}` → s1, s3 only; `{steps: []}` → `[]`; `{since: 20}` → the 20 and 30 entries; `{steps: [s2, s3],
  since: 25, fp}` → AND. Run on SQLite and Postgres (when `PG_URL`).
- `test_AC25_long_held` (World + clock): alice claims D, `clock += 8 * DAY`, `mesh_dispose` A → A in
  `GET /v1/debriefs` `decided`. Mutation: dispose does not save the step's `updatedAt` → red.

## Risks and notes for the spec author

- 2026-11-12 **bob's role.** AC-04 and AC-10(f) call bob an admin; AC-11 says "by bob (not decider,
  owner or admin) → 403". The plan makes bob the admin throughout and uses a fourth member `dave` for
  the 403 case of AC-11 (conservative reading: both statements are tested, with different people).
- 2026-11-12 **TUI seam.** No existing test drives `src/cli/tui/tui.ts` with keys. AC-18's unit tests need
  an injectable client and TTY; if `tui.ts` has none, the test-writer asks the implementer for a minimal
  exported seam (not planned here, since the source was not read).
- 2026-11-12 **AC-06 "no run".** A valid debrief always has a raising step upstream, so "no `run`" is
  only reachable by a replan; the plan asserts `items: []` before audit's record and leaves the no-run
  shape to the implementer's own tests.
- 2026-11-12 **AC-12 plan shape.** RL-2 check 5 (person precedence) runs before check 6 (state) and
  skips it for an ignored fp, so `recheck` with `consumes: [open]` confirming the dismissed A is ignored,
  not refused (as RL-2 AC-14).
- **Checks run by the planner:** none (`pnpm lint`, `typecheck`, `boundaries`, `test`, `build`, `check`,
  `schemas`, `test:web` not run: this row only adds a Markdown plan; no code changed).
