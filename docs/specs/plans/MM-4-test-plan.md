# Test plan MM-4: Suggest and convenience (suggest, web Assign, `mesh say <machine>/<session>`, `maxSessions`)

Spec: `docs/specs/MM-4.md` (revision 3, approved in `docs/specs/reviews/MM-4/`, round 3).

Inputs read: `docs/specs/MM-4.md` (interface contracts, acceptance criteria, open questions); the
design `docs/analysis/2026-11-11-my-mesh-and-assign.md`; the interface tables of `docs/specs/MM-1.md`,
`MM-2.md` and `MM-3.md` that MM-4 names (sync body, machine labels route, nickname route, accept policy,
`pickSession`); the format of `docs/specs/plans/MM-2-test-plan.md` and `MM-3-test-plan.md`; the role file
`assets/sdd/.claude/agents/test-planner.md`; the file names of existing tests under `test/`,
`test/e2e-web/` and `src/**/*.test.ts`; the public signatures of `test/helpers/world.ts` (`World.clock`,
`start`, `login`, `person`, `restart`, `hook`, `turn`, `tick`, `flush`, `machineOf`, `api`, `call`; the
`Person` fields `pastes`, `notes`, `acks`, `requests`, `launches`, `launchResult`; `PersonOptions`) and the
names of the local helpers in `test/assign.test.ts` (`local`, `namedSession`, `nick`, `label`, `pull`,
`goal`, `stepOf`, `detailOf`, `assign`, `act`, `events`, `inboxOf`, `cli`, `cast`, `dcast`, `autoOffer`).
Not read: `docs/specs/plans/MM-4-impl-plan.md` (the implementation plan); any implementation source of
this row or of the code it changes (protocol, hub, store, daemon, CLI, web, `src/core`).

Planned black-box from the contracts. Every negative assertion has a positive control in the same
test or a named sibling, so a test cannot pass because nothing happened. Each criterion names at
least one mutation of the implementation that must turn one of its tests red; the implementer or
reviewer applies it once by hand, confirms red, and reverts.

