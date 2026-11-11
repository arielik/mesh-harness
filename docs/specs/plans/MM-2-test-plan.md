# Test plan MM-2: Labels (what a session or machine is for)

Spec: `docs/specs/MM-2.md` (revision 1, approved in `docs/specs/reviews/MM-2/r1-approved.md`).

Inputs read: `docs/specs/MM-2.md` (interface contracts, acceptance criteria, open questions); the
format of `docs/specs/plans/MM-1-test-plan.md`; the file names of existing tests under `test/` and
`src/**/*.test.ts`; the public signatures of the test helpers `test/helpers/world.ts` (`start`,
`login`, `person`, `restart`, `stop`, `hook`, `tool`, `session`, `turn`, `flush`, `machineOf`,
`syncBodies`, `stopHub`, `startHubAgain`, the `Person` and `PersonOptions` types) and
`test/helpers/git-tree.ts` (`fakeCheckout`, `fakeWorktree`).
Not read: `docs/specs/plans/MM-2-impl-plan.md` (the implementation plan); any implementation source of
this row or of the code it changes (protocol, hub, store, daemon, CLI, TUI, web, `src/core`).

Planned black-box from the contracts. Every negative assertion has a positive control in the same
test or a named sibling, so a test cannot pass because nothing happened. Each criterion names at
least one mutation of the implementation that must turn one of its tests red; the implementer or
reviewer applies it once by hand, confirms red, and reverts.

## Surfaces and files

| Surface | File | New or extended |
|---|---|---|
| unit, protocol (`parseLabels`, `Label`, `Session.labels`) | `src/protocol/labels.test.ts` | new |
| unit, hub link (`sessionMetadata`, `syncedSessions`) | `src/daemon/hub-link.test.ts` | extended |
| daemon local API (real `Daemon`, temp store, temp checkouts) | `src/daemon/daemon.test.ts` | extended (new `describe("labels")`) |
| unit, daemon store (`checkoutLabels`, `setCheckoutLabels`) | `src/store/store.test.ts` | extended |
| store contract (SQLite always, Postgres when its URL is set) | `src/store/hub-store.contract.test.ts` | extended |
| unit, render and filter | `src/core/fleet.test.ts` | extended |
| TUI render | `src/cli/tui/render.test.ts` | extended |
| World (real hub + daemons over HTTP), CLI and MCP against it | `test/labels.test.ts` | new |
| CLI `mesh run --label` (fake runner, test daemon) | `test/m45-cli.test.ts` | extended |
| CLI usage / help (no daemon) | `test/cli.test.ts` | extended |
| schemas, route table, skill, docs, version | `test/schemas.test.ts` | extended |
| Playwright | `test/e2e-web/mine.spec.ts` | extended (`pnpm test:web`, not part of `pnpm check`) |

Common fixtures:
- `checkout(root, name, agentYaml?)`: `fakeCheckout` in a temp dir, plus `.mesh/agent.yaml` with the
  given text when passed; removed in `afterEach`. `worktreeOf(checkout)`: `fakeWorktree` of it.
- `hookAt(daemon, cwd, pid)`: a `SessionStart` hook for a new session whose cwd is `cwd`; the test
  then reads `GET /local/sessions` and finds the session by pid.
- `topicsHub(names)`: a fake `fetch` for the daemon's hub link answering `GET /v1/topics` with the
  given names and recording every request (used in daemon tests that need `unknown`).
- `view(now, machines)` in `src/core/fleet.test.ts` (MM-1 fixture), extended so machines and sessions
  may carry `labels`.
- `L(n)`: `n` distinct valid labels `l01 … lnn`.

Shared constants (copied from the spec, not imported, so a changed text turns tests red):
- `RULE = "a label is 1-40 characters: lowercase letters, digits, '.', '_' or '-', starting with a letter or digit"`
- `NOT_TOPIC = (l) => \`not a topic: ${l}; mesh topic add ${l}\``

---

## AC-01 `parseLabels`, `Label`, `Session.labels`

File `src/protocol/labels.test.ts`.

