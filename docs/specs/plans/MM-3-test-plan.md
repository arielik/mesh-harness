# Test plan MM-3: Assign (offers, accept policy, auto-accept delivery, Assigned to you, report back)

Spec: `docs/specs/MM-3.md` (revision 3, approved in `docs/specs/reviews/MM-3/`, round 3).

Inputs read: `docs/specs/MM-3.md` (interface contracts, acceptance criteria, open questions); the
design `docs/analysis/2026-11-11-my-mesh-and-assign.md`; the format of
`docs/specs/plans/MM-2-test-plan.md`; the role file `assets/sdd/.claude/agents/test-planner.md`; the
file names of existing tests under `test/`, `test/e2e-web/` and `src/**/*.test.ts`; the public fields
and method signatures of the test helper `test/helpers/world.ts` (`World.hub`, `hubConfig`, `hubStore`,
`clock`, `people`, `machines`, `start`, `stopHub`, `startHubAgain`, `login`, `person`, `restart`,
`stop`, `hook`, `tool`, `session`, `turn`, `flush`, `machineOf`, `syncBodies`, `api`, `call`; the
`Person` and `PersonOptions` types) and the names of the local helpers in `test/m46-replicas.test.ts`
(`makeConfig`, `call`, two hubs on one store).
Not read: `docs/specs/plans/MM-3-impl-plan.md` (the implementation plan); any implementation source of
this row or of the code it changes (protocol, hub, store, daemon, CLI, TUI, web, `src/core`).

Planned black-box from the contracts. Every negative assertion has a positive control in the same
test or a named sibling, so a test cannot pass because nothing happened. Each criterion names at
least one mutation of the implementation that must turn one of its tests red; the implementer or
reviewer applies it once by hand, confirms red, and reverts.

Rules from the spec's AC preamble that every test follows: steps are found by step id, messages by
`kind` + step id (in `data.step` or in the text), events by `type` + `step`, machines by id; never by
list position, hostname, or an order the spec does not state. Only AC-34 asserts the package version.

## Surfaces and files

| Surface | File | New or extended |
|---|---|---|
| unit, protocol (`parseAccept`, `AcceptRule`, `AcceptPolicy`, `ACCEPT_RULE_TEXT`, `DaemonConfig`, `Session.accept`, offer types) | `src/protocol/config.test.ts` | extended (`describe("accept")`) |
| unit, protocol (`StepOffer`, `Step.offer`, `Goal.stick`, `OfferState`, `AssignRequest`, `DeclineRequest`, `TOOLS`) | `src/protocol/offers.test.ts` | new |
| unit, core (`acceptMatches`, `pickSession`, `offerText`, `offerLine`) | `src/core/offers.test.ts` | new |
| unit, hub config (`thresholds.offer_expiry`) | `src/hub/config.test.ts` (new if absent) | new or extended |
| unit, hub link (`sessionMetadata`, sync body) | `src/daemon/hub-link.test.ts`, `src/daemon/inventory.test.ts` | extended |
| daemon local API (real `Daemon`, temp store, fake hub `fetch`) | `src/daemon/daemon.test.ts` | extended (`describe("offers")`) |
| store contract (SQLite always, Postgres when its URL is set) | `src/store/hub-store.contract.test.ts` | extended |
| unit, render | `src/cli/show.test.ts` (renderGoal), `src/cli/tui/render.test.ts` (TUI) | extended |
| World (real hub + daemons over HTTP), CLI and MCP against it | `test/assign.test.ts` | new |
| World, two hubs on one store | `test/assign-concurrency.test.ts` | new |
| CLI usage / help / setup (no hub needed) | `test/cli.test.ts` | extended |
| CLI with fake runner (`mesh accept --launch`) | `test/m45-cli.test.ts` | extended |
| schemas, route table, skill, docs, version | `test/schemas.test.ts` | extended |
| Playwright | `test/e2e-web/mine.spec.ts`, `test/e2e-web/goals.spec.ts` | extended (`pnpm test:web`, not part of `pnpm check`) |

### World extensions (test side, allowed by the spec's AC preamble)

- `w.restart(p, {accept, assignments})`: `restart` also accepts `accept` and `assignments` in `change`.
- `PersonOptions.launchStep`: a fake recorded in `p.launches: {repo, step}[]`, returning `{ok: true}`
  unless the test sets `p.launchResult`.
- `p.acks`: every `POST /v1/inbox/.../ack` body the daemon sends (recorded by the person's `fetch`
  wrapper: message id, status, method). Used for "acked `delivered`/`accepted`".
- `p.dropReplyOnce(pathRegex)`: the person's `fetch` wrapper performs the request against the hub,
  then throws a network error instead of returning the first matching reply (AC-39). It also records
  each request's headers in `p.requests` (method, path, `Idempotency-Key`).
- `w.tick()`: runs the hub service tick once with `now = w.clock` (the same entry point the hub's
  interval uses).
- `w.config({offerExpiryMs})`: start option for the hub thresholds (default 30 min = 1 800 000).
- `seedGoal(w, owner, {topics?, team?})`: creates a goal through the public goal API; its design step
  `<G>.design` is `ready`. `approvePlan(w, G, steps)`: submits and approves a plan whose steps are
  given as `{id, deps, gate?, repo}` so the test controls which steps become ready.
- `events(w, type, step)`: events from the hub's event list filtered by `type` and `step`.
- `inboxOf(w, p)`: `GET /v1/inbox` with `p`'s token (the machine's inbox); `offerMsg(w, p, step)` is
  the row with `kind: "offer"` and `data.step === step`.
- `reportOf(w, p, sid, kind, step)`: rows in `p`'s machine inbox with `toSid === sid`, that `kind`, and
  the step id in `data.step` or the text.