Rules from the spec's AC preamble that every test follows: suggestions are found by `machine` id,
steps by step id, messages by `kind` + `toSid` + text; never by hostname or list position. Order is
asserted only where the Rank key decides it (AC-02, and AC-09 "in the hub's order", which compares with
the hub's own reply). No test asserts `package.json`'s version.

## Surfaces and files

| Surface | File | New or extended |
|---|---|---|
| unit, protocol (`DaemonConfig.maxSessions`) | `src/protocol/config.test.ts` | extended (`describe("maxSessions")`) |
| unit, protocol (`MessageRequest.to` and its refine) | `src/protocol/messages.test.ts` | new |
| World (real hub + daemons over HTTP): suggest, `to` on messages, `maxSessions` | `test/suggest.test.ts` | new |
| CLI against a World hub (`mesh assign --suggest`, `mesh say m/s`) | `test/suggest.test.ts` `describe("cli")` (reuses the `cli` helper of `test/assign.test.ts`, moved to `test/helpers/assign-kit.ts` or copied) | new |
| CLI old-hub stub (`node:http` server) | `test/suggest.test.ts` `describe("cli old hub")` | new |
| CLI usage / help / setup (no hub needed) | `test/cli.test.ts` | extended |
| CLI with a test daemon (`mesh say <session>` local path, `mesh accept --launch` not gated) | `test/m45-cli.test.ts` | extended |
| schemas, route table, skill, docs | `test/schemas.test.ts` | extended |
| Playwright | `test/e2e-web/goals.spec.ts` | extended (`pnpm test:web`, after `pnpm build`; not part of `pnpm check`) |

### Test-side helpers and World extensions (allowed by the spec's contracts section)

- `w.restart(p, {maxSessions})`: `restart` also accepts `maxSessions` (number or `undefined` to remove).
- `Person.logs: string[]`: every line the daemon passes to `deps.log` (today printed only under
  `WORLD_LOG`); used for the exact `not starting a session …` line (AC-13).
- `bare(w, user, hostname)`: `w.login(user, {hostname})` with no daemon. Returns `{token, machine}`
  (`machine` = the id from the login result, or the `current: true` row of `GET /v1/fleet` with that
  token). Used where a test needs full control of a machine's sessions, inventory and `lastSeen`.
- `sync(w, m, {share, repos?, accept?, sessions?})`: one `POST /v1/sync` on `m.token` at `w.clock` with
  `machine: {share, repos, accept}` (the MM-1 / MM-3 sync fields) and the full list of `sessions`
  (`Session` records: `sid`, `state`, `repo`, `name?`, `labels?`, `step?`, `launching?`, `lastEventAt`).
  Every call sends the machine's whole session list, so a test states the complete hub state.
  `lastSeen` of `m` becomes `w.clock`.
- `mlabels(w, m, labels)`: `POST /v1/machines/<m.machine>/labels {labels}` with `m.token` (MM-2).
- `nickname(w, m, n)`: `POST /v1/machines/<m.machine>/name {nickname: n}` (MM-1).
- `suggest(w, token, target, q = "")`: `GET /v1/steps/<target>/suggest<q>` when `target` contains `.`,
  else `/v1/goals/<target>/suggest<q>`; returns `{status, json}`. `byMachine(view, id)` finds a
  suggestion by `machine` id.
- `goal(owner, steps, topics)` and `approvePlan` as in `test/assign.test.ts` (step input
  `{id, deps, gate?, repo}`), so tests control which steps are ready and their repo.
- `events(w)`: the hub's full event list (count and last id) for "no event" checks.

### Common cast (`test/suggest.test.ts` unless noted)

Users `alice` (goal owner, caller unless stated), `bob`, `carol`, `root` (admin); a service token from
the hub config. Repos: `R_A = "git.example.com/org/alpha"` (repo name `alpha`), `R_B =
"git.example.com/org/beta"` (`beta`), `R_Z = "git.example.com/org/zeta"` (`zeta`, nobody has it).
Goal `G` (owner alice, topics `["perf"]`) with plan steps `G.s1` (ready, repo `R_A`), `G.s2` (ready, repo
`R_B`), `G.g` (gate, ready), `G.s3` (blocked on `G.s1`, repo `R_Z`). Wanted labels for `G.s1`:
`W = {perf, alpha}`.

Shared constants (copied from the spec, not imported, so a changed text turns tests red):
- `ASSIGN_USAGE = "usage: mesh assign <goal|step> --to <machine>[/<session>] [--stick] [--note \"…\"]\n       mesh assign <goal|step> --suggest [--team] [--any] [--json]"`
- `SAY_USAGE = "usage: mesh say <session> <text>\n       mesh say <machine>/<session> <text>"`
- `OLD_HUB = "the hub does not offer suggestions (it needs v0.1.12 or later)"`
- `SENT = (to) => \`Sent to ${to}; mesh delivers it as soon as the session can take it.\``
- `MAX_BAD = "--max-sessions must be a whole number from 1 to 1000, or off"`
- `MAX_ON = (n) => \`An offer starts a session only while fewer than ${n} are live. Restart the daemon to apply.\``
- `MAX_OFF = "An offer may start a session however many are live. Restart the daemon to apply."`
- `NOT_STARTING = (step, n, max) => \`not starting a session for offered step ${step}: ${n} live sessions, maxSessions ${max}\``

---

## AC-01 Step suggest: filter and view fields

File `test/suggest.test.ts`, `describe("suggest filter")`. Alice: `A` (`bare`, inventory `[R_A]`, no
sessions), `B` (inventory `[R_B]`, one session in `R_B`), `C` (no inventory, one visible idle session in
`R_A`, share `me`). Bob: `D` (inventory `[R_A]`, share `me`), `E` (inventory `[R_B]`).

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC01_default_filter` | `suggest(alice, "G.s1")` | 200; machine ids in `suggestions` as a set `= {A, C}`; `byMachine(B)` undefined; no bob machine | B listed, C missing (session repo ignored), A missing, bob's machines listed without `team` |
| `test_AC01_any_keeps_all` | `?any=1` | set `= {A, B, C}`; `byMachine(B).repo === false`; `A.repo === true`, `C.repo === true` | B absent, `repo` wrong |
| `test_AC01_team_adds_others` | `?team=1` | set `= {A, C, D}` (E has no `alpha`); `?team=1&any=1` → `{A, B, C, D, E}` | bob's machines missing, or E listed without `any` |
| `test_AC01_flag_values` | `?team=true`, `?any=yes`, `?team=0` | each answers as no flag (`team: false`, `any: false`, set `{A, C}`) | a non-`1` value turns a flag on |
| `test_AC01_view_fields` | `suggest(alice, "G.s1", "?team=1")` | `target === "G.s1"`, `steps` `toStrictEqual(["G.s1"])`, `repos` `toStrictEqual([R_A])`, `topics` `toStrictEqual(["perf"])`, `team === true`, `any === false`; each suggestion has exactly the keys of `Suggestion` (`session` only when `idle > 0`) | any field or key differs |
| `test_AC01_step_without_goal_topics` | goal `H` without topics, step `H.s1` repo `R_A` | `topics` `toStrictEqual([])` | `undefined` or the other goal's topics |

Positive control: `test_AC01_any_keeps_all` and `test_AC01_team_adds_others` show B, D and E exist and
are reachable, so their absence in `test_AC01_default_filter` is the filter.
Mutation: drop the visible-session clause of `repo` → `test_AC01_default_filter` (C missing) red; ignore
`team` → `test_AC01_team_adds_others` red; treat any truthy `team` value as on → `test_AC01_flag_values`
red; filter before computing `repo` with `any` → `test_AC01_any_keeps_all` red.

---

## AC-02 Rank key position

File `test/suggest.test.ts`, `describe("rank")`. One test per key; each uses exactly two candidate
machines, both alice's unless stated, created with `bare` and fed with `sync`. Because machine ids are
assigned by the hub, each test creates both machines first and gives the **winner** role to the one
with the larger id (the loser therefore always has the smaller id, i.e. is better on the last key).
"Offline" = synced, then `w.clock += 200_000`, then the other machine synced. Subject `G.s1` (`W =
{perf, alpha}`); `auto` from `accept: ["self"]` (true) or `["off"]` (false). Each test asserts
`suggestions[0].machine === winner` and `suggestions[1].machine === loser` (two-row list; order is the
rank).

| Test | Winner (better on k, worse on every later key it can be) | Loser | Fails when |
|---|---|---|---|
| `test_AC02_auto` | `["self"]`; no repo (query `any=1`); no labels; offline; 0 idle; older; larger id | `["off"]`; inventory `R_A`; idle session labelled `perf`; machine label `alpha`; online; 2 idle; newer; smaller id | `auto` not first key |
| `test_AC02_repo` (`any=1`) | `self`; inventory `R_A`; no session; no machine labels; offline; older; larger id | `self`; no repo (so necessarily 0 idle and no session labels); machine labels `perf`,`alpha`; online; newer; smaller id | `repo` after a later key |
| `test_AC02_session_labels` | `self`; repo; best idle session labels `["alpha","perf"]`; no machine labels; offline; 1 idle; older; larger id | `self`; repo; best idle session labels `["perf"]`; machine labels `perf`,`alpha`; online; 3 idle; newer; smaller id | session labels after machine labels / online / idle |
| `test_AC02_machine_labels` | `self`; repo; no idle sessions; machine labels `perf`,`alpha`; offline; older; larger id | `self`; repo; 2 idle sessions without wanted labels (labels `["other"]`); machine label `perf`; online; newer; smaller id | machine labels after online / idle |
| `test_AC02_online` | `self`; repo; no labels; online; 0 idle; larger id | `self`; repo; no labels; offline; 2 idle; smaller id | `online` after `idle` or id |
| `test_AC02_idle` | both online (winner synced at `t`, loser at `t + 10_000`); winner 2 idle, older; larger id | 1 idle, newer, smaller id | `idle` after `lastSeen` |
| `test_AC02_last_seen` | both online, equal on everything; winner synced 10 s after the loser; larger id | older; smaller id | `lastSeen` after id, or oldest first |
| `test_AC02_machine_id` | the machine with the **smaller** id (this test only; equal on every other key, both synced at the same `w.clock`) | the larger id | larger id first |
| `test_AC02_auto_team` | `team=1`: bob's machine with `["user:alice"]` (auto), offline, no labels vs bob's machine with `["self"]` online with labels | as left | another user's auto machine not ranked by `auto` |

Each test first asserts the precondition fields (e.g. `auto`, `repo`, `sessionLabels.length`,
`machineLabels.length`, `online`, `idle`, `lastSeen`) on both rows, so a pair that is not set up as
described fails on the setup check, not on the order.
Positive control: the precondition asserts prove the loser really is better on every later key.
Mutation: swap `online` and `idle` → `test_AC02_online` red; swap `sessionLabels` and `machineLabels`
→ `test_AC02_session_labels` and `test_AC02_machine_labels` red; drop `auto` from the key →
`test_AC02_auto` red; sort `lastSeen` ascending → `test_AC02_last_seen` red; `localeCompare` or larger
id first → `test_AC02_machine_id` red; a weighted sum (e.g. 1 point per key) → `test_AC02_auto` red.

---

## AC-03 Suggestion fields

File `test/suggest.test.ts`, `describe("fields")`. Alice's `bare` machine `M` (inventory `[R_A]`) unless
stated; subject `G.s1`.

| Test | Sessions on `M` (via `sync`) | Expected on `byMachine(M)` | Fails when |
|---|---|---|---|
| `test_AC03_idle_counts_only_candidates` | `i1` idle `R_A`; `i2` idle `R_A` with `step: "X.s1"`; `i3` idle `R_A` `launching: true`; `i4` working `R_A`; `i5` idle `R_B`; `i6` `state: "ended"` `R_A`; `i7` idle `R_A` | `idle === 2`; `session` ∈ {`i1`,`i7`} | any of `i2…i6` counted |
| `test_AC03_best_by_labels` | `p1` idle `R_A` labels `["perf"]`, `lastEventAt` 20; `p2` idle `R_A` labels `["alpha","perf"]`, `lastEventAt` 10 | `session === p2`; `sessionLabels` `toStrictEqual(["alpha","perf"])` | newer wins over labels |
| `test_AC03_best_tie_last_event` | equal wanted labels, `lastEventAt` 10 vs 20 | the 20 one | older |
| `test_AC03_best_tie_sid` | equal labels and `lastEventAt`; sids `"B-…"` and `"a-…"` (code-point: `B` < `a`) | the `B-…` one | `localeCompare` order |
| `test_AC03_session_labels_intersection` | best session labels `["zzz","perf","alpha","x"]` | `sessionLabels` `toStrictEqual(["alpha","perf"])` (sorted, only `W`; `alpha` counts as the repo name) | unsorted, non-wanted kept, repo-name label ignored |
| `test_AC03_no_idle_no_session` | only `i4` (working) | `idle === 0`; `"session" in s === false`; `sessionLabels` `toStrictEqual([])` | `session` present or `null` |
| `test_AC03_machine_labels_intersection` | machine labels `["gpu","perf","alpha"]` | `machineLabels` `toStrictEqual(["alpha","perf"])` | unsorted, `gpu` kept |
| `test_AC03_online_boundary` | `M` synced; `w.clock += 119_999` → `online === true`; second machine, `w.clock += 120_000` → `online === false`; `lastSeen` equals the sync clock | as stated | `<=` instead of `<`, or another window |
| `test_AC03_auto_self_own` | `M` `accept: ["self"]`, caller alice | `auto === true` | false |
| `test_AC03_auto_bob_self` | alice's `M` `["self"]`, caller bob, `?team=1` | `auto === false` | true |
| `test_AC03_auto_user_rule` | alice's `M` `["user:bob"]`, caller bob, `team=1` | `auto === true` | false |
| `test_AC03_auto_off` | `["off"]`, caller alice | `auto === false`; the machine is still listed | dropped or true |
| `test_AC03_auto_no_policy` | `bare` machine whose syncs never carry `accept`, caller alice | `auto === false` | true (default assumed) |
| `test_AC03_auto_machine_rule` | alice's `M` `["machine:<bob's B id>"]`; caller bob with B's device token → `true`; with bob's other machine's token → `false` | as stated | `byMachine` ignored |
| `test_AC03_user_and_name` | `M` nicknamed `lab`, hostname `h-lab`; another unnamed machine `N` with hostname `h-n` | `user === "alice"`; `byMachine(M).name === "lab"`; `byMachine(N).name === "h-n"` | hostname used despite nickname |

Positive control: `test_AC03_idle_counts_only_candidates` asserts `idle === 2`, not `0`, so the
exclusions are meaningful; `test_AC03_auto_self_own` and `test_AC03_auto_user_rule` show `true` is
reachable before the `false` cases.
Mutation: drop the `launching` filter → `test_AC03_idle_counts_only_candidates` red; pick newest
instead of most labels → `test_AC03_best_by_labels` red; compare labels against topics only (MM-3
`pickSession` rule) → `test_AC03_session_labels_intersection` red; default a missing policy to
`["self"]` → `test_AC03_auto_no_policy` red; `<=` in the online rule → `test_AC03_online_boundary` red.

---

## AC-04 Privacy with `team=1`

File `test/suggest.test.ts`, `describe("privacy")`. Bob's `bare` machine `Bm` (inventory `[R_A]`) with
idle step-less session `bs` in `R_A`, name `bench`, labels `["perf"]`. Caller alice, `?team=1`.

| Test | Bob's share | Expected on `byMachine(Bm)` for alice | Fails when |
|---|---|---|---|
| `test_AC04_me_hidden` | `me` | listed; `idle === 0`; no `session` key; `sessionLabels` `[]`; `reason` does not contain `bench` nor `bs`'s sid nor `labelled` | hidden session counted or named |
| `test_AC04_all_visible` (positive control) | `all` | `idle === 1`; `session === bs`; `sessionLabels` `["perf"]`; `reason` contains `bench labelled perf` | visible session not counted |
| `test_AC04_steps_hidden` | `steps` | as `me` | counted |
| `test_AC04_hidden_session_not_repo` | `me`; `Bm` with **no** inventory, only `bs` in `R_A` | not listed without `any`; with `any=1` `repo === false` | hidden session's repo makes `repo` true |
| `test_AC04_hidden_session_repo_all` (control) | same, share `all` | listed, `repo === true` | |
| `test_AC04_step_holder_visible_not_idle` | `me`; `bs` holds `X.s1` | `idle === 0` (holder is visible but not idle); `repo` true via inventory | |
| `test_AC04_own_me_counted` | alice's machine share `me`, idle step-less session in `R_A`, caller alice | `idle === 1`, `session` = that sid | own `me` session hidden |
| `test_AC04_bob_sees_own` | as `test_AC04_me_hidden`, caller bob (no `team`) | `idle === 1`, `session === bs` | owner treated as stranger |

Mutation: skip `sessionVisible` for suggest → `test_AC04_me_hidden` and `test_AC04_hidden_session_not_repo`
red; apply the rule with the machine owner as viewer → `test_AC04_own_me_counted` stays green but
`test_AC04_me_hidden` red; hide own `me` sessions → `test_AC04_own_me_counted` red.

---

## AC-05 `to` and round-trip assign

File `test/suggest.test.ts`, `describe("to")`. Alice: `An` (nickname `lab`), `Au` (no nickname). Bob:
`Bn` (nickname `rig`), `Bu` (no nickname). All have `R_A`. Caller alice, `?team=1`. Fresh ready steps
`G.s1`, `G.t1 … G.t3` (repo `R_A`) so each assign has its own step.

| Test | Expected | Fails when |
|---|---|---|
| `test_AC05_to_values` | `byMachine(An).to === "lab"`; `Au.to === Au.machine`; `Bn.to === "bob/rig"`; `Bu.to === Bu.machine` | hostname used, `bob/` missing, nickname for un-nicknamed |
| `test_AC05_to_clash_user_nickname` | alice names another machine of hers `bob`; suggest again | `Bn.to === Bn.machine` (id, since `bob/rig` could read as her machine `bob`) | `bob/rig` kept |
| `test_AC05_round_trip` | for each of the four suggestions: `POST /v1/steps/<fresh step>/assign {to: s.to}` as alice | 2xx; `step.offer.to.machine === s.machine` for each | an assign lands on another machine or fails |
| `test_AC05_round_trip_goal` | goal `K` with one offerable step; `GET /v1/goals/K/suggest?team=1`; `POST /v1/goals/K/assign {to: first.to}` | offer on that step `.to.machine === first.machine` | |
| `test_AC05_nickname_shared_across_users` | carol names a machine `lab` too (team) | alice's `An.to === "lab"` still resolves to `An` on assign; carol's is `carol/lab` | |

Positive control: `test_AC05_round_trip` asserts each assign succeeded before comparing the target.
Mutation: always use `<user>/<nickname>` even for own machines → `test_AC05_to_values` red; skip the
clash check → `test_AC05_to_clash_user_nickname` red.

---

## AC-06 Reason text

File `test/suggest.test.ts`, `describe("reason")`. Exact string equality (`toBe`).

| Test | Setup | Expected `reason` |
|---|---|---|
| `test_AC06_own_full` | alice's `M` online, `["self"]`, inventory `R_A`, one idle session named `perf-bench` labels `["perf"]`, machine labels `["perf"]`; subject `G.s1` | `auto-accept · online · has alpha · 1 idle session · perf-bench labelled perf · machine labels perf` |
| `test_AC06_other_offline` | bob's `Bm` `["self"]`, inventory `R_A`, no sessions; synced, then `w.clock += 300_000`; alice `?team=1` | `@bob · waits for them to accept · last seen 5m ago · has alpha · no idle session` |
| `test_AC06_any_no_repo` | alice's `N` online, `self`, no inventory; `?any=1` | `auto-accept · online · no alpha · no idle session` |
| `test_AC06_three_idle` | three idle step-less sessions in `R_A`, no labels | `auto-accept · online · has alpha · 3 idle sessions` |
| `test_AC06_empty_repo_step` | goal without `primaryRepo`, step with empty `repo`; one idle step-less session (any repo) | `auto-accept · online · 1 idle session` (no repo part) |
| `test_AC06_two_repos` | goal suggest of `G` (offerable `G.s1` `R_A`, `G.s2` `R_B`); machine with neither, `any=1` | `auto-accept · online · no alpha,beta · no idle session`; machine with both: `… · has alpha,beta · …`; machine with only `R_A`: `… · no beta · …` (only the unmatched) |
| `test_AC06_session_name_fallback` | best session without `name`, repo `R_A`, labels `["perf"]` | contains ` · alpha labelled perf` |
| `test_AC06_labels_joined` | best session labels `["alpha","perf"]`, machine labels `["alpha","perf"]` | ends with `<name> labelled alpha,perf · machine labels alpha,perf` |

Fails when: any character differs (separator, order of parts, plural, `@` prefix, age format).
Positive control: `test_AC06_own_full` contains every optional part, so the shorter strings prove parts
are omitted, not missing.
Mutation: plural `1 idle sessions` → `test_AC06_own_full` red; list all repo names after `no` →
`test_AC06_two_repos` red; `last seen` age in seconds → `test_AC06_other_offline` red; `@` on own
machines → `test_AC06_own_full` red.

---

## AC-07 Goal suggest

File `test/suggest.test.ts`, `describe("goal suggest")`. Goal `G` as in the cast, plus an offered step
`G.s4` (repo `R_Z`, ready, offered by alice to another machine).

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC07_steps_and_repos` | `suggest(alice, "G")` | `target === "G"`; `steps` `toStrictEqual(["G.s1","G.s2"])` (gate `G.g`, blocked `G.s3`, offered `G.s4` excluded); `repos` `toStrictEqual([R_A, R_B])`; `topics` `["perf"]` | `R_Z` in repos, gate listed, order not code-point |
| `test_AC07_repo_requires_all` | machines with `[R_A]`, `[R_A, R_B]`, `[R_B]` | only the `[R_A,R_B]` machine listed; with `any=1` the other two have `repo === false` | `repo` true on any one match |
| `test_AC07_repo_via_sessions` | machine with inventory `[R_A]` and a visible session in `R_B` | `repo === true` | sessions ignored for goals |
| `test_AC07_duplicate_repos` | two offerable steps both `R_A` | `repos` `toStrictEqual([R_A])` | repeats |
| `test_AC07_primary_repo_fallback` | goal `P` with `primaryRepo = R_B` and no offerable step (only a blocked step) | `steps` `[]`; `repos` `[R_B]` | `[]` or a non-offerable step's repo |
| `test_AC07_no_primary` | goal without `primaryRepo`, no offerable steps | `steps` `[]`, `repos` `[]`; every machine of alice listed with `repo === true` | |
| `test_AC07_done_409` | goal marked `done` | 409 `{error: "<G> is done"}`; a `dropped` goal → 409 `<G> is dropped` | 200 or other text |
| `test_AC07_unknown_404` | `GET /v1/goals/NOPE/suggest` | 404 `{error: "no goal NOPE"}` | |

Positive control: `test_AC07_steps_and_repos` lists two steps, so exclusions are not "nothing listed".
Mutation: include offered steps → `test_AC07_steps_and_repos` red; `some` instead of `every` →
`test_AC07_repo_requires_all` red; drop the `primaryRepo` fallback → `test_AC07_primary_repo_fallback` red.

---

## AC-08 Step suggest errors, read-only

File `test/suggest.test.ts`, `describe("step suggest errors")`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC08_unknown` | `GET /v1/steps/G.nope/suggest` | 404 `{error: "no step G.nope"}` | |
| `test_AC08_gate` | `G.g` | 409 `{error: "G.g is a gate: a person decides it"}` | |
| `test_AC08_blocked` | `G.s3` | 409 `{error: "G.s3 is blocked, not ready"}` | |
| `test_AC08_claimed` | `G.s2` after a claim | 409 `` `G.s2 is ${state}, not ready` `` with the state read from `stepOf` | |
| `test_AC08_service_token` | service token | 403 (body not pinned) on both suggest routes | 200 |
| `test_AC08_offered_answers` | `G.s1` with an open offer | 200 `SuggestView` | 409 |
| `test_AC08_read_only` | record `events(w)` and `stepOf` for `G.s1`, `G.s4` and `detailOf(G)`; call both suggest routes 3 times (also with `team`/`any`) | event list identical (same count, same last id); step and goal records `toStrictEqual` before | an event or a changed record |
| `test_AC08_member_ok` | alice's device token and a member cookie/token without a machine | 200 both (positive control for the 403) | |

Mutation: answer a gate with the generic not-ready text → `test_AC08_gate` red; allow service tokens →
`test_AC08_service_token` red; record a `suggest` event → `test_AC08_read_only` red.

---

## AC-09 CLI `mesh assign --suggest`

File `test/suggest.test.ts`, `describe("cli")`, via the `cli` helper (spawns `mesh` with alice's
credentials against the World hub; returns `{code, stdout, stderr}` and the hub request log
`p.requests`/a counting proxy). Setup as AC-01 with two listed machines.

| Test | Command | Expected | Fails when |
|---|---|---|---|
| `test_AC09_lines` | `mesh assign G.s1 --suggest` | exit 0; stdout lines = `["Suggestions for G.s1 (best first):", ...view.suggestions.map((s,i) => \`${i+1}. ${s.to} · ${s.reason}\`), \`Assign with: mesh assign G.s1 --to ${view.suggestions[0].to}\`]` where `view` is the hub's own reply to the same GET | order differs from the hub, wrong numbering, missing hint |
| `test_AC09_goal_route` | `mesh assign G --suggest` | the hub saw `GET /v1/goals/G/suggest` (no step route call); heading `Suggestions for G (best first):`; hint without `--stick` | step route used |
| `test_AC09_goal_stick_hint` | goal `P` with no offerable step | last line `Assign with: mesh assign P --to <first to> --stick` | no `--stick` |
| `test_AC09_flags_reach_hub` | `--team`, `--any`, both | hub saw `?team=1`, `?any=1`, both; the listed machines change as in AC-01 (bob's machine appears with `--team`, B with `--any`); without flags no query string | flag not passed, or `team=0` sent |
| `test_AC09_json` | `--json` | `stdout === JSON.stringify(view, null, 2) + "\n"` (or trimmed equal) where `view` is the hub's reply | other format |
| `test_AC09_none` | goal `N` with a ready step `N.s1` in `R_Z`; `mesh assign N.s1 --suggest` | stdout exactly `No machine to suggest for N.s1; try --team or --any.`, exit 0 | heading printed, exit ≠ 0 |
| `test_AC09_hub_404` | `mesh assign X.s9 --suggest` | stderr `no step X.s9`, exit 1, stdout empty | |
| `test_AC09_old_hub_html` | stub server: every GET → 200 `text/html` `<!doctype html><title>x</title>` | stderr `OLD_HUB`, exit 1, stdout `""` | parse error text, exit 0, or output |
| `test_AC09_old_hub_json` | stub: 200 `{"ok":true}` | same as above | |
| `test_AC09_stub_control` | stub: 200 with a valid `SuggestView` (one suggestion) | exit 0, numbered line printed (proves the stub is reached) | |

Mutation: print suggestions sorted by `to` → `test_AC09_lines` red; always use the step route →
`test_AC09_goal_route` red; drop the `suggestions` check → `test_AC09_old_hub_*` red.

---

## AC-10 CLI usage for `mesh assign`

File `test/cli.test.ts` (no hub; credentials pointing at a closed port or a counting stub so a request
is detectable).

| Test | Args | Expected |
|---|---|---|
| `test_AC10_suggest_with_to` | `assign G --suggest --to m2` | exit 2, stderr `ASSIGN_USAGE` (+ newline) |
| `test_AC10_suggest_with_stick` | `assign G --suggest --stick` | same |
| `test_AC10_suggest_with_note` | `assign G --suggest --note x` | same |
| `test_AC10_team_without_suggest` | `assign G --to m2 --team` and `assign G --team` | same |
| `test_AC10_any_without_suggest` | `assign G --any` | same |
| `test_AC10_json_without_suggest` | `assign G --to m2 --json` | same |
| `test_AC10_neither` | `assign G` | same |
| `test_AC10_no_target` | `assign`, `assign --suggest` | same |
| `test_AC10_no_hub_call` | every case above against the counting stub | stub request count 0 |
| `test_AC10_first_line_mm3` | any case | first stderr line equals the MM-3 usage line exactly |
| `test_AC10_help_lines` | `mesh help` | contains `send a message to a session: mesh say <session> <text>, or <machine>/<session> for another machine`; the `assign` summary line contains `--suggest` |

Positive control: `test_AC09_lines` (valid `--suggest`) and the MM-3 `mesh assign --to` tests in
`test/assign.test.ts` stay green and do reach the hub (stub count > 0 for a valid `--to` call in
`test_AC10_no_hub_call`'s control row).
Mutation: allow `--json` with `--to` → `test_AC10_json_without_suggest` red; print only the MM-3 line →
every usage test red.

---

## AC-11 `POST /v1/messages` with `to`

Unit file `src/protocol/messages.test.ts`; World file `test/suggest.test.ts`, `describe("say to")`.
Alice: person `A1` (nickname `a1`, share `me`) with a session `perf` (pid 100, via `namedSession`), and a
second session `other`. Bob: person `B` (nickname `rig`, share `all`) with session `bench`; a second bob
person `B2` share `me` with session `quiet`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC11_schema_refine` | `MessageRequest.safeParse({text: "x"})` | fails; issue message `toSid, to or toStep is required` | passes |
| `test_AC11_schema_to` | `{to: "a1/perf", text}` ok; `to: ""` fails; `to` of 200 chars ok, 201 fails | as stated | |
| `test_AC11_by_name` | alice `{to: "a1/perf", text: "hi"}` | 201 `{id, toSid: <perf sid>, to: "a1/perf"}`; alice's inbox has a row with that `toSid`, `kind: "say"`, text `hi`; one new `message.sent` event; after `pull(A1)`, `A1.pastes` has a paste to `perf`'s pane containing `hi` | wrong row, no event, no paste |
| `test_AC11_by_sid_prefix` | `to: "a1/<first 6 of other's sid>"` | 201; `toSid` = `other`'s sid; `to === "a1/other"` | |
| `test_AC11_other_user` | alice `{to: "bob/rig/bench"}` | 201; `to === "rig/bench"`; row on B; B pastes | |
| `test_AC11_hostname_display` | target machine without nickname, by id | `to` begins with its hostname | id shown |
| `test_AC11_no_machine` | `to: "x/perf"` | 404 `{error: "no machine x"}` | |
| `test_AC11_no_session` | `to: "a1/nope"` | 404 `{error: "no session nope on a1"}` | |
| `test_AC11_hidden_session` | alice `to: "bob/<B2 nickname>/quiet"` (B2 shares `me`) | 404 `no session quiet on <B2 name>`; no inbox row on B2 | delivered to a hidden session |
| `test_AC11_hidden_control` | bob himself `to: "<B2 nickname>/quiet"` | 201 (owner sees it) | |
| `test_AC11_ambiguous` | two sessions named `dup` on A1 | 409 `{error: "\"dup\" matches several sessions on a1"}` | |
| `test_AC11_machine_only` | `to: "a1"` | 400 `{error: "say needs a session: <machine>/<session>"}` | 201 or 404 |
| `test_AC11_tosid_unchanged` | `{toSid: <perf sid>, text}`; `{toSid, to: "x/y", text}` | 201 both; reply has no `to` key; `toSid` used (the bogus `to` ignored) | `to` present, `to` resolved |
| `test_AC11_tostep_unchanged` | `{toStep: <a held step>, text}` | 201 as before, no `to` key | |
| `test_AC11_neither_400` | `{text}` | 400 | |

Positive control: `test_AC11_by_name` and `test_AC11_hidden_control` show delivery works, so the 404s
are resolution, not a broken route.
Mutation: resolve against all sessions (no visibility) → `test_AC11_hidden_session` red; echo `to`
for `toSid` requests → `test_AC11_tosid_unchanged` red; prefer `to` over `toSid` →
`test_AC11_tosid_unchanged` red; answer machine-only with 404 → `test_AC11_machine_only` red.

---

## AC-12 CLI `mesh say`

File `test/suggest.test.ts` `describe("cli say")` (World hub); local path in `test/m45-cli.test.ts`.
Alice's `A1` (nickname `m2`) has session `perf`.

| Test | Command | Expected | Fails when |
|---|---|---|---|
| `test_AC12_remote_ok` | `mesh say m2/perf hello there` | stdout `SENT("m2/perf")`, exit 0; the hub inbox has a `say` row to `perf`'s sid with text `hello there` (words joined by one space) | |
| `test_AC12_unknown_machine` | `mesh say nope/perf hi` | stderr `no machine nope`, exit 1, stdout empty | |
| `test_AC12_not_logged_in` | empty credentials file location | exit 1; stderr equals the `HubClient.from` error text (the same text another hub command, e.g. `mesh offers`, prints in the same setup) | daemon fallback, other exit |
| `test_AC12_old_hub` | stub hub answering `POST /v1/messages` with 400 `{error: "toSid or toStep is required"}` | stderr `toSid or toStep is required`, exit 1 | |
| `test_AC12_local_unchanged` (`m45-cli`) | `mesh say perf hello` with a test daemon | the daemon's `/local/say` received it; stdout `Delivered.` or `Queued; mesh delivers it as soon as the session can take it.`; no hub `/v1/messages` request | sent to the hub |
| `test_AC12_slash_goes_to_hub` (`m45-cli`) | a local session whose folder ends in `x/perf`; `mesh say x/perf hi` | request went to the hub (`/v1/messages`), not `/local/say` | old local match |
| `test_AC12_usage` | `mesh say`; `mesh say m2/perf` (no text) | exit 2, stderr `SAY_USAGE` | |

Mutation: send the target as `toSid` → `test_AC12_remote_ok` red; keep the local suffix match for
`/` targets → `test_AC12_slash_goes_to_hub` red; print the sid instead of the reply's `to` →
`test_AC12_remote_ok` red.

---

## AC-13 `maxSessions` gates the daemon's launch for an offer

File `test/suggest.test.ts`, `describe("maxSessions")`. Bob's person `B` (nickname `m2`,
`assignments: "launch"`, `accept: ["self"]`, notifications on: World `notify: true`); offers made by bob
from his other machine `B2` (`self` → auto) to `m2` with `autoOffer`. Live sessions on B: `w.hook(B,
"SessionStart", pid)` then `UserPromptSubmit` (working, so no idle session in the repo and MM-3 goes to
the launch path). Each offer uses a fresh ready step. The fake `launchStep` records `B.launches`.

| Test | Setup / stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC13_at_limit_no_launch` | `maxSessions: 2`, 2 live; one offer; `pull(B)` | `B.launches` `[]`; `B.logs` contains `NOT_STARTING(step, 2, 2)`; `B.acks` has one ack for the message: `delivered`, method `listed`; `B.notes` has one MM-3 offer notification naming the step; the hub offer stays `offered` | a launch, other ack, no note |
| `test_AC13_under_limit_launches` (control) | `maxSessions: 3`, 2 live; one offer | one launch `{repo, step}` | none |
| `test_AC13_concurrent_offers` | `maxSessions: 2`, 1 live; two offers created before one `pull(B)` | `B.launches.length === 1`; exactly one ack with method `listed` among the two message ids | 2 launches or 0 |
| `test_AC13_pending_counts_before_expiry` | `maxSessions: 2`, 1 live; offer 1 → launch (session never appears); `w.clock += 60_000`; offer 2 | still 1 launch; offer 2 acked `listed` | second launch |
| `test_AC13_pending_expires` | continue: `w.clock` = launch time + 121_000; offer 3 | exactly 2 launches (offer 3 launched) | still blocked |
| `test_AC13_no_double_count` | `maxSessions: 3`, 1 live; offer 1 → launch; `w.hook(B, "SessionStart", pid2, {}, {step: <offer 1 step>})`, `w.flush()` until the hub shows the step held by that sid; offer 2 | 2 launches (live = 2: the started session counted once) | launch refused (pending + session both counted) |
| `test_AC13_failed_launch_not_counted` | `maxSessions: 2`, 1 live; `B.launchResult = {ok: false}`; offer 1 → 1 call; reset `launchResult`; offer 2 | 2 calls | second refused |
| `test_AC13_ended_not_counted` | `maxSessions: 2`, 2 sessions, one ended (`SessionEnd`, flush) | offer launches | ended counted |
| `test_AC13_any_session_counts` | `maxSessions: 2`, 1 working session + 1 idle session in **another** repo (not a candidate) | no launch, `listed` | only same-repo sessions counted |
| `test_AC13_absent_no_limit` | no `maxSessions`, 5 live; three offers | 3 launches | a default limit |
| `test_AC13_accept_launch_not_gated` (`test/m45-cli.test.ts`, scope guard) | `maxSessions: 1`, 1 live; `mesh accept <step> --launch` | the fake runner starts `mesh run` | gated |

Positive control: `test_AC13_under_limit_launches`, `test_AC13_absent_no_limit` and the expiry/double-
count tests show `launchStep` is reachable in the same setup.
Mutation: compare `>` instead of `≥` → `test_AC13_at_limit_no_launch` red; decide each offer of a pull
from the count before the pull → `test_AC13_concurrent_offers` red; never expire pending launches →
`test_AC13_pending_expires` red; count pending launches without dropping them when the session appears
→ `test_AC13_no_double_count` red; count a `{ok: false}` launch → `test_AC13_failed_launch_not_counted`
red; count only sessions in the step's repo → `test_AC13_any_session_counts` red.

---

## AC-14 `maxSessions` config and `mesh setup --max-sessions`

Unit `src/protocol/config.test.ts` `describe("maxSessions")`; CLI `test/cli.test.ts` (temp `MESH_HOME`
with a `daemon.json`).

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC14_parse_absent` | `DaemonConfig.parse(MM-3 daemon.json fixture)` | no `maxSessions` key; every other field equal to the MM-3 parse | default added |
| `test_AC14_parse_values` | `1`, `1000`, `3` ok; `0`, `1001`, `2.5`, `"3"`, `-1` fail | as stated | bounds off by one, non-integers |
| `test_AC14_setup_n` | `mesh setup --max-sessions 3` | `daemon.json` has `maxSessions: 3`, other keys unchanged; stdout contains `MAX_ON(3)`; exit 0 | |
| `test_AC14_setup_off` | after the above, `--max-sessions off` | key absent; stdout contains `MAX_OFF`; exit 0 | `null` or `0` written |
| `test_AC14_setup_bad` | `x`, `0`, `1001`, `2.5`, no value | each exit 2, stderr `MAX_BAD`; `daemon.json` byte-identical | written anyway |
| `test_AC14_setup_bounds_ok` | `1`, `1000` | written | |
| `test_AC14_setup_without_flag_keeps` | `maxSessions: 4` present; `mesh setup --share me` | `maxSessions` still 4 | removed |

Mutation: `.max(999)` → `test_AC14_parse_values` red; write `maxSessions: null` for `off` →
`test_AC14_setup_off` red; rewrite the config from defaults on any setup → `test_AC14_setup_without_flag_keeps` red.

---

## AC-15 Web step Assign (Playwright)

File `test/e2e-web/goals.spec.ts`, `test("test_AC15_step_assign_picker")` and siblings. Setup through
`request` to the e2e hub (tokens from `test/e2e-web/hub.yaml`): goal with a ready step in a repo with a
unique per-run id ending in `/alpha-<rand>` (the e2e hub is shared); bob's machine via login + `POST
/v1/sync` (inventory that repo, share `me`, `accept: ["self"]`) and a unique nickname; alice's machine
with the same repo. Signed in as bob.

| Test | Steps | Expected | Fails when |
|---|---|---|---|
| `test_AC15_step_assign_picker` | open the goal page, select the step, click `Assign step` | `getByLabel("assign picker")` visible; checkboxes `Team machines` and `Without the repo` unchecked; `li.suggestion[data-machine=<bob machine id>]` with `strong.to` and `span.reason` equal to the hub's `GET /v1/steps/<id>/suggest` reply for that machine | missing picker/row, text differs |
| `test_AC15_assign_click` | click `Assign to <to>` in that row | picker hidden; `p.assigned` text starts `Offered <step> to <to> (` (equals `assignText(...)` joined, computed in the test from the hub reply); within 20 s the step panel shows `p.offer`; hub `GET` step has `offer.state === "offered"`, `offer.to.machine` = bob's id; `Assign step` no longer visible for that step | |
| `test_AC15_team_checkbox` | reopen on a second ready step; check `Team machines` | a row `li.suggestion[data-machine=<alice machine id>]` appears; unchecked before → absent | no refetch |
| `test_AC15_any_checkbox` | bob machine without the repo exists; check `Without the repo` | its row appears | |
| `test_AC15_assign_error` | make the step not ready (claim it via API) after the picker opens; click `Assign to …` | `p.error` with the hub's text; picker still open | picker closes |

Mutation: render suggestions without `data-machine` → all red; skip the refetch on checkbox change →
`test_AC15_team_checkbox` red; close the picker on error → `test_AC15_assign_error` red.

---

## AC-16 Web goal Assign, visibility and empty list (Playwright)

File `test/e2e-web/goals.spec.ts`.

| Test | Steps | Expected | Fails when |
|---|---|---|---|
| `test_AC16_goal_assign` | goal with one offerable step; header button `Assign goal` | picker opens; the page requested `GET /v1/goals/<G>/suggest` (`page.waitForRequest`); `Assign to <to>` → hub step `<G>.<s>` has `offer.state "offered"` to that machine | step route used, no offer |
| `test_AC16_no_goal_button` | goal whose only ready step is a gate, and a goal with a blocked step only; a `done` goal | no `Assign goal` button | shown |
| `test_AC16_no_step_button` | select the gate step; select a blocked step; select an offered step | no `Assign step` in the step panel; control: a ready step shows it | shown |
| `test_AC16_empty_list` | ready step in a unique repo nobody has | `p.empty` text `No machine to suggest.`; no `li.suggestion` | |
| `test_AC16_cancel` | open picker, click `Cancel` | `assign picker` hidden; no offer on the step (hub check) | |

Mutation: show `Assign goal` for any open goal → `test_AC16_no_goal_button` red; use the step route
from the goal button → `test_AC16_goal_assign` red.

---

## AC-17 OpenAPI and route table

File `test/schemas.test.ts`.

| Test | Expected | Fails when |
|---|---|---|
| `test_AC17_openapi_fresh` | the generated document (same generator as `pnpm schemas`) equals `schemas/hub-api.openapi.json` | stale file |
| `test_AC17_suggest_paths` | paths `/v1/steps/{id}/suggest` (tag `steps`) and `/v1/goals/{id}/suggest` (tag `goals`) with `get`, query parameters `team` and `any` | missing |
| `test_AC17_message_to` | `MessageRequest` schema has property `to` (string, maxLength 200) | missing |
| `test_AC17_hub_api_matches_app` | the existing HUB_API ↔ app route comparison includes both routes, rule `member`, no scope | mismatch |

Mutation: remove one route from `HUB_API` → `test_AC17_suggest_paths` red.

---

## AC-18 Docs and skill

File `test/schemas.test.ts` (text checks) plus review.

| Test | Expected |
|---|---|
| `test_AC18_skill_equals_file` (existing skill test) | `MESH_SKILL === skills/mesh/SKILL.md` |
| `test_AC18_skill_rows` | `MESH_SKILL` contains `mesh assign <goal|step> --suggest` and `mesh say <machine>/<session>` |
| `test_AC18_docs_mentions` | `docs/guide/concepts.md` contains `Suggest` and `maxSessions`; `docs/guide/howto.md` contains `--suggest`, `Assign` and `mesh say`; `docs/guide/install.md` contains `maxSessions` and `--max-sessions`; `docs/plan/implementation-plan.md` contains `/v1/steps/:id/suggest` and `/v1/goals/:id/suggest` and `v0.1.12` |

Review (not automated): the concepts text states the rank order, the `--team` visibility limit and what
a member learns about a teammate's machine; the how-to has a sample output; the plan's messages row
mentions `to`.
Mutation: drop the skill row → `test_AC18_skill_rows` red.

---

## AC-19 Checks

Run: `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm build` (= `pnpm check`), then
`pnpm test:web`. Review only: `package.json` version 0.1.12. Fails when any command exits non-zero.

---

## Coverage

| Criterion | Tests |
|---|---|
| AC-01 | `test_AC01_*` (6) |
| AC-02 | `test_AC02_*` (9) |
| AC-03 | `test_AC03_*` (15) |
| AC-04 | `test_AC04_*` (8) |
| AC-05 | `test_AC05_*` (5) |
| AC-06 | `test_AC06_*` (8) |
| AC-07 | `test_AC07_*` (8) |
| AC-08 | `test_AC08_*` (8) |
| AC-09 | `test_AC09_*` (10) |
| AC-10 | `test_AC10_*` (11) |
| AC-11 | `test_AC11_*` (15) |
| AC-12 | `test_AC12_*` (7) |
| AC-13 | `test_AC13_*` (11) |
| AC-14 | `test_AC14_*` (7) |
| AC-15 | `test_AC15_*` (5, Playwright) |
| AC-16 | `test_AC16_*` (5, Playwright) |
| AC-17 | `test_AC17_*` (4) |
| AC-18 | `test_AC18_*` (3) + review |
| AC-19 | commands + review |

Not covered black-box: a `launching` session counted in the `maxSessions` live count (a World daemon
cannot create one without `mesh run`; the count rule is covered by `test_AC13_any_session_counts` and
`test_AC13_ended_not_counted`).

## Open questions (test side)

- (2026-11-11) The pending-launch window is "at most 120 000 ms"; the exact boundary is not pinned, so
  the tests use 60 000 (still counted) and 121 000 (expired) and never assert at 120 000.
- (2026-11-11) `bare` machines set their accept policy through the MM-3 sync field; if MM-3 carries
  the policy only from a daemon, the AC-02/AC-03 helpers use `w.person` + `w.restart(p, {accept})` instead
  (same assertions).
- (2026-11-11) The age format for 300 000 ms is taken from the spec's example (`5m`); if `age` in
  `src/core/fleet.ts` prints another form, the test follows the spec text and the mismatch is a defect.
- (2026-11-11) A plan step with an empty `repo` (AC-06 `test_AC06_empty_repo_step`) assumes the plan API
  accepts it on a goal without `primaryRepo`; if it refuses, that case is tested through goal suggest
  with no offerable steps and no `primaryRepo` (AC-07 `test_AC07_no_primary`), which has `repos: []` too.
- (2026-11-11) The ack method of a launched offer is MM-3's; AC-13 asserts only the `listed` acks and the
  launch count.
- These are recorded here rather than in the spec: this step commits the test plan only.