| Test | Setup / stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC01_string_split_trim_lower_dedupe_sort` | `parseLabels("Perf, gpu,perf")` | `toStrictEqual({labels: ["gpu","perf"]})` | not lowercased, not trimmed, repeat kept, unsorted, or extra keys |
| `test_AC01_array_input_sorted` | `parseLabels(["b","a"])` | `{labels: ["a","b"]}` | array not accepted or not sorted |
| `test_AC01_empty_inputs` | `parseLabels("")`, `parseLabels(" , ")`, `parseLabels([])` | each `{labels: []}` | an error, or `[""]` |
| `test_AC01_invalid_item_error_text` | `parseLabels("a b")` | `{error: "not a label: a b (" + RULE + ")"}`; also `LABEL_RULE === RULE` | other text, item not trimmed-as-given, or accepted |
| `test_AC01_leading_dash_rejected` | `parseLabels("-x")`; `parseLabels(["ok","-x","_y"])` | error contains `not a label: -x (`; the second names `-x` (the first bad item) | accepted, or names `_y` |
| `test_AC01_max_10` | `parseLabels(L(10))`, `parseLabels(L(11))`, `parseLabels([...L(10), "l01", "L01"])` | 10 → ok (10 items); 11 → `{error: "at most 10 labels"}`; the duplicated list → ok (repeats do not count); `MAX_LABELS === 10` | limit off by one, or duplicates counted |
| `test_AC01_length_40_41` | `"a".repeat(40)`, `"a".repeat(41)` | 40 → ok; 41 → error with `not a label:` | 40 rejected or 41 accepted |
| `test_AC01_allowed_chars_and_all` | `parseLabels("a.b,c_d,e-f,9x,all")` | `{labels: ["9x","a.b","all","c_d","e-f"]}` (code-point order) | any refused, `all` special-cased, locale sort |
| `test_AC01_Label_schema` | `Label.safeParse` of `"gpu"`, `"GPU"`, `"a b"`, `""` | only `"gpu"` succeeds; the failure message is `RULE` | uppercase accepted (schema lowercases), empty accepted |
| `test_AC01_Session_labels_field` | `Session.parse({...minimalSession, labels: L(10)})`; `safeParse` with `L(11)`, `["bad label"]`, `["Gpu"]`; minimal session without labels | 10 parses; the three others fail; without labels the parsed object has no `labels` key | 11, invalid or uppercase accepted, or a default `[]` added |

Positive control: `test_AC01_max_10` (10 ok) and `test_AC01_length_40_41` (40 ok) prove the
rejections are about the limit, not a parser that rejects everything; `test_AC01_Label_schema` accepts
`gpu`.
Mutation: change the regex quantifier to `{0,40}` → `test_AC01_length_40_41` red; drop `.toLowerCase()`
→ `test_AC01_string_split_trim_lower_dedupe_sort` red; count before de-duplication →
`test_AC01_max_10` red; add `.default([])` to `Session.labels` → `test_AC01_Session_labels_field` red.

---

## AC-02 `sessionMetadata` and `syncedSessions` carry labels

File `src/daemon/hub-link.test.ts`.

| Test | Setup / stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC02_metadata_copies_labels` | full session with `labels: ["perf"]`, `pid`, `pane`, `transcriptPath`, `lastMessage`, `cwd: "/x"` → `sessionMetadata(s)` | `labels` `toStrictEqual(["perf"])`; `"pid" in m`, `"pane" in m`, `"transcriptPath" in m`, `"lastMessage" in m` all false; `m.cwd === ""` | labels dropped, or any private field present |
| `test_AC02_metadata_no_labels_no_key` | same session without `labels` | `Object.hasOwn(m, "labels") === false` | `labels: []` or `labels: undefined` key present |
| `test_AC02_synced_me_carries_labels` | `syncedSessions([holder{step, labels:["a"]}, free{labels:["b"]}, plain{}], "me")` | holder record has `labels: ["a"]`; free has `labels: ["b"]`; plain has no `labels` key | either labelled record lost labels, or plain has the key |
| `test_AC02_synced_steps_drops_free` | same list, `"steps"` | only the holder is sent, with `labels: ["a"]` | a no-step session sent under `steps` |

Positive control: `test_AC02_metadata_copies_labels` shows the key appears when labels exist, so the
no-key test cannot pass on a function that never copies labels.
Mutation: `labels: s.labels ?? []` in `sessionMetadata` → `test_AC02_metadata_no_labels_no_key` red;
omit `labels` from the copy → `test_AC02_metadata_copies_labels` red.

---

## AC-03 Repo default from `.mesh/agent.yaml`

File `src/daemon/daemon.test.ts`, `describe("labels")`. Each case is its own temp checkout.

| Test | Setup / stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC03_repo_default_at_top` | checkout with `labels: [Perf, dataplane]`; `hookAt(top)` | session `labels` `toStrictEqual(["dataplane","perf"])` | other or unsorted labels, session missing |
| `test_AC03_repo_default_from_subfolder` | same checkout; `hookAt(top/a/b)` | `["dataplane","perf"]` | the file looked up only in the cwd |
| `test_AC03_other_keys_ignored` | file `labels: [x]\nowner: someone\n` | `["x"]` | an unknown key makes it fail |
| `test_AC03_no_file` | checkout without `.mesh/agent.yaml` | session recorded, no `labels` key | a `labels` key, or not recorded |
| `test_AC03_invalid_yaml` | file `labels: [a,\n` | session recorded, no `labels` key; the daemon log (spy) has one line containing the file path | key present, crash, session missing, or no log line |
| `test_AC03_labels_not_a_list` | file `labels: "x"` | recorded, no `labels` key, one log line | `"x"` taken as a label |
| `test_AC03_bad_label_in_file` | file `labels: ["bad label"]` | recorded, no `labels` key, one log line | partial list `[]`, or bad label stored |
| `test_AC03_too_many_in_file` | file with 11 labels | recorded, no `labels` key | first 10 kept |
| `test_AC03_not_a_checkout` | temp dir with `.mesh/agent.yaml` but no `.git` above it, `hookAt(dir)` | no `labels` key | file read outside a checkout |

Positive control: `test_AC03_repo_default_at_top`, in the same `describe`, proves the file is read, so
the failure cases cannot pass on a daemon that ignores the file. Every failure case also asserts the
session is listed (status, pid) so "not recorded" is caught.
Mutation: read `.mesh/agent.yaml` from the cwd instead of the checkout top →
`test_AC03_repo_default_from_subfolder` red; on a `parseLabels` error store `[]` →
`test_AC03_bad_label_in_file` red; skip the sort → `test_AC03_repo_default_at_top` red.

---

## AC-04 Remembered labels per checkout

Files `src/daemon/daemon.test.ts` (`describe("labels")`) and `src/store/store.test.ts`.

| Test | Setup / stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC04_store_checkoutLabels_roundtrip` (store.test) | new store: `checkoutLabels("/k")`; `setCheckoutLabels("/k", ["a"])`; then `setCheckoutLabels("/k", [])`; reopen the store file | `undefined`; then `["a"]`; then `[]` (not `undefined`); after reopen `[]` | `undefined` and `[]` conflated, or lost on reopen |
| `test_AC04_cwd_answer_is_checkout_top` | checkout C with file `[perf]`; `POST /local/labels {cwd: C/sub, labels: ["GPU"]}` | 200, body `cwd === C` (absolute), `labels` `["gpu"]` | cwd echoed as given, labels not normalised |
| `test_AC04_cwd_outside_checkout_key_is_cwd` | plain temp dir D (no `.git`); `{cwd: D, labels: ["a"]}` | 200, `cwd === D` | a parent dir chosen |
| `test_AC04_new_session_gets_remembered` | after the call above, `hookAt(C/other)` | `labels: ["gpu"]` (file says `[perf]`) | `["perf"]`, or the union `["gpu","perf"]` |
| `test_AC04_launch_placeholder_gets_remembered` | after the call, `POST /local/launch` for a placeholder in C; then its first hook | placeholder `labels: ["gpu"]`; the adopted session still `["gpu"]` | placeholder without labels, or labels lost on adoption |
| `test_AC04_worktree_is_own_checkout` | `W = worktreeOf(C)` with its own file `[wt]`; remember `["gpu"]` for C; `hookAt(W)` | `labels: ["wt"]` | `["gpu"]` (worktree inherits) |
| `test_AC04_live_session_keeps_labels` | session S live in C with `["perf"]` (from the file); then remember `["gpu"]` for C | `S` still `["perf"]` | the live session changed |
| `test_AC04_empty_remembered_beats_file` | remember `[]` for C; `hookAt(C)` | new session has no `labels` key | `["perf"]` (empty treated as "none remembered") |
| `test_AC04_survives_restart` | remember `["gpu"]` for C; close the daemon; open a new `Daemon` on the same store file; `hookAt(C)` | `["gpu"]` | `["perf"]` after restart |
| `test_AC04_no_session_change` | live sessions in C before and after `{cwd}` call | `GET /local/sessions` sessions deep-equal before/after | any session touched |

Positive control: `test_AC04_live_session_keeps_labels` first asserts S had `["perf"]` (so the file
path works); `test_AC04_worktree_is_own_checkout` asserts that a hook in C after the same call does get
`["gpu"]`.
Mutation: key the memory by repo id instead of checkout path → `test_AC04_worktree_is_own_checkout`
red; keep the memory only in RAM → `test_AC04_survives_restart` red; `if (remembered?.length)` instead
of `!== undefined` → `test_AC04_empty_remembered_beats_file` red; merge remembered with file →
`test_AC04_new_session_gets_remembered` red.

---

## AC-05 `POST /local/labels` with a target

File `src/daemon/daemon.test.ts`, `describe("labels")`. Two live sessions S1, S2 in checkout C
(file `[perf]`), S1 named `s1`.

| Test | Setup / stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC05_set_add_rm_sequence` | `{target:"s1", labels:["b","a"], mode:"set"}`; then `add ["c"]`; then `rm ["a","x"]` | `session.labels` `["a","b"]`, `["a","b","c"]`, `["b","c"]`; each 200; `GET /local/sessions` agrees | any list differs, `rm` of unknown `x` fails |
| `test_AC05_set_empty_removes_key` | `set []` | reply session and listed session have no `labels` key | `labels: []` |
| `test_AC05_add_normalises` | `add ["Z "]` | `"z"` in the list | not normalised |
| `test_AC05_remembered_for_checkout` | after `set ["b","a"]`, `hookAt(C)` | the new session has `["a","b"]` | not remembered (gets `["perf"]`) |
| `test_AC05_other_session_unchanged` | after the sequence | S2 still `["perf"]` | S2 changed |
| `test_AC05_unknown_target_404` | `{target:"nope", labels:["a"], mode:"set"}` | 404, `{error: "no live session matches \"nope\""}` | other status/text |
| `test_AC05_eleven_refused_nothing_changes` | S1 at 10 labels (`set L(10)`); `add ["zz"]`; then `hookAt(C)` | 400 `{error:"at most 10 labels"}`; S1 still `L(10)`; the new session gets `L(10)` (memory not overwritten) | 200, or partial change, or memory changed |
| `test_AC05_invalid_label_400` | `set ["bad label"]` | 400 `{error: "not a label: bad label (" + RULE + ")"}`; S1 unchanged | other text, or changed |
| `test_AC05_bad_body_400` | `{labels:["a"]}`; `{target:"s1", labels:["a"]}`; `{target:"s1", labels:["a"], mode:"merge"}` | each 400 `{error: "expected {target, labels, mode: set|add|rm} or {cwd, labels}"}` | other text, or a mode defaulted |
| `test_AC05_client_methods` | `DaemonClient.labels("s1", ["q"], "set")` and `DaemonClient.rememberLabels(C, ["r"])` against the daemon | resolve with `{session}` (labels `["q"]`) and `{cwd: C, labels: ["r"]}`; a 404 rejects with the error text | wrong route/body shape |

Positive control: `test_AC05_set_add_rm_sequence` shows changes do land, so "nothing changes" in the
refusal tests is meaningful; the refusal tests read the list before the call and assert it equals the
list after.
Mutation: check the 10-limit after storing → `test_AC05_eleven_refused_nothing_changes` red; `rm`
implemented as `set` → `test_AC05_set_add_rm_sequence` red; apply to every session of the checkout →
`test_AC05_other_session_unchanged` red.

---

## AC-06 `unknown` (labels that are not topics)

File `test/labels.test.ts` (World: hub with topic `perf`; bob logged in) and `src/daemon/daemon.test.ts`
(no credentials).

| Test | Setup / stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC06_unknown_lists_undefined_topics` | hub topics `perf`; bob's session; `POST /local/labels {target, labels:["perf","gpu"], mode:"set"}` | `unknown` `toStrictEqual(["gpu"])` | other list, or `perf` listed |
| `test_AC06_all_defined_empty_array` | topics `perf`, `gpu`; same call | `unknown` `toStrictEqual([])` (key present) | key absent, or non-empty |
| `test_AC06_cwd_form_has_unknown` | `{cwd, labels:["gpu"]}` with topics `perf` | `unknown: ["gpu"]` | cwd form omits it |
| `test_AC06_sorted` | labels `["zz","aa","perf"]`, topics `perf` | `["aa","zz"]` | unsorted |
| `test_AC06_no_hub_no_key` (daemon.test) | daemon without credentials, no Solo hub; `set ["gpu"]` | 200, no `unknown` key; session has `["gpu"]` | call fails, or `unknown` present |
| `test_AC06_hub_offline_no_key` | World, `p.offline = true` (or `stopHub`) | 200, no `unknown` key, labels set | call fails or hangs past the test timeout |

Positive control: `test_AC06_unknown_lists_undefined_topics` shows the key is filled when a hub
answers, so the no-hub test cannot pass on a daemon that never sends `unknown`.
Mutation: return `unknown: []` on hub error → `test_AC06_no_hub_no_key` red; compare against labels
instead of topics (inverted) → `test_AC06_unknown_lists_undefined_topics` red.

---

## AC-07 Session labels reach the hub

File `test/labels.test.ts` (World; alice and bob; bob's machine shares `me`; a second bob machine
with `steps`).

| Test | Setup / stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC07_no_step_session_labels_in_my_views` | bob no-step session; `POST /local/labels set ["perf"]`; `w.flush()` | bob's `GET /v1/fleet` session and `GET /v1/live` session have `labels: ["perf"]` | missing |
| `test_AC07_relabel_not_stale` | then `set ["gpu"]`, flush | both views `["gpu"]` | `["perf"]` still shown |
| `test_AC07_alice_still_cannot_see` | alice's `GET /v1/live` | bob's no-step session absent (positive control: bob's own `/v1/live` lists it in the same test) | visible to alice |
| `test_AC07_step_holder_labels_visible_to_others` | bob claims a step in a session, labels it `["dataplane"]`, flush | alice's `/v1/live` lists it with `labels: ["dataplane"]` | missing |
| `test_AC07_unlabelled_no_key` | another bob session without labels | no `labels` key in fleet or live (`Object.hasOwn`) | `labels: []` or `null` |
| `test_AC07_clear_removes_key_on_hub` | `set []` on the labelled session, flush | no `labels` key in both views | stale labels or `[]` |
| `test_AC07_steps_machine_keeps_free_sessions_off` | bob's `steps` machine, no-step session labelled `["x"]`, flush | the session is absent from bob's fleet and live; `w.syncBodies(p)` contain no record with that sid (positive control: a step holder on the same machine is present) | the session or its labels on the hub |

Mutation: drop `labels` from the hub's live/fleet session mapping →
`test_AC07_no_step_session_labels_in_my_views` red; do not mark the session dirty on a label change
(no re-sync) → `test_AC07_relabel_not_stale` red.

---

## AC-08 Hub store machine labels

File `src/store/hub-store.contract.test.ts` (runs on SQLite; on Postgres when its URL is set).

| Test | Setup / stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC08_schema_version_6` | `HubStore.SCHEMA_VERSION` (and the migrated store's recorded version) | `6` | changed |
| `test_AC08_set_and_get` | machine M; `setMachineLabels(M, ["gpu","perf"])`; `getMachine(M)` | `labels` `toStrictEqual(["gpu","perf"])` | missing |
| `test_AC08_clear_restores_row` | `before = getMachine(M)`; set `["gpu"]`; set `[]`; `after = getMachine(M)` | `after` `toStrictEqual(before)` (no `labels` key) | `labels: []`/`null` left |
| `test_AC08_keeps_other_fields` | M with `repos`, `reposAt`, `share`, `nickname` set; `setMachineLabels(M, ["a"])` | those four unchanged | any lost |
| `test_AC08_touch_keeps_labels` | labels `["a"]`; `touchMachine(...)` with new `repos` facts | `labels` still `["a"]`, `repos` new | labels wiped by the sync |
| `test_AC08_unknown_id_noop` | `setMachineLabels("nope", ["a"])` | resolves; `getMachine("nope")` undefined; machine list length unchanged | throws, or a row created |
| `test_AC08_replace_not_merge` | set `["a","b"]`, then `["c"]` | `["c"]` | merged |

Positive control: `test_AC08_set_and_get` before the clearing test; `test_AC08_touch_keeps_labels`
asserts `repos` did change (so the touch ran).
Mutation: `touchMachine` rewrites the whole row from facts → `test_AC08_touch_keeps_labels` red; store
`[]` instead of deleting → `test_AC08_clear_restores_row` red; upsert on unknown id →
`test_AC08_unknown_id_noop` red.

---

## AC-09 `POST /v1/machines/:id/labels`

File `test/labels.test.ts` (World; alice, bob, admin; topics `gpu` defined, `perf-lab` not; bob's
machine M with nickname `lab`).

| Test | Setup / stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC09_replace` | bob `{labels:["Perf-Lab","gpu"]}` | 200 `toStrictEqual({id:M, hostname, nickname:"lab", labels:["gpu","perf-lab"], unknown:["perf-lab"]})` | other body |
| `test_AC09_no_nickname_no_key` | machine without nickname | body has no `nickname` key | `nickname: undefined/null` |
| `test_AC09_add_remove` | `{add:["x"]}` → `["gpu","perf-lab","x"]`; `{remove:["gpu"]}` → `["perf-lab","x"]`; `{add:["y"], remove:["x"]}` → `["perf-lab","y"]` | as listed | any differs |
| `test_AC09_clear` | `{labels: []}` | 200 `labels: []`, `unknown: []` | refused |
| `test_AC09_empty_bodies_400` | `{}`, `{add:[], remove:[]}`, `{labels:"x"}`, `{labels:[...21 items]}` | each 400 | 200 |
| `test_AC09_bad_label_400` | `{labels:["bad label"]}` | 400 `{error: "not a label: bad label (" + RULE + ")"}`; list unchanged | other text |
| `test_AC09_eleven_400_unchanged` | `{labels: L(11)}`; then set `L(10)` and `{add:["zz"]}` | each 400 `{error:"at most 10 labels"}`; list after equals list before | changed |
| `test_AC09_unknown_machine_404` | `/v1/machines/nope/labels` | 404 `{error:"no machine nope"}` | other |
| `test_AC09_other_user_403_also_admin` | alice and admin on bob's M | 403 `{error:"not your machine"}`; list unchanged | 200 for admin |
| `test_AC09_service_token_403` | a `live:read` service token | 403; list unchanged | 200 |
| `test_AC09_unknown_exact` | topics `gpu`; labels `["gpu","perf-lab","zeta"]` | `unknown: ["perf-lab","zeta"]` | other |
| `test_AC09_event_and_activity` | set `["gpu","perf-lab"]`; read events; bob's `/v1/live` activity | one `machine.labelled`, user bob, payload `toStrictEqual({machine:M, labels:["gpu","perf-lab"]})`; activity text `labelled machine <hostname> gpu, perf-lab`; an SSE subscriber gets `changed` | missing or other text |
| `test_AC09_clear_activity` | then `{labels: []}` | event payload `labels: []`; activity `cleared the labels of machine <hostname>` | other text |
| `test_AC09_no_change_no_event` | repeat the same set; `{remove:["absent"]}` | 200; event count unchanged (positive control: the first set added one) | an event |
| `test_AC09_concurrent_adds` | `Promise.all([{add:["a"]}, {add:["b"]}])`, repeated 5 times with fresh labels; SQLite and Postgres (the Postgres run when its URL is set) | final list contains both of each pair | one lost |

Mutation: read-modify-write without a lock/transaction → `test_AC09_concurrent_adds` red (the
repeat makes the race likely; the reviewer may also inject a delay between read and write);
`isAdmin` bypass on ownership → `test_AC09_other_user_403_also_admin` red; emit the event
unconditionally → `test_AC09_no_change_no_event` red.

---

## AC-10 `GET /v1/fleet` machine labels and sync

File `test/labels.test.ts`.

| Test | Setup / stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC10_default_empty_array` | fresh machine, `w.flush()` | fleet machine `labels` `toStrictEqual([])` | missing or `undefined` |
| `test_AC10_after_post` | `POST …/labels {labels:["gpu"]}` | fleet `labels: ["gpu"]` | missing |
| `test_AC10_sync_keeps` | after the post: a hook + `w.flush()`; a `workspaceRoots` change via `w.restart` so the sync replaces `repos` + flush; a raw `POST /v1/sync` body without `machine` | fleet `labels` still `["gpu"]` after each; `repos` did change (positive control) | wiped by a sync |
| `test_AC10_sync_body_has_no_machine_labels` | `w.syncBodies(p)` | no body carries machine labels (`machine.labels` absent) | the daemon sends them |

Mutation: `touchMachine` resets labels → `test_AC10_sync_keeps` red; omit `labels` for unlabelled
machines → `test_AC10_default_empty_array` red.

---

## AC-11 `renderFleet` with labels, and `mesh_fleet`

Files `src/core/fleet.test.ts`, `test/labels.test.ts` (MCP).

| Test | Setup / stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC11_machine_labels_current` | `view` with machine labels `["perf-lab","gpu"]` (given unsorted), `current` = it, 2 repos | title line ends ` · 2 repos · [gpu, perf-lab] · this machine` (whole line compared) | order, separator, brackets |
| `test_AC11_machine_labels_not_current` | same, not current | line ends ` · 2 repos · [gpu, perf-lab]` | ` · this machine` printed, or labels missing |
| `test_AC11_session_labels` | session with step `S` and labels `["perf"]` | session line `  <repo> · <name> · <state> · S · [perf] · <age>` (whole line) | labels after age, or missing |
| `test_AC11_empty_labels_no_brackets` | machine `labels: []`, session without labels | no `[` in output; output equals the MM-1 rendering of the same view without the key | ` · []` printed |
| `test_AC11_mm1_cases_unchanged` | the MM-1 `fleet.test.ts` cases, unedited (git diff of those cases is empty) | pass | any MM-1 expected string changed |
| `test_AC11_mcp_mesh_fleet_equals_cli` (World) | bob's machine labelled, a labelled session, flush; `w.tool(p, pid, "mesh_fleet")` and `mesh machines` (CLI against the same hub, frozen clock) | identical text, containing `[` labels | differs |

Mutation: unsorted join → `test_AC11_machine_labels_current` red (input given unsorted); labels placed
after `this machine` → same test red; print ` · []` for empty → `test_AC11_empty_labels_no_brackets` red.

---

## AC-12 `filterFleet`

File `src/core/fleet.test.ts`. Fixture: M1 labels `["perf"]` with sessions a(`[]`), b(`["gpu"]`);
M2 no labels with sessions c(`["perf"]`), d(`["gpu"]`), e(`["perf","gpu"]`); M3 no labels with f(`[]`);
M4 labels `["perf","gpu"]` with g(`[]`).

| Test | Setup / stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC12_empty_returns_view` | `filterFleet(v, [])` | `toStrictEqual(v)` | anything dropped |
| `test_AC12_single_label` | `["perf"]` | machines M1 (a, b), M2 (c, e), M4 (g); M3 dropped | M1 loses sessions, M2 keeps d, M3 kept |
| `test_AC12_two_labels_all_must_match` | `["perf","gpu"]` | M2 (e only), M4 (g); M1 dropped (has only `perf`; b has only `gpu`) | any-match semantics |
| `test_AC12_other_fields_and_order` | both calls | `now`, `user`, `current` equal the input's; kept machines and sessions in input order; other machine fields untouched | reordered or fields changed |
| `test_AC12_no_mutation` | deep-copy `v` before; call | `v` unchanged | input mutated |

Positive control: `test_AC12_single_label` keeps items, so the drop assertions are about the rule.
Mutation: `some` instead of `every` → `test_AC12_two_labels_all_must_match` red; filter sessions even
on a matching machine → `test_AC12_single_label` red (M1 would lose a).

---

## AC-13 `mesh machines --label` / `mesh fleet --label`

File `test/labels.test.ts` (CLI against the World hub, bob's config dir, frozen clock).

| Test | Setup / stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC13_filtered_text` | bob: M1 labelled `perf`, M2 unlabelled with one `perf` session and one other; `mesh machines --label perf` | stdout equals `renderFleet(filterFleet(fleetView, ["perf"]))` computed from bob's `GET /v1/fleet`; differs from unfiltered `mesh machines` (positive control) | unfiltered |
| `test_AC13_json_filtered` | `--label perf --json` | parsed stdout `toStrictEqual(filterFleet(view, ["perf"]))` | unfiltered JSON |
| `test_AC13_no_match_message` | `--label nope`; `--label nope,zz` | stdout `No machine or session of yours is labelled nope.` / `… labelled nope and zz.` (labels in parsed order: sorted), exit 0 | other text or exit |
| `test_AC13_bad_label_exit_2` | `--label "bad label"` | exit 2, stderr contains `not a label: bad label (`; no `GET /v1/fleet` request seen by the hub | exit 0/1 |
| `test_AC13_fleet_alias` | each above with `mesh fleet` | same | differs |
| `test_AC13_no_label_unchanged` | `mesh machines` without `--label` | equals `renderFleet(view)` | changed |

Note: the spec example writes `perf and gpu`, while `parseLabels` sorts, which would give `gpu and
perf`. The test uses labels whose sorted order equals the given order (`nope,zz`), plus one assertion
with `perf,gpu` that accepts the sorted form `gpu and perf` (the `parseLabels` contract wins; see Open
questions).
Mutation: apply the filter only to `--json` → `test_AC13_filtered_text` red; print the no-match message
on stderr → `test_AC13_no_match_message` red.

---

## AC-14 `mesh label`

Files `test/labels.test.ts` (CLI with bob's World daemon + hub; topic `perf` defined) and
`test/cli.test.ts` (usage, help).

| Test | Setup / stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC14_set_prints_and_stores` | session named `s1`; `mesh label s1 perf,gpu` | stdout `s1: labels gpu, perf`, exit 0; `w.session(p,pid).labels` `["gpu","perf"]` | other text, unsorted |
| `test_AC14_not_a_topic_warning_once` | same run | stderr lines equal exactly `["not a topic: gpu; mesh topic add gpu"]` | `perf` warned, or duplicate |
| `test_AC14_add_rm` | `--add x` → `s1: labels gpu, perf, x`; `--rm gpu` → `s1: labels perf, x` | as listed, daemon agrees | other |
| `test_AC14_clear` | `--clear` | `s1: no labels`; session has no `labels` key | other |
| `test_AC14_who_fallbacks` | unnamed session in repo `r`; then a session with neither name nor repo | `r: labels …`; first 8 chars of sid | wrong `<who>` |
| `test_AC14_bad_label_exit_2_no_call` | `mesh label s1 "bad label"` | exit 2, stderr `not a label: bad label (…)`; the daemon saw no `POST /local/labels` (request spy / labels unchanged) | daemon called |
| `test_AC14_no_session_exit_1` | `mesh label nope a` | exit 1, stderr `no live session matches "nope"` | exit 2 or 0 |
| `test_AC14_usage_exit_2` (cli.test) | `mesh label`; `mesh label s1`; `mesh label s1 a --clear`; `mesh label s1 a --add --rm` | each exit 2; stderr starts with `usage: mesh label <session> <label,…> [--add|--rm]` and contains `mesh label <session> --clear` | other exit or text |
| `test_AC14_help_lists_label` (cli.test) | `mesh help` | contains `mesh label` | missing |

Positive control: `test_AC14_set_prints_and_stores` proves the daemon is reached, so "no call" in the
bad-label test is meaningful.
Mutation: send the raw labels to the daemon without parsing first → `test_AC14_bad_label_exit_2_no_call`
red (exit 1 instead of 2); print unknown warnings on stdout → `test_AC14_not_a_topic_warning_once` red.

---

## AC-15 `mesh run --label`

File `test/m45-cli.test.ts` (fake runner records tmux/claude calls; test daemon; temp checkout).

| Test | Setup / stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC15_records_before_start` | `mesh run <repo> --label perf` | the daemon received `POST /local/labels {cwd: <repo dir>, labels:["perf"]}` before the first runner call (recorded order); the placeholder from `/local/launch` and the session after its first hook have `labels: ["perf"]` | no call, or after start |
| `test_AC15_worktree_gets_it` | `--step S --worktree --label perf` | `{cwd: <worktree dir>}`; a hook in the worktree gets `["perf"]`; a hook in the main checkout does not (positive control for "not the main checkout") | main checkout labelled |
| `test_AC15_bg_also` | `--bg --label perf` | same record and labels | skipped for `--bg` |
| `test_AC15_bad_label_no_process` | `--label "bad label"` (also `--step S`) | exit 2, stderr `not a label: bad label (…)`; fake runner saw no call; no claim request at the hub/daemon | any call |
| `test_AC15_daemon_failure_warns_and_starts` | daemon answers `/local/labels` with 500 `{error:"boom"}` | stderr `warning: could not record the labels for <dir>: boom` (prefix match on `warning: could not record the labels for <dir>: `); the runner still started the session; exit as without `--label` | aborted, or no warning |
| `test_AC15_not_a_topic_once` | daemon reply `unknown: ["perf"]`, two repos | exactly one stderr line `not a topic: perf; mesh topic add perf` | twice or none |
| `test_AC15_without_label_no_call` | `mesh run <repo>` | no `/local/labels` request | a call |
| `test_AC15_usage_mentions_label` | `mesh run` with no args | usage contains `--label a,b` | missing |

Mutation: parse labels after the claim → `test_AC15_bad_label_no_process` red; use the repo dir for
worktree runs → `test_AC15_worktree_gets_it` red; warn per reply → `test_AC15_not_a_topic_once` red.

---

## AC-16 `mesh machine label`

File `test/labels.test.ts` (CLI against the World hub; bob with machines M1 (this installation) and
M2 (nickname `lab`); topic `gpu` defined).

| Test | Setup / stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC16_label_this_machine` | `mesh machine label gpu,perf-lab` | stdout `<M1 hostname> (<M1 id>): labels gpu, perf-lab`; exit 0; fleet M1 labels; M2 unchanged | wrong machine |
| `test_AC16_unknown_warning` | same run | stderr has exactly `not a topic: perf-lab; mesh topic add perf-lab` | other |
| `test_AC16_add_rm_clear` | `--add x`, `--rm gpu`, `--clear` | `… labels gpu, perf-lab, x`, `… labels perf-lab, x`, `<hostname> (<id>): no labels`; the hub saw `{add}`, `{remove}`, `{labels: []}` bodies | other |
| `test_AC16_other_machine_by_nickname` | `--machine lab gpu` | M2 labelled; M1 unchanged | wrong machine |
| `test_AC16_machine_nope` | `--machine nope gpu` | exit 1 with the MM-1 `mesh machine name --machine nope` stderr text (taken from running that command in the same test) | other |
| `test_AC16_bad_label_no_hub_call` | `mesh machine label "bad label"` | exit 2, `not a label: bad label (…)`; no `POST /v1/machines/*/labels` at the hub | hub called |
| `test_AC16_hub_400` | M1 at 10 labels; `--add zz` | exit 1, stderr `at most 10 labels` | exit 0/2 |
| `test_AC16_usage` | `mesh machine label`; `mesh machine` | exit 2, stderr contains `mesh machine label <label,…> [--add|--rm] [--machine <id|nickname|hostname>]` | other |

Mutation: always use this installation's id → `test_AC16_other_machine_by_nickname` red; send
`{labels}` for `--add` → `test_AC16_add_rm_clear` body assertion red.

---

## AC-17 TUI render

File `src/cli/tui/render.test.ts`.

| Test | Setup / stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC17_labelled_row` | session list with an `idle` session `labels: ["gpu","perf"]`, width 120 | its row contains `[gpu, perf] idle` (labels immediately before the detail text) | missing or after |
| `test_AC17_footer_L_labels` | session list view | footer contains `L labels` | missing |
| `test_AC17_unlabelled_rows_unchanged` | existing snapshots, unedited | pass (snapshot files unchanged in the diff except the footer line) | an unlabelled row changed |
| `test_AC17_machines_view_labels` | `renderMachines` on a labelled view | contains `[gpu, perf-lab]` as `renderFleet` prints it | missing |

Mutation: put labels after the detail text → `test_AC17_labelled_row` red.

Note: the footer gains `L labels`, which changes existing footer snapshots; the reviewer checks that
only footer lines changed in `__snapshots__`.

---

## AC-18 TUI key `L` (review, manual)

No harness for `tui.ts`. Review checklist and manual steps (recorded in the review file):

| Check | Steps | Expected | Fails when |
|---|---|---|---|
| `test_AC18_prompt_prefilled` (manual) | session `s1` with `[gpu, perf]`; press `L` | input line `labels for s1: gpu, perf` | other prompt |
| `test_AC18_enter_sets` (manual) | replace with `x, y`, Enter | status `s1: labels x, y` (plus ` · not a topic: …` per unknown); `mesh label` view agrees | not set |
| `test_AC18_empty_clears` (manual) | empty value, Enter | `s1: no labels` | other |
| `test_AC18_invalid_no_change` (manual) | `bad label`, Enter | status shows the `parseLabels` error; labels unchanged | changed |
| `test_AC18_esc_cancels` (manual) | edit, Esc | labels unchanged | changed |
| `test_AC18_other_views_noop` (manual) | `L` in My machines and goals views | nothing happens | prompt opens |
| review | read `tui.ts` key handler | calls `parseLabels` before `DaemonClient.labels(sid, labels, "set")` | client called on an error |

Mutation (review): call the client before parsing → the invalid-value step changes the labels.

---

## AC-19 Web Mine tab (Playwright)

File `test/e2e-web/mine.spec.ts` (`pnpm test:web`).

| Test | Setup / stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC19_machine_labels_span` | machine labelled `gpu,perf-lab` before load | `span.labels` in its title line has text `gpu, perf-lab` | missing |
| `test_AC19_sessions_labels_column` | a labelled session | table header has `labels` between `step` and `age`; the cell shows `perf`; an unlabelled session's cell is empty | wrong position or missing |
| `test_AC19_live_refresh` | page open; `mesh label <s> zz` (or `POST /local/labels`) + daemon sync | cell shows `zz` within 20 s without reload (`page.reload` not called) | not refreshed |
| `test_AC19_unlabelled_machine_no_span` | machine without labels | no `span.labels` | empty span |

Mutation: render labels only on first load (ignore SSE) → `test_AC19_live_refresh` red.

---

## AC-20 OpenAPI and route table

File `test/schemas.test.ts` (existing generic checks plus new assertions).

| Test | Setup / stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC20_openapi_fresh` | existing "matches `pnpm schemas`" check | passes | stale |
| `test_AC20_openapi_lists_labels_route` | read `schemas/hub-api.openapi.json` | `paths["/v1/machines/{id}/labels"].post` exists, request body references `MachineLabels`, tag `daemon` | missing |
| `test_AC20_HUB_API_matches_app` | existing route-table check | `POST /v1/machines/:id/labels` present with rule member and no service scope | rule/scope mismatch |

Mutation: register the route with a `live:read` scope → `test_AC20_HUB_API_matches_app` red (and
`test_AC09_service_token_403`).

---

## AC-21 Docs and skill

File `test/schemas.test.ts` (skill) plus review.

| Test | Setup / stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC21_skill_mentions_labels` | `MESH_SKILL` | contains `mesh label`, `.mesh/agent.yaml`, `mesh machines --label` | missing |
| `test_AC21_skill_file_equals` | existing check `skills/mesh/SKILL.md` = `MESH_SKILL` | equal | differs |
| `test_AC21_docs_mention` | read files | `docs/guide/concepts.md` contains a `Labels` heading and `.mesh/agent.yaml`; `docs/guide/howto.md` contains `Label sessions and machines`, `mesh machine label`, `mesh machines --label`; `docs/guide/install.md` "What the hub sees" mentions labels; `docs/plan/implementation-plan.md` contains `POST /v1/machines/:id/labels`; `docs/events.md` contains `machine.labelled` | any missing |
| review | read the docs | the order "remembered list replaces the repo default", per checkout, `not a topic` warning, at most 10 are stated | wrong semantics described |

Mutation: delete the `machine.labelled` row → `test_AC21_docs_mention` red.

---

## AC-22 Version, checks, placement

| Test | Setup / stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC22_version` (schemas.test) | `package.json` | `version === "0.1.10"` | other |
| `test_AC22_placement` (schemas.test or boundaries) | `src/protocol/index.ts` exports `parseLabels`, `Label`, `LABEL_RULE`, `MAX_LABELS`; `src/core/index.ts` exports `filterFleet`; the string `agent.yaml` occurs under `src/daemon/` and not in `src/cli/` or `src/hub/` | as listed | wrong layer |
| `pnpm check` | lint, typecheck, boundaries, test, build | all pass | any fails |

Mutation: import `parseLabels` from `src/core` in the protocol layer (or move it) →
`pnpm boundaries` / `test_AC22_placement` red.

---

## Criterion coverage

| AC | Tests | Surface |
|---|---|---|
| AC-01 | `test_AC01_*` (10) | unit |
| AC-02 | `test_AC02_*` (4) | unit |
| AC-03 | `test_AC03_*` (9) | daemon |
| AC-04 | `test_AC04_*` (10) | daemon, store |
| AC-05 | `test_AC05_*` (10) | daemon |
| AC-06 | `test_AC06_*` (6) | World, daemon |
| AC-07 | `test_AC07_*` (7) | World |
| AC-08 | `test_AC08_*` (7) | contract |
| AC-09 | `test_AC09_*` (15) | World |
| AC-10 | `test_AC10_*` (4) | World |
| AC-11 | `test_AC11_*` (6) | unit, World (MCP) |
| AC-12 | `test_AC12_*` (5) | unit |
| AC-13 | `test_AC13_*` (6) | World / CLI |
| AC-14 | `test_AC14_*` (9) | CLI |
| AC-15 | `test_AC15_*` (8) | CLI |
| AC-16 | `test_AC16_*` (8) | World / CLI |
| AC-17 | `test_AC17_*` (4) | unit |
| AC-18 | `test_AC18_*` (manual + review) | manual |
| AC-19 | `test_AC19_*` (4) | Playwright |
| AC-20 | `test_AC20_*` (3) | schemas |
| AC-21 | `test_AC21_*` (3 + review) | schemas, review |
| AC-22 | `test_AC22_*` (2) + `pnpm check` | check |

## Open questions (for the spec owner; tests take the conservative reading)

- AC-13 example `labelled perf and gpu.` conflicts with `parseLabels` sorting (`gpu and perf`). The
  test plan follows the parsed (sorted) order, as the contract says labels are "parsed with
  `parseLabels`". If the given order is meant, the CLI must keep the raw order for the message only.
- AC-15 `daemon call failure`: the spec does not say whether a daemon that is not running at all
  (connection refused) is a "failing call" or "mesh not set up". Tests cover an HTTP 500 only.
- AC-09 `{labels: [...]}` with more than 20 raw items: the plan expects 400 (zod), not
  `at most 10 labels`; the exact text is not pinned.
- AC-17 footer snapshots change by the new `L labels` hint; the plan treats only footer-line changes
  as allowed.