Common cast (all in `test/assign.test.ts` unless noted): users `alice` (goal owner), `bob`, `carol`,
`dave` (plain member), `root` (admin). Machines: alice `A1` (nickname `a1`) and `A2` (nickname `m1`);
bob `B` (nickname `m2`) and `B2` (nickname `b2`); carol `C` (nickname `m2` as well, to test that
`m2` resolves to the caller's own machine first); every daemon shares `me` unless stated. Bob's
session on B named `perf-bench`, labels `["perf"]`, in the goal's repo. A service token from the hub
config for the service-token cases.

Shared constants (copied from the spec, not imported, so a changed text turns tests red):
- `RULE = "an accept rule is self, off, user:<id> or machine:<nickname or id>"`
- `OFF_ALONE = "off cannot be combined with other rules"`
- `NOT_YOURS = (sid) => \`session ${sid} is not yours on this machine\``
- `OFFERED_TO = (id, name) => \`${id} is offered to ${name}\``
- `NOT_THIS = (id, name) => \`${id} is offered to ${name}, not to this machine\``
- `NO_OPEN = (id) => \`${id} has no open offer\``
- `OFFERS_FOOTER = "⏎ accept · d decline · o back to sessions · details: mesh offers"`
- `SESSIONS_FOOTER = "⏎ jump · s say · a autopilot · L labels · n next step · o offers · g goals · m machines · r refresh · ↑↓ move · q quit"`

---

## AC-01 `parseAccept`, `AcceptRule`, `AcceptPolicy`, config and session fields

File `src/protocol/config.test.ts`, `describe("accept")`.

| Test | Setup / stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC01_parse_split_trim_dedupe_keep_order` | `parseAccept("self, user:bob,self")` | `toStrictEqual({accept: ["self","user:bob"]})` | not trimmed, repeat kept, re-ordered (e.g. sorted), extra keys |
| `test_AC01_parse_array_input` | `parseAccept(["user:bob","self"])` | `{accept: ["user:bob","self"]}` (order kept) | array refused or sorted |
| `test_AC01_parse_off` | `parseAccept("off")` | `{accept: ["off"]}` | error |
| `test_AC01_parse_off_combined` | `parseAccept("off,self")`, `parseAccept("self,off")` | each `{error: OFF_ALONE}` | accepted, or other text |
| `test_AC01_parse_empty` | `""`, `" , "`, `[]` | each `{error: "give at least one rule, or off"}` | `{accept: []}` |
| `test_AC01_parse_bad_rule_text` | `parseAccept("bob")`; `parseAccept("self,user:,bob")` | `{error: "not an accept rule: bob (" + RULE + ")"}`; second names `user:` (the first bad item) | other text, or names `bob` |
| `test_AC01_parse_21_rules` | 20 distinct `user:u01…u20`; 21 distinct; 20 distinct + a repeat of `user:u01` | 20 → ok; 21 → `{error: "at most 20 accept rules"}`; 20 + repeat → ok (repeats removed before counting) | limit off by one, repeats counted |
| `test_AC01_rule_regex_edges` | `AcceptRule.safeParse` of `self`, `off`, `user:x`, `machine:m-0a1b`, `user:` + 100 chars, `user:` + 101 chars, `user:a b`, `user:a,b`, `SELF`, `machine:` | the first five succeed; the rest fail with message `RULE` | 101 chars accepted, whitespace/comma accepted, uppercase accepted |
| `test_AC01_policy_schema` | `AcceptPolicy.safeParse` of `[]`, `["off","self"]`, 21 rules, `["self"]` | only `["self"]` succeeds; `["off","self"]` fails with `OFF_ALONE` | empty or `off`+other accepted |
| `test_AC01_rule_text_const` | `ACCEPT_RULE_TEXT` | `=== RULE` | differs |
| `test_AC01_daemon_config_defaults` | `DaemonConfig.parse` of the MM-2 `daemon.json` fixture (no `accept`, no `assignments`) | `accept` `toStrictEqual(["self"])`, `assignments === "deliver"`; every MM-2 field equal to its previous parse | defaults missing or another field changed |
| `test_AC01_daemon_config_values` | `{…, accept: ["user:bob"], assignments: "launch"}`; `assignments: "x"`; `accept: ["off","self"]` | first keeps both; the other two fail | invalid values accepted |
| `test_AC01_session_accept_field` | `Session.parse({...minimalSession, accept: ["user:x"]})`; `safeParse` with `["off","self"]`, `[]`; minimal session | first ok; the two others fail; minimal has no `accept` key | invalid accepted, or a default added |

Positive control: `test_AC01_parse_21_rules` (20 ok), `test_AC01_parse_off` and
`test_AC01_rule_regex_edges` (five accepted) prove the refusals are about the rule, not a parser that
refuses all.
Mutation: sort the parsed list → `test_AC01_parse_split_trim_dedupe_keep_order` red; count before
de-duplication → `test_AC01_parse_21_rules` red; drop the `off`-alone refinement →
`test_AC01_policy_schema` and `test_AC01_parse_off_combined` red; `.default(["self"])` removed →
`test_AC01_daemon_config_defaults` red; `{1,101}` in the regex → `test_AC01_rule_regex_edges` red.

---

## AC-02 `acceptMatches`

File `src/core/offers.test.ts`. Fixtures: `T = {userId: "alice"}`; machines
`mA2 = {id: "m-0a1b2c3d", userId: "alice", nickname: "m1"}`, `mBob = {id: "m-bbbb0001", userId: "bob", nickname: "m1"}`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC02_undefined_false` | `acceptMatches(undefined, {byUser: "alice"}, T)` | `false` | true (undefined treated as default `self`) |
| `test_AC02_off_false` | `["off"]`, offer by alice | `false` | true |
| `test_AC02_self` | `["self"]`; by alice; by bob | true; false | either differs |
| `test_AC02_user_rule` | `["user:bob"]`; by bob; by carol; by alice | true; false; false | `user:` matches the target or anyone |
| `test_AC02_machine_id` | `["machine:m-0a1b2c3d"]`; by alice from `mA2`; by alice from `mBob`; by alice, no `byMachine` | true; false; false | id rule ignores the machine or matches missing machine |
| `test_AC02_machine_nickname_own_only` | `["machine:m1"]`; by bob from `mA2` (alice's `m1`); by bob from `mBob` (bob's `m1`) | true; false | another user's machine of that nickname matches |
| `test_AC02_any_rule_matches` | `["user:carol","self"]` by alice | true | only the first rule checked |
| `test_AC02_machine_id_other_owner` | `["machine:m-bbbb0001"]` (bob's id) by bob from `mBob`, target alice | true (an id rule names any machine) | id rule restricted to the target owner's machines |

Positive control: each `false` sits next to a `true` of the same rule in the same test.
Mutation: treat `undefined` as `["self"]` → `test_AC02_undefined_false` red; drop the
`byMachine.userId === target.userId` check → `test_AC02_machine_nickname_own_only` red; compare
`user:<id>` to `target.userId` → `test_AC02_user_rule` red.

---

## AC-03 `pickSession`

File `src/core/offers.test.ts`. Fixture `s(sid, {state, step?, launching?, repo, labels?, lastEventAt})`
with `repo` a repo id such that `repoMatches(r, R)` holds for `R`; `X` another repo.

| Test | Setup / stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC03_sid_working_returned` | `[s("aaaa1",{state:"working",repo:X})]`, `want {repo: R, topics: [], sid: "aaaa1"}` | that session (even other repo, working) | `undefined` |
| `test_AC03_sid_ended_undefined_no_fallback` | named session `ended`, plus an idle step-less session in `R` | `undefined` | the idle one returned |
| `test_AC03_sid_holds_step_undefined` | named session with `step`, plus an idle candidate | `undefined` | fallback |
| `test_AC03_sid_launching_undefined` | named session `launching` | `undefined` | returned |
| `test_AC03_sid_unknown_undefined` | `sid` not in list, idle candidate present | `undefined` | fallback |
| `test_AC03_filters` | sessions: working in R; idle with step in R; idle launching in R; idle in X; idle in R (`ok`) | `ok` | any other picked |
| `test_AC03_label_overlap` | two idle in R: `p1` labels `["perf"]`, `p2` labels `["perf","dataplane"]`, topics `["perf","dataplane"]`; `p1` newer | `p2` | newest wins over overlap |
| `test_AC03_tie_lastEventAt` | equal overlap, `lastEventAt` 10 vs 20 | the one with 20 | older chosen |
| `test_AC03_tie_sid` | equal overlap and time, sids `"b…"`, `"B…"`, `"a…"` | the code-point-smallest (`"B…"`) | locale compare or larger sid |
| `test_AC03_none` | no candidate; empty list | `undefined` both | throws or returns another |

Positive control: `test_AC03_filters` returns a session, so `undefined` results elsewhere are not a
function that always returns `undefined`.
Mutation: on a bad named sid fall through to the unnamed pick → `test_AC03_sid_ended_undefined_no_fallback`
red; drop the `launching` filter → `test_AC03_filters` red; reverse the tie on `lastEventAt` →
`test_AC03_tie_lastEventAt` red; `localeCompare` for sids → `test_AC03_tie_sid` red.

---

## AC-04 `offerText` and `offerLine`

File `src/core/offers.test.ts`.

| Test | Stimulus | Expected (exact) | Fails when |
|---|---|---|---|
| `test_AC04_text_offered` | `{to:"m2/perf", state:"offered", by:"alice", at:1}` | `offered to m2/perf by @alice` | any char |
| `test_AC04_text_accepted_with_accepted` | `state:"accepted", accepted:"m2/perf-bench"` | `offered to m2/perf → accepted by m2/perf-bench` | |
| `test_AC04_text_accepted_without_accepted` | `state:"accepted"`, no `accepted`, `to:"m2"` | `offered to m2 → accepted by m2` | |
| `test_AC04_text_declined` | without note; with `note:"busy"` | `offered to m2 → declined`; `offered to m2 → declined: busy` | |
| `test_AC04_text_expired_withdrawn` | `expired`; `withdrawn` (each with a note too) | `offered to m2 → expired`; `offered to m2 → withdrawn` (note not shown) | note leaks into these |
| `test_AC04_line_auto_no_note` | `OfferView{step:"G1.api", title:"API", repo:"svc", by:"alice", to:"m2", auto:true, expiresAt: now+30*60_000}` | `` `G1.api "API" · svc · from @alice · to m2 · auto · expires in ${age(30*60_000)}` `` | |
| `test_AC04_line_manual_note_empty_repo` | `repo:""`, `auto:false`, `note:"pls"` | `` `G1.api "API" · - · from @alice · to m2 · manual · expires in ${age(…)} · pls` `` | `-` missing, note missing |

`age` is imported from `src/core/fleet.ts` (its own tests pin its format).
Positive control: the note variants contain the note; the plain variants do not.
Mutation: always append `: <note>` → `test_AC04_text_expired_withdrawn` red; `→` replaced by `->` →
every `test_AC04_text_*` red; `o.repo` without `|| "-"` → `test_AC04_line_manual_note_empty_repo` red.

---

## AC-05 Sync body and session metadata carry `accept`; the hub stores it

Files `src/daemon/hub-link.test.ts`, `src/daemon/inventory.test.ts`, `test/assign.test.ts`.

| Test | Setup / stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC05_metadata_copies_accept` | `sessionMetadata` of a session with `accept: ["user:bob"]`, `pid`, `pane` | `accept` `toStrictEqual(["user:bob"])`; private fields absent as in MM-2 | dropped |
| `test_AC05_metadata_no_accept_no_key` | same without `accept` | `Object.hasOwn(m, "accept") === false` | key present |
| `test_AC05_inventory_exact_body` (inventory.test, updated as the spec's Compatibility says) | the MM-1 exact-body comparison | `machine` `toStrictEqual({share, accept: ["self"], repos: …})` | `accept` missing |
| `test_AC05_sync_body_default` | World, bob with default config; `w.flush()` | the last of `w.syncBodies(bob)` has `machine.accept` `["self"]` | missing |
| `test_AC05_sync_body_config` | `w.restart(bob, {accept: ["user:alice"]})`; flush | `machine.accept` `["user:alice"]` on every later sync body | stale default |
| `test_AC05_fleet_shows_accept` | bob after flush: `GET /v1/fleet` (bob) | machine with id `w.machineOf(bob)` has `accept: ["user:alice"]` | missing |
| `test_AC05_sync_without_accept_keeps` | `POST /v1/sync` with bob's token and a body whose `machine` has `share` only | `/v1/fleet` still `["user:alice"]` | overwritten or removed |
| `test_AC05_never_reported_absent` | a machine logged in with `w.login` but never synced, and a machine whose syncs never carried `accept` (raw `POST /v1/sync`) | `/v1/fleet` machine has no `accept` key | `accept: []` or `["self"]` |
| `test_AC05_session_override_in_fleet` | bob's session with `accept` set via `POST /local/session-accept`; flush | `/v1/fleet` session has `accept`; another session has no key; `/v1/live` session has no `accept` key | missing, or leaks into `LiveSession` |

Positive control: `test_AC05_fleet_shows_accept` before `test_AC05_sync_without_accept_keeps` (same
test body) proves the stored value exists before the keep-check.
Mutation: on sync, write `machine.accept ?? undefined` over the stored value →
`test_AC05_sync_without_accept_keeps` red; send `accept` only when not default →
`test_AC05_sync_body_default` red.

---

## AC-06 Store contract: `MachineRow.accept`

File `src/store/hub-store.contract.test.ts` (SQLite always, Postgres when its URL is set).

| Test | Setup / stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC06_schema_version_6` | `SCHEMA_VERSION` (and the migrated store's version) | `6` | changed |
| `test_AC06_touch_with_accept_keeps_others` | machine with `repos`, `reposAt`, `labels`, `share`, `nickname`; `touchMachine(…, {accept: ["self"]})` | row has `accept: ["self"]` and every other field equal to before | any lost |
| `test_AC06_touch_repos_only_keeps_accept` | then `touchMachine` with `repos` only | `accept` still `["self"]`; repos updated | accept lost |
| `test_AC06_set_labels_keeps_accept` | `setMachineLabels` | `accept` kept | lost |
| `test_AC06_nickname_keeps_accept` | set the nickname (MM-1 store call) | `accept` kept | lost |
| `test_AC06_no_accept_no_key` | a row never given `accept` | `toStrictEqual` the MM-2 shape (no `accept` key) | `accept: null`/`[]` key |
| `test_AC06_machine_wide_message` | `addMessage({toMachine: M, toSid: "", kind: "offer", …})`; `inbox(M)` | the row is listed with `toSid: ""` | dropped or `toSid` null |

Positive control: `test_AC06_touch_with_accept_keeps_others` reads `accept` back, so the "kept" tests
are checking a value that was really stored.
Mutation: replace the machine JSON instead of merging in `touchMachine` →
`test_AC06_touch_repos_only_keeps_accept` red; store `accept ?? []` →
`test_AC06_no_accept_no_key` red.

---

## AC-07 `POST /v1/steps/:id/assign`: success and errors

File `test/assign.test.ts`, `describe("assign")`. Alice's goal `G` (design step ready), alice's
session on A1 with sid `sa`.

| Test | Setup / stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC07_assign_to_other_user_machine` | alice: `POST /v1/steps/G.design/assign {to: "bob/m2", sid: sa}` (A1 token) | 200; `auto` boolean; `step.state "ready"`; `step.offer` has `to.machine === machineOf(B)`, no `to.sid`, `by "alice"`, `bySid sa`, `byMachine machineOf(A1)`, `at === w.clock`, `state "offered"`, `auto` equal to the top-level `auto`; one `step.offered` event for `G.design` with payload `machine === machineOf(B)` and `auto` | any field, a second event, step not ready |
| `test_AC07_assign_to_own_nickname` | another goal `H`; `to: "m1"` | 200; `to.machine === machineOf(A2)` | |
| `test_AC07_no_step_404` | `G.nope` | 404 `{error: "no step G.nope"}` | |
| `test_AC07_gate_409` | a gate step made ready by `approvePlan` | 409 `<id> is a gate: a person decides it` | |
| `test_AC07_not_ready_409` | a step blocked by deps | 409 `<id> is blocked, not ready` (state from the plan) | |
| `test_AC07_already_offered_409` | assign twice (second to `m1`) | 409 `G.design is already offered to m2; withdraw it first (mesh withdraw G.design)` (machine name of B = `m2`); offer unchanged | second offer replaces the first |
| `test_AC07_no_machine_404` | `to: "x"` | 404 `no machine x`; step has no offer; no event | |
| `test_AC07_no_session_404` | `to: "bob/m2/nosuch"` | 404 `no session nosuch on m2` | |
| `test_AC07_me_session_of_other_user_404` | bob's session `secret` on B2 under `shareSessions: me` (visible only to bob); alice `to: "bob/b2/secret"` | 404 `no session secret on b2`; positive control: bob himself assigning a step of a team goal to `b2/secret` gets 200 | 200 for alice (session leak) |
| `test_AC07_ambiguous_prefix_409` | two sessions on B whose sids share the 4-char prefix `p`; `to: "bob/m2/<p>"` | 409 `"<p>" matches several sessions on m2` | |
| `test_AC07_service_token_403` | service token | 403 (body text not pinned: see Open questions) | 200 |

Positive control: `test_AC07_assign_to_other_user_machine` and `test_AC07_assign_to_own_nickname`
succeed; each error test asserts afterwards that `GET /v1/steps/<id>` has no new offer and no new
`step.offered`, and then repeats a valid assign that succeeds (proving the step was offerable).
Mutation: skip the open-offer check → `test_AC07_already_offered_409` red; resolve sessions without
`sessionVisible` → `test_AC07_me_session_of_other_user_404` red; set `byMachine` from the body `sid`'s
machine instead of the token → `test_AC07_assign_to_other_user_machine` red (with `sa` on A1 this is the
same; the stronger mutation check is AC-35).

---

## AC-08 Target resolution

File `test/assign.test.ts`, `describe("target")`. Alice has A2 `m1`; bob has B `m2`; carol has C `m2`.
Bob's session `perf` on B (name `perf`), another session `perf-bench`. Each test offers a fresh ready
step and checks `step.offer.to`.

| Test | `to` (caller) | Expected `to` | Fails when |
|---|---|---|---|
| `test_AC08_own_nickname_first` | `m2` (carol) | `{machine: C}` (carol's own `m2`, not bob's) | bob's B chosen |
| `test_AC08_machine_id` | `<id of B>` (alice) | `{machine: B}` | 404 |
| `test_AC08_user_slash_nickname` | `bob/m2` (alice) | `{machine: B}`, no `sid` | `bob` read as a machine with session `m2` |
| `test_AC08_session_by_name` | `m2/perf` (bob) | `{machine: B, sid: <perf sid>}` | name `perf-bench` chosen, or no sid |
| `test_AC08_session_by_prefix` | `m2/<first 6 chars of perf-bench sid>` (bob) | that sid | |
| `test_AC08_prefix_too_short` | `m2/<first 3 chars>` (bob) | 404 `no session <3 chars> on m2` | 3-char prefix accepted |
| `test_AC08_user_nick_session` | `bob/m2/perf` (alice; `perf` shares `all` or holds a step so alice may see it) | `{machine: B, sid: <perf sid>}` | |
| `test_AC08_own_machine_no_session` | `m2/x` (bob) | 404 `no session x on m2` (not `no machine m2/x`) | fell through to `<user>/<nickname>` |
| `test_AC08_ended_session_excluded` | `m2/<sid of an ended session>` | 404 | ended session resolved |

Positive control: every 404 test sits beside a 200 on the same machine.
Mutation: search all users' nicknames before the caller's → `test_AC08_own_nickname_first` red; accept
prefixes of any length → `test_AC08_prefix_too_short` red; resolve name before exact sid where a
session is named like another's sid → covered by `test_AC08_session_by_name` (name `perf` vs.
`perf-bench`: exact match, not prefix).

---

## AC-09 Accept policy at offer time

File `test/assign.test.ts`, `describe("policy")`. Each case: a fresh ready step, then read `auto`
from the reply and from `step.offer.auto`.

| Test | Setup | Offer | Expected `auto` | Fails when |
|---|---|---|---|---|
| `test_AC09_self_default_own` | A2 default policy | alice (A1) → `m1` | true | false |
| `test_AC09_self_other_user` | A2 default `["self"]`; a team goal so bob may assign | bob → `alice/m1` | false | true |
| `test_AC09_user_rule` | `w.restart(A2, {accept: ["user:bob"]})`, flush | bob → `alice/m1` | true | |
| `test_AC09_machine_rule_from_that_machine_only` | A2 `["machine:<id of B>"]` | bob from B (B token) → true; bob from B2 (B2 token) → false | either differs |
| `test_AC09_off` | A2 `["off"]` | alice → `m1` | false | |
| `test_AC09_session_override` | A2 `["self"]`; session `s` on A2 with override `["user:bob"]` (via `/local/session-accept`, flush) | bob → `alice/m1/s` → true; bob → `alice/m1` (no session) → false | override ignored or applied machine-wide |
| `test_AC09_never_reported` | alice's third machine logged in, never synced | alice → its id | false (even for `self`) | |

Positive control: every false case has a true sibling with the same users.
Mutation: evaluate the machine policy even when a named session has an override →
`test_AC09_session_override` red; default an unreported policy to `["self"]` →
`test_AC09_never_reported` red; take `byMachine` from the goal owner → `test_AC09_machine_rule_from_that_machine_only` red.

---

## AC-10 Machine-wide message

File `test/assign.test.ts`. Goal `G` with topics `["perf","dataplane"]`, repo `svc`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC10_row_on_target` | alice → `bob/m2` with note `pls` | `offerMsg(w, B, "G.design")`: `toSid === ""`, `kind "offer"`, `fromUser "alice"`, text `MESH: @alice offers step G.design "<title>" (repo svc) to this machine: pls`, `data` `toStrictEqual({step, goal: "G", repo: "svc", topics: ["perf","dataplane"] (goal order), auto, by: "alice", note: "pls"})` | any field, or extra keys |
| `test_AC10_named_session_sid` | alice → `bob/m2/perf` (visible) without note | `data.sid === <perf sid>`; no `note` key; text without `: …` | sid missing |
| `test_AC10_not_on_other_machines` | same | no `kind:"offer"` row for `G.design` in the inboxes of B2, A1, A2, C | row duplicated |
| `test_AC10_one_row_per_offer` | after one assign | exactly one row for `G.design` on B | two rows |

Note: to read B's inbox before B's daemon handles the row, B is a machine with `assignments` left at
`deliver`, `auto: false` (bob's policy `["self"]`, offerer alice) and its daemon offline
(`p.offline = true`) so it neither acks nor removes it; positive control: after `offline = false`
and a flush, B's notes have the notification (AC-21), proving the same row is the one the daemon handles.
Mutation: address the row to the offerer's machine → `test_AC10_row_on_target` and
`test_AC10_not_on_other_machines` red; omit `topics` → `test_AC10_row_on_target` red.

---

## AC-11 Claim guard

File `test/assign.test.ts`, `describe("claim guard")`. Alice offers `G.design` to `bob/m2` with
`sid: sa` from A1.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC11_third_user_409` | carol claims from C with her own session sid | 409 `OFFERED_TO("G.design","m2")`; offer still `offered`; step still `ready` | 200 |
| `test_AC11_target_machine_claim_is_accept` | then bob's session on B claims (`POST /v1/steps/G.design/claim {sid}` with B token) | 200; holder = that sid; `offer.state "accepted"`, `decidedAt === w.clock`; one `step.accepted` (payload `machine` B, `sid`); a `step.claimed`; report `offer_accepted` for `sa` | offer still `offered`, no `step.accepted` |
| `test_AC11_offerer_other_machine_withdraws` | new step offered to `bob/m2`; alice claims from A2 | 200; held by alice's A2 session; `offer.state "withdrawn"`; one `step.offer_withdrawn` with payload `reason: "claimed by the offerer"`; no `step.accepted` | 409, or offer `accepted` |
| `test_AC11_no_offer_unchanged` | a step without an offer claimed by carol | 200 as before | guarded |

Positive control: `test_AC11_third_user_409` is followed in the same test by bob's successful claim,
so the 409 is due to the guard.
Mutation: guard on `offer.to.sid` instead of the machine → `test_AC11_target_machine_claim_is_accept`
red (bob's session is not named); allow any claim and leave the offer `offered` →
`test_AC11_third_user_409` red; treat the offerer's claim as an accept → `test_AC11_offerer_other_machine_withdraws` red.

---

## AC-12 `POST /v1/steps/:id/accept`

File `test/assign.test.ts`, `describe("accept")`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC12_accept_from_target` | offer to `bob/m2`; B token, `{sid: sb}` (bob's session on B) | 200 `Step` held by `sb`, state per claim (`claimed`/`working` as the claim route gives), `offer.state "accepted"`, `decidedAt` set; events for the step in order `step.claimed` then `step.accepted` (payload `machine` B, `sid` sb) | order reversed, missing |
| `test_AC12_other_machine_same_owner_403` | B2 token, `{sid: <bob's B2 session>}` | 403 `NOT_THIS("G.x","m2")`; offer still `offered` | 200 |
| `test_AC12_no_open_offer_409` | a step never offered | 409 `NO_OPEN(id)` | |
| `test_AC12_second_accept_409` | accept again after `test_AC12_accept_from_target` | 409 `NO_OPEN(id)`; holder unchanged | 200 or holder changed |
| `test_AC12_other_session_than_named` | offer to `bob/m2/perf`; accept from B with `perf-bench` sid | 200; held by `perf-bench` | 403 |
| `test_AC12_claim_errors_pass_through` | offer open, bob's session already holds another step | the same error status/text `POST /claim` gives for that case | offer accepted anyway |

Positive control: `test_AC12_accept_from_target` (200) and the 403 case on the same offer before it.
Mutation: emit `step.accepted` before `step.claimed` → `test_AC12_accept_from_target` red; accept from
any machine of the owner → `test_AC12_other_machine_same_owner_403` red.

---

## AC-13 Decline and withdraw

File `test/assign.test.ts`, `describe("decline/withdraw")`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC13_owner_declines` | offer to `bob/m2`; bob `POST …/decline {note: "busy"}` | 200 `Step`, `state "ready"`, `offer.state "declined"`, `note "busy"`, `decidedAt`; one `step.declined` (payload `machine`, `note`) | |
| `test_AC13_policy_user_may_decline` | B policy `["self","user:dave"]`; dave declines | 200 | 403 |
| `test_AC13_other_403` | carol declines | 403 `only the owner of m2 can decline <id>`; still `offered` | 200 |
| `test_AC13_session_override_used` | offer to `bob/m2/perf` where `perf` has override `["user:carol"]`; carol declines | 200 (positive); same with an offer to `bob/m2` (no session) → 403 | override ignored |
| `test_AC13_offerer_withdraws` | alice `POST …/withdraw {}` | 200, `offer.state "withdrawn"`, `decidedAt`; one `step.offer_withdrawn` | |
| `test_AC13_admin_withdraws` | `root` withdraws alice's offer | 200 | 403 |
| `test_AC13_other_withdraw_403` | carol | 403 `only @alice or an admin can withdraw the offer of <id>` | |
| `test_AC13_withdraw_no_offer_409` | withdraw twice | second 409 `NO_OPEN(id)` | |
| `test_AC13_decline_no_offer_409` | decline after withdraw | 409 `NO_OPEN(id)` | |
| `test_AC13_follow_up` | after decline and after withdraw: a new assign to `m1` → 200; with no offer, carol claims a declined step → 200 | both succeed | still guarded, or "already offered" |
| `test_AC13_decline_keeps_stick` | goal with stick (AC-18 setup); decline a stick offer | `GET /v1/goals/:id` still has `stick` | stick cleared |

Positive control: every 403 case is followed by the allowed caller's 200 on the same offer.
Mutation: let any member decline → `test_AC13_other_403` red; leave the guard active after decline →
`test_AC13_follow_up` red; ignore admin → `test_AC13_admin_withdraws` red.

---

## AC-14 Expiry

Files `test/assign.test.ts` (`describe("expiry")`, World clock), `src/hub/config.test.ts`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC14_not_before` | offer at `t0`; `w.clock = t0 + 29*60_000`; `w.tick()` | still `offered`; no `step.offer_expired` | early |
| `test_AC14_at_deadline` | `w.clock = t0 + 30*60_000`; `w.tick()` | `expired`, `decidedAt === w.clock`; exactly one `step.offer_expired` (payload `machine`) | `>` instead of `>=` |
| `test_AC14_tick_twice_once` | `w.tick()` again (clock +1 min) | still one event | double |
| `test_AC14_claimable_after` | carol claims | 200 | guard still active |
| `test_AC14_attention_offerer` | before carol's claim: alice's `/v1/attention` | item `kind "offer_expired"`, text `the offer of <step> to m2 expired; it is ready again`, `goal`, `step`, `at === decidedAt`; bob and carol have none; after carol's claim alice has none | missing, wrong viewer, stale |
| `test_AC14_not_ready_step_not_expired` | an accepted offer past the deadline; tick | state stays `accepted` | accepted offers expire |
| `test_AC14_config_duration` (config.test) | hub YAML with `thresholds.offer_expiry: 5m`; without it | `offerExpiryMs === 300000`; default `1800000` | |

Positive control: `test_AC14_at_deadline` follows `test_AC14_not_before` on the same offer.
Mutation: `now - at > offerExpiryMs` → `test_AC14_at_deadline` red; not filtering on `state ===
"offered"` → `test_AC14_tick_twice_once` red; parse the duration as seconds → `test_AC14_config_duration` red.

---

## AC-15 `GET /v1/offers` and `GET /v1/steps?ready=1`

File `test/assign.test.ts`, `describe("lists")`.

| Test | Setup | Expected | Fails when |
|---|---|---|---|
| `test_AC15_offers_bob_all_machines` | alice offers `S1` to `bob/m2` (note `n`), `S2` to `bob/b2`; `S3` to her own `m1`; `S4` to `bob/m2` then declined; `S5` withdrawn; `S6` expired; `S7` accepted | bob's `GET /v1/offers` (either token) contains exactly `S1`, `S2` (by step id); `S1` has `to "m2"`, `machine`, `auto`, `note "n"`, `expiresAt === at + 1800000`, `goal`, `title`, `repo`, `kind`, `by "alice"`; `S3`–`S7` absent | wrong membership |
| `test_AC15_offers_order` | `S1` at t, `S2` at t (same clock), `S0` at t−1 | order by `at` then step id | other order |
| `test_AC15_alice_sees_her_own` | alice's `/v1/offers` | contains `S3`, not `S1`/`S2` | |
| `test_AC15_ready_target_first` | step `R` offered to `bob/m2`; other ready steps exist; `GET /v1/steps?ready=1` with B's token | `R` listed and first | omitted or not first |
| `test_AC15_ready_other_machine_hidden` | same with B2's token; with carol's token | `R` absent; other ready steps present (control) | listed |
| `test_AC15_ready_offerer_sees` | alice's token (A1) | `R` listed | hidden from the offerer |
| `test_AC15_unfiltered_carries_offer` | `GET /v1/steps` without `ready=1`, carol | `R` listed with its `offer` | hidden |

Positive control: the other ready steps appear for every token, so absence of `R` is not an empty list.
Mutation: filter `/v1/offers` by the caller's token machine only → `test_AC15_offers_bob_all_machines`
red (`S2` missing via B's token); keep closed offers → same test red; hide `R` from the offerer →
`test_AC15_ready_offerer_sees` red.

---

## AC-16 Attention kind `offer`

File `test/assign.test.ts`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC16_offer_item_for_target_owner` | alice offers `S` to `bob/m2`; bob's `/v1/attention` and `/v1/live` `attention` | item `kind "offer"`, text `@alice offers S "<title>" to m2`, `goal`, `step`, `at === offer.at` | missing, text |
| `test_AC16_not_for_others` | carol's and alice's attention | no `kind "offer"` item for `S` | |
| `test_AC16_gone_after_end` | after decline / withdraw / accept / expiry (four sub-cases, fresh step each) | bob has no `kind "offer"` item for that step | stale |

Positive control: `test_AC16_offer_item_for_target_owner` asserts presence before each end in
`test_AC16_gone_after_end`.
Mutation: list offers by `offer.by` instead of the target owner → `test_AC16_offer_item_for_target_owner`
red; ignore state → `test_AC16_gone_after_end` red.

---

## AC-17 Goal assign

File `test/assign.test.ts`, `describe("goal assign")`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC17_new_goal_design` | new goal `G`; `POST /v1/goals/G/assign {to:"bob/m2"}` | 200 `{goal, steps, auto}`; `steps.map(id)` `["G.design"]`; one message and one event | |
| `test_AC17_skips_already_offered_and_gates` | goal with ready `a`, `b` (offered already) and a ready gate `g` | `steps` = `[a]` only | `b` re-offered, gate offered |
| `test_AC17_nothing_ready_409` | goal whose steps are all held | 409 `G has no ready step to offer` | |
| `test_AC17_stick_nothing_ready` | same with `stick: true` | 200, `steps: []`; `auto` present and equal to the target's policy verdict (alice → `bob/m2` with bob's `["self"]`: false; a second goal, alice → `m1`: true); `goal.stick` set with `to`, `by`, `at` | 409, `stick` unset, `auto` missing |
| `test_AC17_done_goal_409` | goal done (and one dropped) | 409 `G is done` / `G is dropped` | |
| `test_AC17_no_goal_404` | `G999` | 404 `no goal G999` | |
| `test_AC17_target_errors` | `to: "x"` | 404 `no machine x` | |

Positive control: `test_AC17_new_goal_design` succeeds; the 409 case asserts no new `step.offered`.
Mutation: offer gates too → `test_AC17_skips_already_offered_and_gates` red; refuse `stick` with
nothing ready → `test_AC17_stick_nothing_ready` red.

---

## AC-18 Stick

File `test/assign.test.ts`, `describe("stick")`. Alice's goal `G`, `assign G --stick` to `bob/m2`
(goal route); bob accepts the design (or alice approves directly) and alice approves a plan
`a` (no deps), `b` (deps `a`), `gate` (gate, deps `a`), `c` (deps `b`).

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC18_ready_steps_offered` | after plan approval (`a` ready) | `a` has an offer to B with `stick: true`; the `step.offered` event payload has `stick: true`; one machine-wide message for `a` | missing |
| `test_AC18_gate_not_offered` | finish `a` (b and gate ready) | `b` offered with `stick: true`; `gate` has no offer, no `step.offered` | gate offered |
| `test_AC18_one_message_each` | count `kind:"offer"` rows per step on B | exactly one per offered step | double |
| `test_AC18_release_not_reoffered` | bob accepts `b`, then releases it | `b` has no offer and no new `step.offered` | re-offered |
| `test_AC18_goal_withdraw` | alice `POST /v1/goals/G/withdraw` while `b`… (use a fresh open offer on `c` made ready) | 200 `{goal, withdrawn}` with `withdrawn` sorted step ids of her open offers; `goal.stick` absent; each with `step.offer_withdrawn`; finishing more steps offers nothing | further offers |
| `test_AC18_withdraw_nothing_409` | withdraw again | 409 `G has no stick and no open offer of yours` | |
| `test_AC18_goal_withdraw_others_offers` | carol has an open offer on a step of `G` too; alice withdraws | carol's offer stays `offered` (alice not admin); `root` withdraw ends it | |
| `test_AC18_target_gone_keeps_stick` | the stick names a session `m2/perf`; that session ends; next step ready | no offer, `goal.stick` still set | stick cleared or offer to machine only |

Positive control: `test_AC18_ready_steps_offered` before any negative; after `test_AC18_goal_withdraw`
the test makes a step ready and checks no offer, having first shown (earlier step) that readiness did
produce an offer.
Mutation: re-offer on release → `test_AC18_release_not_reoffered` red; keep the stick after goal
withdraw → `test_AC18_goal_withdraw` red; skip the gate check → `test_AC18_gate_not_offered` red.

---

## AC-19 Report back

File `test/assign.test.ts`, `describe("report back")`. Alice's session `sa` on A1; each offer made
with `sid: sa` unless stated. Messages read with `reportOf(w, A1, sa, kind, step)`.

| Test | Stimulus | Expected text (exact) | Fails when |
|---|---|---|---|
| `test_AC19_accepted` | bob accepts from session `perf-bench` on B | one `offer_accepted`: `MESH: m2/perf-bench accepted <step> "<title>".` | missing, text |
| `test_AC19_declined_note` | bob declines with `busy` | `MESH: m2 declined <step> "<title>": busy. It is ready again.`; without note: `… "<title>". It is ready again.` | |
| `test_AC19_expired` | expiry via tick | `MESH: the offer of <step> "<title>" to m2 expired (not accepted within 30 min). It is ready again.` | |
| `test_AC19_done` | accepted, then holder `mesh_done` with summary `ok` | `offer_done`: `MESH: <step> "<title>" (offered to m2) is done: ok` | |
| `test_AC19_failed` | accepted, then failed with summary `boom` | `offer_failed`: `MESH: <step> "<title>" (offered to m2) failed: boom` | |
| `test_AC19_question` | accepted, holder asks `why?` | `offer_question`: `MESH: question on <step> (offered to m2) from @bob: why?. Answer with: mesh answer <qid> <text>` with the real question id | |
| `test_AC19_no_sid_none` | offer without `sid`; accept, decline (fresh steps) | no `offer_*` row anywhere for those steps | queued to a machine-wide or other sid |
| `test_AC19_ended_session_none` | offer with `sid: sa`; `sa` ends (`SessionEnd`, flush); bob accepts | no `offer_accepted` | queued to an ended session |
| `test_AC19_withdraw_none` | withdraw | no `offer_*` row | |

Positive control: `test_AC19_accepted` shows rows do arrive for `sa`; `test_AC19_no_sid_none` asserts
the accept itself succeeded.
Mutation: compute `n` in seconds → `test_AC19_expired` red; send report-back to the offerer's machine
with `toSid: ""` when `bySid` is absent → `test_AC19_no_sid_none` red.

---

## AC-20 Daemon auto-accept

File `test/assign.test.ts`, `describe("daemon auto-accept")`. Bob's B policy `["self"]`; offers by
bob from B2 (`self` → `auto: true`) to `m2`. Goal topics `["perf","dataplane"]`.

| Test | Setup / stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC20_binds_idle_session` | one idle step-less session `s1` in the repo on B; offer; `w.flush()` | `GET /local/sessions` shows `s1.step === <step>`; hub step held by `s1` sid, `offer.state "accepted"`; `bob.pastes` has one paste to `s1`'s pane containing the step id (the `stepMessage` text) | not bound, not pasted |
| `test_AC20_prefers_labels` | idle `p1` (labels `["perf"]`, newer), `p2` (labels `["perf","dataplane"]`) | `p2` bound and pasted | `p1` |
| `test_AC20_named_working_waits_for_stop` | offer to `m2/<working session w>`; flush | hub claim by `w` (accepted) right away; `pastes` has no paste for `w`; then `w.hook(B, "Stop", pid)`, flush → one paste | paste while working, or not claimed |
| `test_AC20_ack_delivered_accepted` | after the first case | `bob.acks` has one ack for the message id: `delivered`, method `accepted` | `failed`, none |
| `test_AC20_second_pull_nothing` | flush twice more | still one paste, one `step.accepted`, one ack | double handling |
| `test_AC20_no_double_while_in_flight` | two pulls started before the first accept returns (delay the fake fetch) | one accept request for that message id | two |

Positive control: `test_AC20_binds_idle_session` shows binding works, so "nothing more" checks in
`test_AC20_second_pull_nothing` are meaningful.
Mutation: pick the newest session instead of label overlap → `test_AC20_prefers_labels` red; paste
directly instead of via the pending queue → `test_AC20_named_working_waits_for_stop` red; ack before the
hub answered and re-handle unacked rows → `test_AC20_second_pull_nothing` red.

---

## AC-21 Daemon without an idle session

File `test/assign.test.ts`, `describe("daemon no idle")`.

| Test | Setup | Expected | Fails when |
|---|---|---|---|
| `test_AC21_deliver_lists_and_notifies` | B `deliver`, auto offer, no idle session in the repo | no claim; offer `offered`; `bob.notes` has exactly one `mesh: @bob offers <step> "<title>": mesh offers`; ack `delivered`/`listed`; `launches` empty | a claim, zero or two notes |
| `test_AC21_launch_calls_fake` | `w.restart(B, {assignments: "launch"})`, same | `bob.launches` `toStrictEqual([{repo: <repo name>, step}])`; ack `delivered`/`launched` | not called or wrong args |
| `test_AC21_launch_fail_lists` | `launchResult = {ok:false, error:"x"}` | ack `delivered`/`listed`; one notification | `failed` ack |
| `test_AC21_manual_never_launches` | `launch`; offer by alice (`auto: false`), idle session present too | `launches` empty; no claim; no binding; one notification | launched or claimed |

Positive control: `test_AC21_launch_calls_fake` shows the fake is wired, so its emptiness in
`test_AC21_manual_never_launches` is meaningful; the idle session in that test proves a manual offer is
not auto-claimed even when a candidate exists.
Mutation: call `launchStep` regardless of `auto` → `test_AC21_manual_never_launches` red; notify
twice (on pull and on ack) → `test_AC21_deliver_lists_and_notifies` red.

---

## AC-22 `assignments: "off"`, refused accept, unknown kind

File `test/assign.test.ts`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC22_off_declines_auto_and_manual` | B `off`; an auto offer (bob) and a manual offer (alice with `sid: sa`); flush | both `declined` with `note "this machine does not take assignments"`; acks `delivered`/`declined`; alice's `sa` gets `offer_declined` | |
| `test_AC22_refused_accept_failed` | B `deliver`, auto offer, B offline; offerer withdraws; B online, flush | ack `failed`; no session has `step`; no paste | bound session |
| `test_AC22_unknown_kind_failed` | a machine-wide row of kind `other` (via `hubStore.addMessage`) | ack `failed`; no paste, no notification | `delivered` |
| `test_AC22_session_messages_unchanged` | a normal session message (non-empty `toSid`) | pasted as before | |

Positive control: `test_AC22_session_messages_unchanged`.
Mutation: under `off` decline only manual offers → `test_AC22_off_declines_auto_and_manual` red; bind
before the hub answers → `test_AC22_refused_accept_failed` red.

---

## AC-23 Daemon local routes

Files `src/daemon/daemon.test.ts` (`describe("offers")`, fake hub `fetch`) and `test/assign.test.ts`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC23_accept_with_target` | offer to B; `POST /local/accept {step, target: "perf"}` | 200 `{step, sid: <perf sid>, message: "perf now holds <step>"}`; session bound; brief queued | |
| `test_AC23_accept_target_any_state` | target a `working` session | 200, bound, paste after `Stop` | refused |
| `test_AC23_accept_pick` | no target, two idle sessions with labels | the `pickSession` choice | |
| `test_AC23_accept_named_sid_used` | offer names `perf` (idle) and another idle session has more labels | `perf` chosen | |
| `test_AC23_accept_no_candidate_409` | no idle session | 409 `no idle session for <repo> on this machine; use --session <s> or --launch` | |
| `test_AC23_accept_unknown_target_404` | `target: "nope"` | 404 `no live session matches "nope"` | |
| `test_AC23_accept_not_logged_in_409` (daemon.test) | daemon without credentials | 409 `not logged in to a hub; run: mesh login` | |
| `test_AC23_accept_hub_error_passthrough` | step offered to another machine | 403 with the hub's `NOT_THIS` text | 500 or rewritten |
| `test_AC23_offers_this_machine_only` | offers to B and B2 | B's `GET /local/offers` has only B's | |
| `test_AC23_offers_not_logged_in_409` (daemon.test) | no credentials | 409 | |
| `test_AC23_decline` | `POST /local/decline {step, note: "x"}` | 200 `{step}` with `offer.state "declined"`, note `x` | |
| `test_AC23_session_accept_set_clear` | `POST /local/session-accept {target: "perf", accept: ["user:bob"]}`; flush; then `accept: null`; flush | 200 `{session}` with `accept`; `/v1/fleet` session has it; after `null`: no `accept` key locally and in fleet | |
| `test_AC23_session_accept_bad_rule_400` | `accept: ["bob"]` | 400 `{error: "not an accept rule: bob (" + RULE + ")"}`; session unchanged | |
| `test_AC23_session_accept_unknown_404` | `target: "nope"` | 404 `no live session matches "nope"` | |
| `test_AC23_client_methods` (daemon.test) | `DaemonClient.accept`, `offers`, `decline`, `sessionAccept` against the daemon with the fake hub | resolve with the route replies; a 404 rejects with its text | wrong route/body |

Positive control: `test_AC23_accept_with_target` binds; the failure cases assert no session has the step.
Mutation: ignore the offer's named sid → `test_AC23_accept_named_sid_used` red; return all offers from
`/local/offers` → `test_AC23_offers_this_machine_only` red.

---

## AC-24 MCP tools

File `test/assign.test.ts`, `describe("mcp")` using `w.tool`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC24_assign_step_bySid` | alice's session `sa`: `mesh_assign {target: "G.design", to: "bob/m2"}` | text `Offered G.design to bob/m2 (waits for them to accept).`; hub `offer.bySid === sa` | no bySid |
| `test_AC24_assign_goal` | `mesh_assign {target: "H", to: "m1"}` | `Offered H.design to m1 (auto-accept).` | step route used |
| `test_AC24_assign_error` | `to: "x"` | tool error with text `no machine x` | |
| `test_AC24_offers` | bob's session: `mesh_offers {}` with one offer; with none | the `offerLine` text (one line per offer); `No offers for your machines.` | |
| `test_AC24_accept_binds` | `mesh_accept {step}` from bob's session on B | returns the brief (same text as `mesh_claim` would for that step); session bound; offer `accepted` held by that sid | |
| `test_AC24_accept_other_machine_error` | from bob's B2 session | tool error containing `NOT_THIS(step,"m2")`; offer `offered` | |
| `test_AC24_next_offered_first` | bob's B session: `mesh_next` with other ready steps and one offered to B | first listed step is the offered one, line ends ` · offered to you by @alice`; no other line has the suffix | |

Positive control: `test_AC24_accept_binds` succeeds where `test_AC24_accept_other_machine_error` fails.
Mutation: send no `sid` from `mesh_assign` → `test_AC24_assign_step_bySid` red; suffix every line in
`mesh_next` → `test_AC24_next_offered_first` red.

---

## AC-25 CLI `mesh assign`

Files `test/assign.test.ts` (`describe("cli assign")`, CLI against the World hub) and `test/cli.test.ts`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC25_step_manual` | `mesh assign G.design --to bob/m2` | stdout `Offered G.design to bob/m2 (waits for them to accept).`, exit 0; hub offer has no `bySid` | |
| `test_AC25_step_auto` | `--to m1` (alice) | `Offered <id> to m1 (auto-accept).` | |
| `test_AC25_goal_with_stick` | `mesh assign G --to m1 --stick` with two ready steps | line 1 `Offered <a>, <b> to m1 (auto-accept).` (ids as in `steps`); line 2 `Later steps of G go to m1 too (until: mesh withdraw G).` | |
| `test_AC25_goal_stick_nothing_ready` | | `No step of G is ready now.` then the stick line; exit 0 | |
| `test_AC25_note_passed` | `--note "pls"` | hub offer `note "pls"` | |
| `test_AC25_missing_to_usage` (cli.test) | `mesh assign G` ; `mesh assign` | stderr starts `usage: mesh assign <goal|step> --to <machine>[/<session>] [--stick] [--note "…"]`; exit 2; no hub call | |
| `test_AC25_hub_404_exit_1` | `--to x` | stderr `no machine x`, exit 1 | |

Positive control: the success tests read the hub to prove the offer exists.
Mutation: route a target with a `.` to the goal route → `test_AC25_step_manual` red; exit 0 on hub
error → `test_AC25_hub_404_exit_1` red.

---

## AC-26 CLI `offers`, `accept`, `decline`, `withdraw`, `session accept`, help

Files `test/assign.test.ts` (`describe("cli")`) and `test/cli.test.ts`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC26_offers_text` | bob: `mesh offers` with one offer; with none | `offerLine` per offer; `No offers for your machines.` | |
| `test_AC26_offers_json` | `--json` | parses to `{offers: [...]}` with the step | |
| `test_AC26_accept_session` | `mesh accept <step> --session perf` | stdout `perf now holds <step>`, exit 0; hub holder perf | |
| `test_AC26_accept_both_flags` (cli.test) | `--session a --launch`; and no step | stderr `usage: mesh accept <step> [--session <s> | --launch]`, exit 2 | |
| `test_AC26_accept_error_exit_1` | step offered to another machine | stderr has the hub text, exit 1 | |
| `test_AC26_decline` | `mesh decline <step> --note x` | `Declined <step>.`; hub note `x`; without step: usage, exit 2 | |
| `test_AC26_withdraw_step_goal` | `mesh withdraw <step>`; `mesh withdraw G` (stick + one offer); `mesh withdraw G2` (stick only) | `Withdrew the offer of <step>.`; `Withdrew the offers of G: <id>; later steps are no longer offered.`; `… of G2: none; later steps are no longer offered.` | |
| `test_AC26_session_accept_forms` | `--from self,user:bob`; `--off`; `--clear` | `perf: accepts offers from self, user:bob`; `perf: accepts no offer automatically`; `perf: uses the machine policy` | |
| `test_AC26_session_accept_bad_rule_no_call` (cli.test) | `--from bob` with a daemon spy | stderr `not an accept rule: bob (…)`, exit 2, no daemon request | daemon called |
| `test_AC26_session_accept_usage` (cli.test) | none or two of `--from/--off/--clear` | stderr starts `usage: mesh session accept <session> --from <rule,…> | --off | --clear`, exit 2 | |
| `test_AC26_help_lists` (cli.test) | `mesh help` | contains `assign`, `offers`, `accept`, `decline`, `withdraw`, `session` as command names | |

Positive control: `test_AC26_session_accept_forms` shows the daemon is reachable, so "no daemon call"
in the bad-rule test is meaningful.
Mutation: validate rules in the daemon only → `test_AC26_session_accept_bad_rule_no_call` red; print
`none` text differently → `test_AC26_withdraw_step_goal` red.

---

## AC-27 `mesh accept --launch`

File `test/m45-cli.test.ts` (fake runner, test daemon) with a hub (World or the file's existing hub stub).

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC27_launch_accepts_and_starts` | offer of `S` to this machine; `mesh accept S --launch` | the fake runner sees the same tmux call `mesh run <repo> --step S` produces (compare to a recorded call of that command); after the new session's first hook/claim, hub `offer.state "accepted"` held by the new sid (sid never synced before: also AC-40) | no start, or offer not accepted |
| `test_AC27_launch_other_machine_offer` | `S` offered elsewhere | the launched session's claim fails with the hub's guard text (not accepted) | accepted from the wrong machine |

Positive control: `test_AC27_launch_accepts_and_starts`.
Mutation: `--launch` calls `/local/accept` without starting a session → `test_AC27_launch_accepts_and_starts` red.

---

## AC-28 `mesh setup --accept / --assignments`

File `test/cli.test.ts` (temp config dir).

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC28_accept_user` | `mesh setup --accept user:bob` | `daemon.json` `accept` `["user:bob"]`; stdout `Offers from user:bob are accepted automatically. Restart the daemon to apply.` | |
| `test_AC28_accept_multi` | `--accept self,user:bob` | `Offers from self, user:bob are …` | |
| `test_AC28_accept_off` | `--accept off` | `["off"]`; `No offer is accepted automatically. Restart the daemon to apply.` | |
| `test_AC28_accept_bad` | `--accept bad` | exit 2, stderr the `parseAccept` text; file unchanged (byte compare) | written |
| `test_AC28_assignments_launch` | `--assignments launch` | `assignments: "launch"` | |
| `test_AC28_assignments_bad` | `--assignments x` | stderr `--assignments must be deliver, launch or off`, exit 2; file unchanged | |
| `test_AC28_other_setup_keeps` | file with `accept: ["user:bob"], assignments: "off"`; `mesh setup --share me` | both fields unchanged | reset to defaults |

Positive control: the success tests write; the failure tests compare bytes before/after.
Mutation: write defaults on every setup → `test_AC28_other_setup_keeps` red.

---

## AC-29 Goal detail and `renderGoal`

Files `test/assign.test.ts` and `src/cli/show.test.ts`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC29_detail_offers_accepted` | offer `S` to `m2`, accepted by `perf-bench` | `GET /v1/goals/G` `offers.S` `toStrictEqual({to: "m2", state: "accepted", by: "alice", at, accepted: "m2/perf-bench"})` | |
| `test_AC29_detail_declined_note` | another step declined with note | `offers[...]` has `state "declined"`, `note` | |
| `test_AC29_detail_stick` | goal with stick to `bob/m2` | `stick === "m2"` (target text = machine name) | |
| `test_AC29_detail_no_keys` | goal without offers or stick | no `offers` and no `stick` key | `{}` |
| `test_AC29_accepted_no_session_record` | holder session unknown to the hub (`steps` share, before sync) | `accepted === "m2"` | |
| `test_AC29_render_offer_line` (show.test) | `renderGoal` with `offers` and holder | that step's extras contain `offered to m2 → accepted by m2/perf-bench` after the holder | |
| `test_AC29_render_stick_line` (show.test) | `stick: "m2"` | line `sticks to m2: its next ready steps are offered there (mesh withdraw G)` right after the topics line | |
| `test_AC29_old_snapshots_unchanged` | existing `src/cli/show.test.ts` snapshots | pass without updating `__snapshots__` | snapshot rewritten |

Positive control: the render tests show the new lines appear when data exists.
Mutation: always emit `offers: {}` → `test_AC29_detail_no_keys` red; put the stick line before topics →
`test_AC29_render_stick_line` red.

---

## AC-30 `/v1/live` activity texts

File `test/assign.test.ts`. B's hostname `host-b`.

| Test | Stimulus | Expected activity text (found by step) |
|---|---|---|
| `test_AC30_offered` | assign | `offered <step> to host-b` |
| `test_AC30_accepted` | accept | `accepted <step> on host-b` |
| `test_AC30_declined` | decline | `declined <step> on host-b` |
| `test_AC30_expired` | expiry | `the offer of <step> to host-b expired` |
| `test_AC30_withdrawn` | withdraw | `withdrew the offer of <step> to host-b` |

Fails when any text differs or uses the nickname. Positive control: B has nickname `m2` and the
expected text uses the hostname, so a nickname-based text is caught.
Mutation: use the machine name → every `test_AC30_*` red.

---

## AC-31 TUI

File `src/cli/tui/render.test.ts`; keys by review.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC31_header_badge` | `render` with `offers: 2` | header contains `  ·  2 offered to you` after the needs count | |
| `test_AC31_header_unchanged_without` | `offers: 0` and absent | header equal to the MM-2 render (same view, no offers) | |
| `test_AC31_sessions_footer` | `render` | last line equals `SESSIONS_FOOTER` (clipped to width) | |
| `test_AC31_offers_panel` | `renderOffers([o1,o2], {width: 200, height: 12, header: "H", now, selected: o2.step, status: "ok"})` | 12 lines; `[0] === "H"`, `[1] === ""`, `[2] === "ASSIGNED TO YOU"`, `"  " + offerLine(o1)`, `"› " + offerLine(o2)`, `"ok"` on the line before last, last `OFFERS_FOOTER` | |
| `test_AC31_offers_empty` | `[]` | `  No offers for this machine.`; still `height` lines | |
| `test_AC31_offers_clip` | `width: 20` | every line ≤ 20 columns | |
| review | tui.ts | key `o` toggles, refresh every 5 s, ⏎ calls `accept(step)`, `d` calls `decline(step)` with status `Declined <step>.` | |

Mutation: return fewer lines than `height` → `test_AC31_offers_panel` red; always show the badge →
`test_AC31_header_unchanged_without` red.

---

## AC-32 Web (Playwright, `pnpm test:web`)

Files `test/e2e-web/mine.spec.ts`, `test/e2e-web/goals.spec.ts` (hub from `test/e2e-web/hub.yaml`;
offers seeded through the hub API).

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC32_mine_offer_row` | offer to the user's machine | `section.offers` with heading `Assigned to you` above the machines; an `li.offer` containing the step id, title, `from @<by>`, `to <to>`, `code` `mesh accept <step>`, a `Decline` button | |
| `test_AC32_decline` | click `Decline` | the `li.offer` is gone within 20 s; the hub has the offer `declined` | |
| `test_AC32_empty` | no offers | `p` `Nothing is assigned to you.` | |
| `test_AC32_goal_step_panel` | goal page, open the offered step's panel (`aria-label="step details"`) | `p.offer` with `offered to <to> by @<by>` | |
| `test_AC32_live_attention_code` | live attention list | the `offer` item shows `code` `mesh accept <step>` | |

Positive control: `test_AC32_mine_offer_row` before `test_AC32_decline`.
Mutation: not refetching after decline → `test_AC32_decline` red (unless the 15 s refetch wins:
the test also asserts the row is gone within 3 s of the click response).

---

## AC-33 Schemas, route table, docs, skill

File `test/schemas.test.ts` + review.

| Test | Stimulus | Expected |
|---|---|---|
| `test_AC33_openapi_current` | regenerate in memory as `pnpm schemas` does | equals `schemas/hub-api.openapi.json` |
| `test_AC33_openapi_routes` | the JSON | has `POST /v1/steps/{id}/assign`, `/accept`, `/decline`, `/withdraw`, `POST /v1/goals/{id}/assign`, `/withdraw`, `GET /v1/offers` |
| `test_AC33_hub_api_matches_app` | `HUB_API` vs. the routes registered in `src/hub/app.ts` (existing check) | equal; the seven new entries have rule `member` and no scope; tags `steps` / `goals` |
| `test_AC33_docs_mention` | read files | `docs/guide/concepts.md` has "Offers and accept policy", `offer_expiry`, `--stick`, `assignments`, and states that a named target session is visible; `docs/guide/howto.md` has "Hand work to another machine", `mesh assign`, `mesh session accept`, `shareSessions: steps` 404 note; `docs/guide/install.md` has `accept` and `assignments`; `docs/plan/implementation-plan.md` §5.6 has the seven routes; `docs/events.md` has `step.offered`, `step.accepted`, `step.declined`, `step.offer_expired`, `step.offer_withdrawn` |
| `test_AC33_skill` | `MESH_SKILL` | contains `mesh_assign`, `mesh_offers`, `mesh_accept`; equals `skills/mesh/SKILL.md` |
| review | docs | semantics match the spec (who may decline, expiry default, privacy) |

Fails when stale schema, a missing route/row, or a skill mismatch. Mutation: delete one route from
`HUB_API` → `test_AC33_hub_api_matches_app` red; drop `step.offer_expired` from `docs/events.md` →
`test_AC33_docs_mention` red.

---

## AC-34 Version, checks, placement

| Test | Stimulus | Expected |
|---|---|---|
| `test_AC34_version` (schemas.test; replaces the MM-2 version assertion) | `package.json` | `"0.1.11"` |
| `test_AC34_placement` (schemas.test) | `src/core/index.ts` exports `acceptMatches`, `pickSession`, `offerText`, `offerLine`; `src/protocol/index.ts` exports `parseAccept`, `AcceptRule`, `AcceptPolicy`, `ACCEPT_RULE_TEXT`, `OfferState`, `StepOffer` | present |
| `pnpm check` | lint, typecheck, boundaries, test, build | all pass |

Mutation: move `acceptMatches` to `src/hub` → `test_AC34_placement` red.

---

## AC-35 Borrowed sid (B1, B4)

File `test/assign.test.ts`, `describe("borrowed sid")`. Bob's session `sb` on B, a session `sc` of carol
recorded on machine B (see the note below), carol's machine C; all synced, so the hub has every sid.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC35_carol_claim_with_bobs_sid` | step offered to B; carol's C token, `POST /claim {sid: sb}` | 403 `NOT_YOURS(sb)`; offer `offered`, step `ready` | 200 |
| `test_AC35_carol_accept_with_bobs_sid` | same on `/accept` | 403 `NOT_YOURS(sb)`; offer `offered` | |
| `test_AC35_bob_accept_with_carols_sid_on_B` | bob's B token, `{sid: sc}` | 403 `NOT_YOURS(sc)` | 200 (same machine, other user) |
| `test_AC35_assign_with_sid_of_m1` | alice's A1 policy `["machine:m1"]` (A2 = `m1`); carol assigns to `alice/a1` with `sid: <alice's A2 session>` | 403 `NOT_YOURS(<sid>)`; no offer | 200 / `auto: true` |
| `test_AC35_assign_without_sid` | carol assigns without sid | 200, `auto: false`, `offer.byMachine === machineOf(C)` | `byMachine` = A2 |
| `test_AC35_tokenless_machine_accept` | a token without a machine (a user API token for bob), no sid | 403 `NOT_THIS(step,"m2")` | 200 |
| `test_AC35_unknown_sid_not_403` | carol's C token with a sid the hub never saw on `/claim` of an offered step | 409 `OFFERED_TO(step,"m2")` (not 403 `not yours`) | 403 `not yours` |

Positive control: in each test, after the refusal, the legitimate owner's call with their own sid
succeeds (bob's `sb` from B → 200), proving the step was claimable.
Note: carol's session on bob's machine B requires a machine that carol logs in on with B's install;
if the World cannot place two users on one machine, `sc` is created by a raw `POST /v1/sync` with
B's id and carol's token is not possible: see Open questions.
Mutation: derive the caller machine from the body sid → `test_AC35_assign_with_sid_of_m1` red;
check only the user, not the machine, of a known sid → `test_AC35_bob_accept_with_carols_sid_on_B` red.

---

## AC-36 Concurrency (B2)

File `test/assign-concurrency.test.ts`. Two hubs (`makeConfig`-style, as in `test/m46-replicas.test.ts`)
on one SQLite file; a Postgres leg in the same `describe.each` that is **required** (not skipped)
when the Postgres URL is set. 20 rounds per case, each with a fresh goal.

| Test | Stimulus | Expected per round | Fails when |
|---|---|---|---|
| `test_AC36_assign_assign` | `Promise.all` of assign via hub 1 and assign via hub 2 of one ready step | statuses `{200, 409}`; the 409 text contains `already offered`; one `step.offered` for the step; one `kind:"offer"` row for the step in the target inbox | two 200, two events, two rows |
| `test_AC36_assign_claim` | assign to B via hub 1 ∥ claim by carol via hub 2 | either (assign 200, claim 409 `OFFERED_TO`) or (claim 200, assign 409 with a non-ready text); final step: if held by carol, its last `step.offered` (if any) has a later `step.accepted` or `step.offer_withdrawn`; if assign got 200, `GET /v1/steps/<id>` has `offer` | held step with dangling offer, lost offer, both 200 |
| `test_AC36_expiry_accept` | offer at t0, clock past deadline on both hubs; `tick()` on hub 1 ∥ accept on hub 2 | exactly one of `step.offer_expired` / `step.accepted`; `offer.state` is `expired` (accept got 409 `NO_OPEN`) or `accepted` (accept 200) accordingly | both events, or state contradicts the event |

Positive control: a sequential round (no concurrency) of each case first gives the deterministic
outcome, showing the counting helpers work.
Mutation: run the claim outside `goalTx` → `test_AC36_assign_claim` red within 20 rounds (expected;
if not reliably red, the reviewer injects a delay between read and save in the claim path while the
mutation is applied); read-then-write assign without serialisation → `test_AC36_assign_assign` red.

---

## AC-37 Question on an accepted offer (B3)

File `test/assign.test.ts`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC37_offerer_in_toUsers` | alice's team goal; dave assigns a step to `bob/m2` with `sid: sd`; bob accepts; bob's session asks a question on the step | question `toUsers` contains `dave` after the asker and alice, no repeats | lacks dave |
| `test_AC37_dave_attention_question` | dave's `/v1/attention` | a `question` item for it | |
| `test_AC37_offer_question_message` | dave's machine inbox for `sd` | `offer_question` with the question id | |
| `test_AC37_dave_answers` | dave `mesh answer <qid> ok` (API) | 200 | 403 |
| `test_AC37_no_offer_unchanged` | question on a step never offered | `toUsers` as before MM-3 (asker, goal owner) | dave added |
| `test_AC37_declined_offer_unchanged` | question on a step whose offer was declined | dave not in `toUsers` | |

Positive control: `test_AC37_offerer_in_toUsers` vs. `test_AC37_no_offer_unchanged`.
Mutation: add `offer.by` for any offer state → `test_AC37_declined_offer_unchanged` red.

---

## AC-38 Offer ends with its step; release removes the offer (S2, S3)

File `test/assign.test.ts`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC38_replan_drops` | open offer on `b`; a new plan without `b` | `offer.state "withdrawn"`, one `step.offer_withdrawn` with payload `reason` = `step <new state>` (the dropped state the hub reports) | offer still `offered` |
| `test_AC38_replan_blocks` | a new plan making `b` depend on an unfinished step | `withdrawn`, `reason: "step blocked"` | |
| `test_AC38_lists_cleared` | after either | `GET /v1/offers` and `/v1/attention` of the target owner have no entry for `b` | |
| `test_AC38_no_report_back` | offer with `sid` | no `offer_*` message for the drop | |
| `test_AC38_release_removes` | accepted offer; holder releases | `GET /v1/steps/<id>` has no `offer`; goal detail `offers` has no key for it | |
| `test_AC38_no_done_after_release` | carol then claims and finishes it | alice's `sa` gets no `offer_done`; positive control: an unreleased accepted step's finish does send `offer_done` (AC-19) | message sent |

Mutation: keep the offer on release → `test_AC38_no_done_after_release` red; not ending offers on
replan → `test_AC38_replan_drops` red.

---

## AC-39 Daemon retry (S1)

File `test/assign.test.ts`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC39_lost_reply_retried` | auto offer to B with an idle session; `bob.dropReplyOnce(/\/accept$/)`; flush; flush again | `bob.requests` has two accept requests, both with `Idempotency-Key: offer-<message id>`; hub offer `accepted` held by the session; `GET /local/sessions` session bound once; one paste; one ack `delivered`/`accepted`; no `failed` ack; one `step.accepted` | `failed` ack, two pastes, keys differ |
| `test_AC39_restart_retry` | drop the reply, then `w.restart(bob)` before the next pull | same end state after restart | handled twice or not at all |

Positive control: the first flush records an accept request (the drop happened after the hub
committed), so a passing second flush is a real retry.
Mutation: random idempotency key per attempt → `test_AC39_lost_reply_retried` red (second call 409,
ack `failed`); ack before the hub answers → red.

---

## AC-40 Unknown sid (B4)

File `test/assign.test.ts`, `describe("unknown sid")`. Bob's B shares `steps` (idle sessions never
synced).

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC40_auto_accept_unsynced` | auto offer to B, idle step-less session (never synced); flush | 200 accept (no `failed` ack); offer `accepted`, held by that sid | 403 `not yours` |
| `test_AC40_launch_new_sid` | `assignments: "launch"` or `mesh accept --launch` (AC-27): the new session's first claim with a brand-new sid | offer `accepted` | |
| `test_AC40_mesh_assign_unsynced_bySid` | a step-less session on B under `steps` calls `mesh_assign` | 200 path text; `offer.bySid` = that sid | 403 |
| `test_AC40_carol_unknown_sid_claim` | step offered to B; carol's C token, unknown sid, `/claim` | 409 `OFFERED_TO(step,"m2")`; offer `offered` | 200 or 403 `not yours` |
| `test_AC40_carol_unknown_sid_accept` | same on `/accept` | 403 `NOT_THIS(step,"m2")`; offer `offered` | 200 |

Positive control: `test_AC40_auto_accept_unsynced` proves unknown sids work from the right machine,
so the refusals from C are about the machine.
Mutation: refuse any sid the hub does not know → `test_AC40_auto_accept_unsynced` red; trust an
unknown sid's claimed machine → `test_AC40_carol_unknown_sid_accept` red.

---

## Criterion coverage

| AC | Tests | Surface |
|---|---|---|
| AC-01 | `test_AC01_*` (13) | unit |
| AC-02 | `test_AC02_*` (8) | unit |
| AC-03 | `test_AC03_*` (10) | unit |
| AC-04 | `test_AC04_*` (7) | unit |
| AC-05 | `test_AC05_*` (9) | unit, World |
| AC-06 | `test_AC06_*` (7) | contract |
| AC-07 | `test_AC07_*` (11) | World |
| AC-08 | `test_AC08_*` (9) | World |
| AC-09 | `test_AC09_*` (7) | World |
| AC-10 | `test_AC10_*` (4) | World |
| AC-11 | `test_AC11_*` (4) | World |
| AC-12 | `test_AC12_*` (6) | World |
| AC-13 | `test_AC13_*` (11) | World |
| AC-14 | `test_AC14_*` (7) | World, unit |
| AC-15 | `test_AC15_*` (7) | World |
| AC-16 | `test_AC16_*` (3) | World |
| AC-17 | `test_AC17_*` (7) | World |
| AC-18 | `test_AC18_*` (8) | World |
| AC-19 | `test_AC19_*` (9) | World |
| AC-20 | `test_AC20_*` (6) | World |
| AC-21 | `test_AC21_*` (4) | World |
| AC-22 | `test_AC22_*` (4) | World |
| AC-23 | `test_AC23_*` (15) | daemon, World |
| AC-24 | `test_AC24_*` (7) | World (MCP) |
| AC-25 | `test_AC25_*` (7) | CLI |
| AC-26 | `test_AC26_*` (11) | CLI |
| AC-27 | `test_AC27_*` (2) | CLI, fake runner |
| AC-28 | `test_AC28_*` (7) | CLI |
| AC-29 | `test_AC29_*` (8) | World, unit |
| AC-30 | `test_AC30_*` (5) | World |
| AC-31 | `test_AC31_*` (6) + review | unit, review |
| AC-32 | `test_AC32_*` (5) | Playwright |
| AC-33 | `test_AC33_*` (5) + review | schemas, review |
| AC-34 | `test_AC34_*` (2) + `pnpm check` | check |
| AC-35 | `test_AC35_*` (7) | World |
| AC-36 | `test_AC36_*` (3 × 20 rounds × store) | World, two hubs |
| AC-37 | `test_AC37_*` (6) | World |
| AC-38 | `test_AC38_*` (6) | World |
| AC-39 | `test_AC39_*` (2) | World |
| AC-40 | `test_AC40_*` (5) | World |

## Open questions (for the spec owner; tests take the conservative reading)

- AC-07 service token: the spec says "a service token 403" but pins no body text; the tests assert the
  status only.
- AC-07 / AC-36 (b): the 409 text an assign gets when the step was claimed first is the existing
  `<id> is <state>, not ready`; the tests accept any 409 whose text ends `not ready`.
- AC-12: the exact step state after accept is "as `POST /claim` would"; the tests compare with the
  state a plain claim of a sibling step gives instead of a literal.
- AC-20 / AC-21 / AC-22 / AC-39 "ack `delivered` method …": the spec names the ack values but not
  where a black-box test reads them; the plan records the daemon's ack requests in the World's
  `fetch` wrapper (`p.acks`). If the ack route's body shape differs, the helper adapts; the assertion
  stays on status and method.
- AC-35 "bob's token on B with the sid of carol's session on B": a session of carol on bob's machine
  needs either two users on one install (not supported by `World.person` as far as its signature
  shows) or a raw `POST /v1/sync` by carol naming B's machine id. The plan uses the raw sync when the
  hub accepts it; otherwise the test seeds the session record with `w.hubStore` directly.
- AC-38: the payload `reason` for a dropped step is `step <new state>`; the spec does not name the
  state a dropped step gets, so the test reads the step's state after the replan and expects
  `step ${state}`.
- AC-18: "after `POST /v1/goals/:id/withdraw` no further step is offered" when another user still has
  an open offer: the plan assumes the other user's offer stays open (only the stick is cleared).
- AC-32 Decline timing: "within 20 s" with a 15 s refetch interval would pass without an immediate
  refetch; the plan adds a 3 s bound after the decline response so the spec's "then refetch" is tested.
- AC-34 replaces the MM-2 `test_AC22_version` assertion (`0.1.10`) with `0.1.11`; the spec says only
  AC-34 asserts the version, so the old assertion is removed rather than kept.

## Checks

This plan is a document only. Checks run for this commit: none of `pnpm lint`, `pnpm typecheck`,
`pnpm boundaries`, `pnpm test`, `pnpm build` (no source changed); they run on the test branch when the
tests are written.
