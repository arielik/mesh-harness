# Test plan MM-1: My mesh (read-only)

Spec: `docs/specs/MM-1.md` (revision 3, approved in `docs/specs/reviews/MM-1/r3-approved.md`).

Inputs read: `docs/specs/MM-1.md` (interface contracts, acceptance criteria, open questions); the file names of existing tests under `test/` and `src/**/*.test.ts`; the public method signatures of the test helper `test/helpers/world.ts` (`start`, `person`, `flush`, `api`, `stopHub`, `startHubAgain`).
Not read: `docs/specs/plans/MM-1-impl-plan.md` (the implementation plan); any implementation source of this row or of the code it changes (hub, store, daemon, CLI, TUI, web, `src/core`).

Planned black-box from the contracts. Every negative assertion has a positive control in the same
test or a named sibling, so a test cannot pass because nothing happened. Each criterion names at
least one mutation of the implementation that must turn one of its tests red; the implementer or
reviewer applies it once by hand, confirms red, and reverts.

## Surfaces and files

| Surface | File | New or extended |
|---|---|---|
| unit, protocol | `src/protocol/config.test.ts` | extended |
| unit, visibility | `src/core/visibility.test.ts` | new |
| unit, render | `src/core/fleet.test.ts` | new |
| unit, repo scan | `src/daemon/repos.test.ts` | new |
| unit, hub link (fake fetch, injected clock) | `src/daemon/hub-link.test.ts` | extended |
| daemon local API | `src/daemon/daemon.test.ts` | extended |
| TUI render | `src/cli/tui/render.test.ts` | extended |
| store contract (SQLite always, Postgres when the existing Postgres test URL is set) | `src/store/hub-store.contract.test.ts` | extended |
| CLI (`mesh setup`) | `test/cli.test.ts` | extended |
| World (real hub + daemons over HTTP), CLI and MCP against it | `test/my-mesh.test.ts` | new |
| World regressions of v0.1.7 sharing | `test/share-sessions.test.ts` | extended |
| ops (`/readyz`) | `test/m46-ops.test.ts` | extended |
| schemas, route table, skill, docs, version | `test/schemas.test.ts` | extended |
| Playwright | `test/e2e-web/mine.spec.ts` | new (`pnpm test:web`, not part of `pnpm check`) |

World helper changes (test side, as the spec assigns): `World.person(name, repo, opts)` gains
`hostname`, `install` (install id) and `workspaceRoots`, and may be called more than once for one
user; each call is a separate machine with its own install id and returns its own `Person` handle.
Added helpers: `w.machineOf(p)` (machine id from that person's credentials) and `w.syncBodies(p)`
(every `POST /v1/sync` body that daemon sent; the World fetch wrapper already sees each request).
A frozen hub clock (World option) is used wherever text with ages is compared across two reads.

Common fixtures:
- `view(now, machines)` in `src/core/fleet.test.ts`: hand-built `FleetView` objects (no hub).
- `fakeHub()` in `src/daemon/hub-link.test.ts`: a fake `fetch` that records each `POST /v1/sync` body and answers a scripted reply (`{accepted}` or `{accepted, share}` or a 500), a mutable credentials object, an injected clock and a spy logger.
- `tempTree()` in `src/daemon/repos.test.ts`: a temp dir built with `git init` and `git remote add origin …` (no network), removed in `afterEach`.

---

## AC-01 Config share levels

File `src/protocol/config.test.ts`.

| Test | Setup / stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC01_share_levels_parse` | `DaemonConfig.parse({...minimal, shareSessions: x})` for `steps`, `me`, `all` | each parses to `x` | any of the three rejected or rewritten |
| `test_AC01_unknown_level_rejected` | `shareSessions: "team"` and `true` | `safeParse(...).success === false` | an unknown value accepted |
| `test_AC01_missing_field_defaults_to_steps` | minimal config without the field | `shareSessions === "steps"` | anything else (`me`, `undefined`) |
| `test_AC01_newConfig_is_me` | `newConfig()` | `shareSessions === "me"` and the object passes `DaemonConfig.parse` | `newConfig().shareSessions !== "me"` |
| `test_AC01_ShareLevel_exported` | import `ShareLevel` from `src/protocol/index.js` | `ShareLevel.options` equals `["steps","me","all"]` | not exported or other options |

Positive control: `test_AC01_share_levels_parse` shows the parser accepts valid values, so the rejection test cannot pass on a parser that rejects everything.
Mutation: default `"me"` in `DaemonConfig` → `test_AC01_missing_field_defaults_to_steps` red; drop `"me"` from the enum → `test_AC01_share_levels_parse` red.

## AC-02 `mesh setup` share level

File `test/cli.test.ts` (CLI in a temp config dir).

| Test | Setup / stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC02_fresh_setup_writes_me` | empty config dir; `mesh setup` | `daemon.json` has `shareSessions: "me"`; stdout contains the `me` line `Sessions without a step will be reported to the hub as metadata that only you can see (state, repo, name, times; no paths or text). Restart the daemon to apply.` | no `me` in the file, or line missing |
| `test_AC02_existing_steps_kept` | `daemon.json` with `steps`; `mesh setup` | still `steps`; stdout has neither the `me` nor the `steps` level line | level changed without a flag |
| `test_AC02_existing_without_field_kept` | `daemon.json` without the field; `mesh setup` | the file still parses to `steps` (no key, or `steps`), never `me` | becomes `me` |
| `test_AC02_flag_sets_all` | existing config; `mesh setup --share-sessions all` | `all`; stdout has the v0.1.7 `all` text | flag ignored |
| `test_AC02_alias_share` | existing `steps`; `mesh setup --share all`, then `--share me` | `all`, then `me` with the `me` line | alias ignored |
| `test_AC02_flag_steps_prints_line` | `me` config; `mesh setup --share-sessions steps` | `steps`; stdout `Only sessions holding a step will be reported to the hub. Restart the daemon to apply.` | other text |
| `test_AC02_bad_value_exit_2` | `mesh setup --share-sessions nope` | exit 2; stderr contains `--share-sessions must be steps, me or all`; `daemon.json` byte-identical to before | other code or message, or file changed |

Positive control: `test_AC02_alias_share` shows a valid flag does change the file, which gives the unchanged-file assertion of the bad-value test meaning.
Mutation: setup always writes `me` → `test_AC02_existing_steps_kept` red; remove the `--share` alias → `test_AC02_alias_share` red; exit 1 on a bad value → `test_AC02_bad_value_exit_2` red.

## AC-03 `syncedSessions` by share level

File `src/daemon/hub-link.test.ts`. Fixture: 3 step holders (one with the oldest `lastEventAt` of all), 205 no-step sessions with distinct `lastEventAt`; every session has `cwd`, `pane`, `pid`, `transcriptPath`, `lastMessage`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC03_steps_only_step_holders` | `syncedSessions(all, "steps")` | exactly the 3 step holders, full records | a no-step session included |
| `test_AC03_me_step_holders_first_then_metadata` | `syncedSessions(all, "me")` | length 200; first 3 are the step holders (full, `cwd` present); the rest no-step sessions in `lastEventAt` descending order; none of the rest has a `cwd`, `pane`, `pid`, `transcriptPath` or `lastMessage` key | no-step missing, full record leaked, wrong order |
| `test_AC03_all_same_as_me` | `syncedSessions(all, "all")` | deep-equals the `me` result | differs |
| `test_AC03_cap_keeps_step_holders` | as fixture, oldest session is a step holder | that step holder is in the 200 | dropped by the cap |
| `test_AC03_metadata_matches_sessionMetadata` | each no-step record vs `sessionMetadata(original)` | deep-equal | another shape |

Positive control: the `me` result contains no-step sessions and step holders keep `cwd`, so the exclusion and the stripping are level- and step-driven, not a broken filter.
Mutation: treat `me` like `steps` → `test_AC03_me_step_holders_first_then_metadata` red; send full records for no-step sessions → same test red; cap before putting step holders first → `test_AC03_cap_keeps_step_holders` red.

## AC-04 Every sync carries `machine.share`; the hub stores it

File `test/my-mesh.test.ts`.

| Test | Setup / stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC04_sync_carries_share_each_level` | `ann` `steps`, `bob` `me`, `cat` `all`, each with a session; `w.flush()` twice | every body in `w.syncBodies(p)` has `machine.share` equal to that daemon's config | `machine` missing or wrong in any body |
| `test_AC04_hub_stores_share` | after flush, each person's `GET /v1/fleet` | own machine `share` equals the config | another value or absent |
| `test_AC04_share_change_after_restart` | bob's config to `steps`, restart his daemon, flush | fleet `share: "steps"` | old value kept |

Positive control: the three people store three different values, so a constant answer fails.
Mutation: hub ignores `machine.share` → `test_AC04_hub_stores_share` red; daemon omits `machine` after the first sync → `test_AC04_sync_carries_share_each_level` red.

## AC-05 Schema version and fresh machine row shape

Files `src/store/hub-store.contract.test.ts` (both engines) and `test/m46-ops.test.ts`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC05_schema_version_6` | `HubStore.SCHEMA_VERSION` | `6` | other |
| `test_AC05_migration_lengths_equal` | `HUB_MIGRATIONS.length`, `HUB_MIGRATIONS_PG.length` | equal | differ |
| `test_AC05_fresh_machine_row_strict` | create a machine, `touchMachine(id, now, counts)` without facts, read back | `toStrictEqual({ id, userId, hostname, lastSeen, counts })` | any extra key (`share: undefined`, `nickname: null`, `repos: []`, `reposAt`) |
| `test_AC05_readyz_schema_6` (`test/m46-ops.test.ts`) | `GET /readyz` | reports schema 6 | other |

Positive control: AC-06 shows the same read returns the new keys once facts are stored, so the strict shape here is not an always-empty read.
Mutation: map an unset nickname to `null` → `test_AC05_fresh_machine_row_strict` red; add the migration only to the SQLite list → `test_AC05_migration_lengths_equal` red.

## AC-06 `touchMachine` facts

File `src/store/hub-store.contract.test.ts` (SQLite and Postgres). One machine, a sequence of touches; repos `A`, `B`, `C`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC06_touch_stores_share_and_repos` | `touchMachine(id, 1000, c, { share: "me", repos: [A, B] })` | `share: "me"`, `repos: [A, B]`, `reposAt: 1000` | either missing, `reposAt` wrong |
| `test_AC06_plain_touch_keeps_inventory` | then `touchMachine(id, 2000, c)` | repos `[A, B]`, `reposAt` 1000, `share` `me`, `lastSeen` 2000 | inventory lost or `reposAt` moved |
| `test_AC06_share_only_keeps_inventory` | then `{ share: "all" }` at 3000 | `share: "all"`, repos `[A, B]`, `reposAt` 1000 | inventory changed |
| `test_AC06_repos_replace` | then `{ share: "all", repos: [C] }` at 4000 | `repos: [C]`, `reposAt: 4000` | merged, not replaced |
| `test_AC06_empty_repos_clears` | then `{ repos: [] }` at 5000 | `repos: []`, `reposAt: 5000` | empty list ignored |

Positive control: `lastSeen` moves on every touch, proving each touch was applied.
Mutation: write `repos = []` when facts are absent → `test_AC06_plain_touch_keeps_inventory` red; set `reposAt` on every touch → same test red.

## AC-07 `setMachineNickname`

File `src/store/hub-store.contract.test.ts` (SQLite and Postgres). User `u1` with machines `m1`, `m2`; user `u2` with `m3`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC07_set_and_clear` | `set(m1, "desk")`, read; `set(m1, undefined)`, read | `true` and `nickname: "desk"`; `true` and no `nickname` key (strict) | not set, not cleared, cleared to `null` |
| `test_AC07_duplicate_within_user_refused` | `m2` named `tower`; `set(m1, "desk")`, `set(m2, "desk")` | second returns `false`; `m2` still `tower` | duplicate allowed or `m2` changed |
| `test_AC07_same_nickname_other_user` | `set(m3, "desk")` | `true` | refused across users |
| `test_AC07_rename_to_own_nickname` | `set(m1, "desk")` again | `true` | a machine clashes with itself |
| `test_AC07_concurrent_one_wins` | 20 rounds: `Promise.all([set(m1, x), set(m2, x)])` with a fresh `x`, through two store instances on one database (Postgres) / one file (SQLite) | each round one `true`, one `false`, exactly one of m1/m2 has `x`, nothing thrown | both `true`, both rows `x`, or an error |
| `test_AC07_inside_caller_transaction` | in one outer store transaction: a clashing call (`false`), then another write, commit | commit succeeds and the other write is stored (Postgres transaction not aborted) | transaction aborted or error |
| `test_AC07_unknown_id` | `set("m-ffffffff", "desk")` | `true`; all machine rows `toStrictEqual` the rows before | row created or changed |

Positive control: `test_AC07_set_and_clear` shows writes take effect; `test_AC07_same_nickname_other_user` shows the refusal is per user.
Mutation: drop the pre-check and rely on the unique index → `test_AC07_inside_caller_transaction` red on Postgres and `test_AC07_concurrent_one_wins` throws; check across all users → `test_AC07_same_nickname_other_user` red; skip `serialize()` → `test_AC07_concurrent_one_wins` red on Postgres within the 20 rounds.

## AC-08 `sessionVisible`

File `src/core/visibility.test.ts`. Viewer `alice`; one `it.each` table.

| Test | Case | Expected |
|---|---|---|
| `test_AC08_owner_always` | `{userId: "alice"}` with `steps`, `me`, `all`, `undefined` | `true` each |
| `test_AC08_step_visible_to_anyone` | `{userId: "bob", step: "G1.a"}` with each share | `true` each |
| `test_AC08_nostep_all_visible` | `{userId: "bob"}`, `all` | `true` |
| `test_AC08_nostep_steps_hidden` | `{userId: "bob"}`, `steps` | `false` |
| `test_AC08_nostep_me_hidden` | `{userId: "bob"}`, `me` | `false` |
| `test_AC08_nostep_absent_hidden` | `{userId: "bob"}`, `undefined` | `false` |
| `test_AC08_step_key_undefined` | `{userId: "bob", step: undefined}`, `me` | `false` |
| `test_AC08_exported_from_core_index` | import from `src/core/index.js` | is a function |

Fails when any case gives the other answer. Positive control: `true` and `false` cases sit in the same table.
Mutation: absent share treated as `all` → `test_AC08_nostep_absent_hidden` red; `return share !== "steps"` → `test_AC08_nostep_me_hidden` red.

## AC-09 `/v1/live` hides `me` sessions from others

File `test/share-sessions.test.ts`. Setup: `alice`, `bob`; bob `me` with an idle no-step session `s-bob`; flush until bob's sync reply carried `share` and `s-bob` reached the hub; a `live:read` service token.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC09_session_reached_hub` | bob `GET /v1/fleet` | lists `s-bob` (positive control: the hub has it) | missing |
| `test_AC09_alice_does_not_see_bob_me_session` | alice `GET /v1/live` | no session `s-bob`; bob's machine `counts` equal those in bob's own view and include the idle session | listed, or counts lack it |
| `test_AC09_bob_sees_own_me_session` | bob `GET /v1/live` | `s-bob` listed | missing |
| `test_AC09_service_token_does_not_see` | service token `GET /v1/live` | `s-bob` not listed; bob's machine and counts listed | listed |

Mutation: drop the filter in `/v1/live` → `test_AC09_alice_does_not_see_bob_me_session` red; apply the filter to counts → its counts assertion red.

## AC-10 `/v1/live` regressions

File `test/share-sessions.test.ts`.

| Test | Setup | Expected | Fails when |
|---|---|---|---|
| `test_AC10_step_holder_visible_all_levels` | `it.each` over bob `steps`, `me`, `all`; bob claims a step in session `s1` | alice and the service token list `s1` | hidden at any level |
| `test_AC10_all_shows_nostep_to_others` | bob `all`, no-step session (the v0.1.7 test kept) | alice and the service token list it | hidden |
| `test_AC10_unreported_share_owner_only` | an older daemon: raw `POST /v1/sync` with bob's device token, a no-step session, no `machine` field | bob lists it; alice and the service token do not; bob's fleet machine has no `share` key | shown to alice, or hidden from bob |

Positive control: the owner listing in the third test proves the session reached the hub.
Mutation: absent share treated as `all` → `test_AC10_unreported_share_owner_only` red; require `all` even for step holders → `test_AC10_step_holder_visible_all_levels` red.

## AC-11 `GET /v1/fleet` content and order

File `test/my-mesh.test.ts`. Setup: `bob` twice (`bob-laptop` install `i-1`, `bob-desk` install `i-2`), both `me`; `alice` one machine. Laptop sessions: `b1` no step (lastEventAt t+10), `b2` step (t+20), `b3` ended. Desk session `b4`. Desk daemon stopped and the hub clock moved more than 2 minutes past its `lastSeen` (offline).

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC11_fleet_lists_own_machines_only` | bob (laptop token) | machines exactly laptop and desk; `user` is bob; alice's own call returns only her machine (positive control) | missing or foreign machine |
| `test_AC11_fleet_sessions_per_machine` | same | laptop sessions `[b2, b1]`; no `b3`; desk `[b4]`; each has a numeric `lastEventAt` | own session missing, ended listed, order wrong |
| `test_AC11_current_flag` | via laptop token, then desk token | `current: true` only on the token's machine | wrong `current` |
| `test_AC11_online_before_offline` | desk id chosen to sort before laptop's | laptop (online) first | offline first |
| `test_AC11_ties_by_id_and_sid` | two offline machines with equal `lastSeen`; two sessions with equal `lastEventAt` | machines by `id` ascending; sessions by `sid` ascending | other order |
| `test_AC11_repos_empty_before_inventory` | machine synced raw without `machine.repos` | `repos: []`, no `reposAt` key | `repos` absent or `null` |
| `test_AC11_own_nostep_whatever_level` | laptop switched to `steps` after `b1` was synced | `b1` still in bob's fleet | own session filtered |

Mutation: sort machines by `id` only → `test_AC11_online_before_offline` red; sort by `lastSeen` ascending → same test red; include ended sessions → `test_AC11_fleet_sessions_per_machine` red; mark every machine `current` → `test_AC11_current_flag` red.

## AC-12 `GET /v1/fleet` auth

File `test/my-mesh.test.ts`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC12_service_token_empty_fleet` | `live:read` service token, with machines on the hub | 200, `machines: []` | other status or non-empty |
| `test_AC12_service_token_without_scope_403` | service token without `live:read` | 403 | other |
| `test_AC12_no_token_401` | no `Authorization` | 401 | other |

Positive control: a member token gets 200 with machines (AC-11).
Mutation: return all machines to a service token → `test_AC12_service_token_empty_fleet` red; drop the scope check → `test_AC12_service_token_without_scope_403` red.

## AC-13 `POST /v1/machines/:id/name`

File `test/my-mesh.test.ts`; the concurrent case also against Postgres when its URL is set (else `skipIf` with a message the report names). Setup: `bob` with laptop `L` (`bob-laptop`) and desk `D` (`bob-desk`); `alice` (admin) with `A`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC13_owner_sets_nickname` | bob names L `m2` | 200 `toStrictEqual({id: L, hostname: "bob-laptop", nickname: "m2"})`; `/v1/fleet` and `/v1/live` show `nickname: "m2"` for L; `/v1/live` activity contains `named machine bob-laptop m2` | any differs |
| `test_AC13_clear_nickname` | `{nickname: null}` | 200 strictly `{id, hostname}`; fleet L has no `nickname` key; activity `cleared the name of machine bob-laptop` | key present, other text |
| `test_AC13_invalid_nicknames_400` | `M2`, `-x`, 33 × `a`, `m-0a1b2c3d`, `""` | 400 `{error}` each; L's nickname unchanged | other status, row changed |
| `test_AC13_valid_edge_nicknames` | `a`, 32 × `a`, `m-0a1b2c3`, `m-0a1b2c3dz` | 200 each (positive control for the 400 cases) | refused |
| `test_AC13_unknown_id_404` | id `m-ffffffff` | 404 `{error: "no machine m-ffffffff"}` | other |
| `test_AC13_other_users_machine_403` | bob names A; alice (admin) names L | 403 `{error: "not your machine"}` each; nicknames unchanged | other, or changed |
| `test_AC13_clash_409` | L `m2`; bob names D `m2` | 409 `{error: "nickname m2 is already used by your machine bob-laptop (L)"}`; D unchanged | other |
| `test_AC13_concurrent_200_and_409` | 10 rounds: `Promise.all` naming L and D the same fresh nickname | sorted statuses `[200, 409]` every round, never 500 | anything else |
| `test_AC13_event_recorded` | set then clear | events contain `machine.named` by bob with payload `{machine: L, nickname: "m2"}`, then `{machine: L, nickname: null}`; an SSE subscriber receives `changed` after each | no event, other payload, no hint |
| `test_AC13_service_token_refused` | `live:read` service token | not 200 (member only) | 200 |

Mutation: let admins pass the owner check → `test_AC13_other_users_machine_403` red; let the store's constraint error surface → `test_AC13_concurrent_200_and_409` sees 500; drop the machine-id-shape guard → `test_AC13_invalid_nicknames_400` red; no event on clear → `test_AC13_event_recorded` red.

## AC-14 `scanRepos`

File `src/daemon/repos.test.ts`. Temp tree `T`:

```
T/one              git, origin git@example.org:team/one.git            depth 1
T/one/nested       git, origin https://example.org/team/nested         inside a checkout
T/g/two            git, origin https://example.org/team/two            depth 2
T/g/h/three        git, origin https://example.org/team/three          depth 3
T/.hidden/x        git, origin https://example.org/team/hidden
T/node_modules/y   git, origin https://example.org/team/nm
T/wt               `.git` file (worktree), origin https://example.org/team/onewt
T/noremote         git, no remote
T/fileremote       origin file:///srv/x.git
T/absremote        origin /srv/y.git
T/clone-https      origin https://example.org/team/dup.git
T/clone-ssh        origin git@example.org:team/dup.git
```

| Test | Expected | Fails when |
|---|---|---|
| `test_AC14_depth_0_root_is_checkout` | `scanRepos([T/one])` returns `team/one` | root itself not checked |
| `test_AC14_depth_1_and_2_found` | `one`, `two` present | missing |
| `test_AC14_depth_3_not_found` | no `three` | found |
| `test_AC14_skips_hidden_and_node_modules` | no `hidden`, no `nm` | found |
| `test_AC14_no_descent_into_checkout` | no `nested` | found |
| `test_AC14_worktree_git_file` | `onewt` present | `.git` file ignored |
| `test_AC14_skips_no_remote_and_local_ids` | nothing for `noremote`, `fileremote`, `absremote`; no id starting `local/` | present |
| `test_AC14_dedupes_https_and_ssh` | exactly one `dup` | two |
| `test_AC14_sorted_exact_list` | result equals the exact expected list `[dup, one, onewt, two]` (by `name`, then `id`) | other order or set |
| `test_AC14_missing_root_ignored` | `scanRepos([T + "/nope", T])` equals `scanRepos([T])`, no throw | throws or differs |
| `test_AC14_tilde_expanded` | home dir pointed at `T` (env in test); `scanRepos(["~"])` equals `scanRepos([T])` | `~` not expanded |
| `test_AC14_no_paths_in_output` | `JSON.stringify(result)` contains neither `T` nor its basename; no `id` or `name` starts with `/` | path leaked |
| `test_AC14_cap_500` | 510 depth-1 checkouts | length 500 | more |
| `test_AC14_no_child_process` | `vi.mock("node:child_process")` spies | never called | the scan spawns processes |

Positive control: found cases (`one`, `two`, `onewt`) run in the same scan as the excluded ones, so an empty result fails.
Mutation: scan depth 3 → `test_AC14_depth_3_not_found` red; drop the `local/` filter → `test_AC14_skips_no_remote_and_local_ids` red; descend into checkouts → `test_AC14_no_descent_into_checkout` red.

## AC-15 Inventory reaches the hub

File `test/my-mesh.test.ts`. Setup: `bob` `me`, `workspaceRoots: [T]` with a checkout of origin `https://example.org/team/alpha.git`; a session in repo `example.org/team/beta` with its cwd outside `T`; flush until confirmed.

| Test | Expected | Fails when |
|---|---|---|
| `test_AC15_fleet_shows_inventory` | bob's machine `repos` contains id and name of `alpha` and `beta`; `reposAt` a number ≤ `now` | repo missing, `reposAt` absent |
| `test_AC15_no_path_in_machine_record` | `JSON.stringify` of the machine without `sessions` contains neither `T` nor the session cwd | path present |
| `test_AC15_all_level_also_sends` | same with `all` | same result (also the positive control for AC-30) | missing |

Mutation: send only session repos → `alpha` missing in `test_AC15_fleet_shows_inventory`; send only the scan → `beta` missing.

## AC-16 Repos re-sent only on change

File `src/daemon/hub-link.test.ts`; `fakeHub()` replies `{accepted, share: "me"}`; injected clock; inventory from a temp tree with a spy counting scans (or a counting fake scanner behind `machineRepos`).

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC16_first_sync_carries_repos` | first sync | `machine.repos` deep-equals the inventory | absent |
| `test_AC16_unchanged_not_resent` | second sync | `machine.share` present, no `repos` key | re-sent |
| `test_AC16_change_after_interval_resent` | add a checkout; clock + `REPO_SCAN_MS`; sync | `repos` includes the new checkout | not re-sent |
| `test_AC16_no_rescan_within_interval` | add a checkout; clock + `REPO_SCAN_MS - 1`; two syncs | scan count unchanged since the last scan; no `repos` key | rescan before the interval |
| `test_AC16_credentials_switch_resends` | switch hub URL (same inventory), sync; then switch machine id, sync | each first sync after a switch carries `repos` | not sent |
| `test_AC16_failed_sync_not_accepted` | first sync answered 500, next 200 | the 200 sync carries `repos` | the failed sync counted as accepted |
| `test_AC16_REPO_SCAN_MS` | the constant | `300_000` | other |

Positive control: `test_AC16_change_after_interval_resent` shows `repos` can be re-sent, so its absence in the unchanged test is meaningful.
Mutation: send `repos` on every sync → `test_AC16_unchanged_not_resent` red; key memory by hub URL only → machine-id switch in `test_AC16_credentials_switch_resends` red.

## AC-17 `renderFleet`

File `src/core/fleet.test.ts`; `now = 1_000_000_000_000`; `toBe` on whole strings.

| Test | Input | Expected |
|---|---|---|
| `test_AC17_online_nickname_current` | nickname `desk`, hostname `bob-desk`, online, share `me`, 1 repo, current; session repo `alpha`, name `fix-login`, state `working`, step `G3.api`, 45 s old | `desk (bob-desk) · online · share me · 1 repo · this machine\n  alpha · fix-login · working · G3.api · 45s` |
| `test_AC17_offline_no_nickname_no_sessions` | hostname `bob-old`, last seen 2 h ago, share absent, 3 repos, no sessions | `bob-old · last seen 2h ago · share ? · 3 repos\n  no sessions` |
| `test_AC17_session_without_repo_name_step` | sid `abcdef1234567`, no repo, name or step, state `idle`, 3 m old | `  - · abcdef12 · idle · no step · 3m` |
| `test_AC17_needs_suffix` | state `waiting`, needs `permission` | state field `waiting (permission)` |
| `test_AC17_age_boundaries` | 59 s, 60 s, 3599 s, 3600 s, 47 h, 48 h, 72 h | `59s`, `1m`, `59m`, `1h`, `47h`, `2d`, `3d` |
| `test_AC17_zero_repos_plural` | 0 repos | `0 repos` |
| `test_AC17_blocks_separated_by_one_empty_line` | two machines | exactly one empty line between blocks, none at the end |
| `test_AC17_skipCurrent` | two machines, `{skipCurrent: true}` | only the non-current block |
| `test_AC17_empty_fleet` | `machines: []`; and only the current machine with `skipCurrent` | `No machines logged in as you yet. Run mesh login on each machine.` both |
| `test_AC17_uses_view_now` | `vi.setSystemTime` a year later | output identical |

Fails when any character differs. Positive control: the expected strings differ between cases, so a constant output fails.
Mutation: ages from `Date.now()` → `test_AC17_uses_view_now` red; always `repos` → `test_AC17_online_nickname_current` red; hours capped at 24 → `test_AC17_age_boundaries` red.

## AC-18 `mesh machines` / `mesh fleet`

File `test/my-mesh.test.ts` (CLI against the World daemon; frozen hub clock).

| Test | Expected | Fails when |
|---|---|---|
| `test_AC18_machines_prints_renderFleet` | stdout equals `renderFleet(view)` plus a final newline, `view` = bob's `GET /v1/fleet`; exit 0 | differs |
| `test_AC18_fleet_alias_same_output` | `mesh fleet` stdout === `mesh machines` stdout | differs |
| `test_AC18_json_matches_hub` | `mesh machines --json`: stdout is `JSON.stringify(view, null, 2)` (+ newline) and parses deep-equal to `GET /v1/fleet` | not parseable or different |
| `test_AC18_help_lists_both` | `mesh help` contains `mesh machines` and `mesh fleet` | missing |

Positive control: the fleet has at least two machines and one session, so equal empty outputs cannot pass.
Mutation: `fleet` not registered → `test_AC18_fleet_alias_same_output` red; `--json` prints compact JSON → `test_AC18_json_matches_hub` red.

## AC-19 `mesh machine name` and not-logged-in

File `test/my-mesh.test.ts`. Setup: bob on `bob-laptop` (this installation, `L`) and `bob-desk` (`D`).

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC19_names_this_installation` | `mesh machine name m2` | stdout `Named bob-laptop (L) m2.`, exit 0; fleet: L `m2`, D unchanged; the World fetch log shows a `/v1/machines/L/name` request | wrong machine or text |
| `test_AC19_invalid_refused_before_hub` | `mesh machine name M2` | exit 2; stderr `nickname must match [a-z0-9][a-z0-9-]{0,31} and not look like a machine id`; no `/v1/machines` request in the fetch log | hub called, other code |
| `test_AC19_machine_id_shape_refused` | `mesh machine name m-0a1b2c3d` | same exit 2 and text | accepted |
| `test_AC19_machines_not_logged_in` | solo install, `mesh machines` | exit 1, stderr `not logged in to a hub; run: mesh login` | other |
| `test_AC19_no_machine_in_credentials` | solo install, `mesh machine name m2` | exit 1, stderr `this installation has no machine on the hub; run: mesh login` | other |
| `test_AC19_by_hostname` | `--machine bob-desk` | stdout `Named bob-desk (D) …`; L unchanged | wrong machine |
| `test_AC19_by_id_and_by_nickname` | `--machine D`; then, D named `tower`, `--machine tower` | D renamed each time | not resolved |
| `test_AC19_nickname_before_hostname` | L given nickname `bob-desk` (valid under `NICKNAME_RE`); `mesh machine name x1 --machine bob-desk` | L is renamed `x1` (nickname match wins over D's hostname); D unchanged | D renamed |
| `test_AC19_no_match` | `--machine nope` | exit 1, stderr `no machine of yours matches "nope"` | other |
| `test_AC19_ambiguous_hostname` | a third bob machine with hostname `bob-desk`; `--machine bob-desk` (no nickname match) | exit 1; stderr contains `matches several of your machines`, both ids and `use the id` | one picked |
| `test_AC19_clear` | `mesh machine name --clear` | stdout `Cleared the nickname of bob-laptop (L).`; fleet L has no `nickname` key | other |
| `test_AC19_clash_shows_hub_text` | D `m2`; `mesh machine name m2` | exit 1; stderr contains `nickname m2 is already used by your machine bob-desk (D)` | other |
| `test_AC19_usage` | `mesh machine`; `mesh machine foo`; `mesh machine name` | exit 2; stderr starts with `usage:` and contains `mesh machine name <nickname>` | other |

Positive control: `test_AC19_names_this_installation` asserts a hub request does happen, the contrast for the no-request assertion.
Mutation: resolve hostname before nickname → `test_AC19_nickname_before_hostname` red; validate only at the hub → `test_AC19_invalid_refused_before_hub` red.

## AC-20 MCP `mesh_fleet`

File `test/my-mesh.test.ts` (shim driven as in `test/m2-flow.test.ts`; frozen hub clock).

| Test | Expected | Fails when |
|---|---|---|
| `test_AC20_tool_listed` | `tools/list` has `mesh_fleet` with description `Every machine logged in as your user and what each session on it is doing (read-only).` and no required input | not listed |
| `test_AC20_same_text_as_cli` | `tools/call mesh_fleet {}` text === `mesh machines` stdout without its final newline | differs |
| `test_AC20_offline_error` | `w.stopHub()`; call | `isError: true`; text contains the offline text an existing hub tool returns in the same state (captured in the test) | success result |
| `test_AC20_back_online` | `w.startHubAgain()`; call | success (positive control for the offline case) | still error |

Mutation: return the JSON view instead of `renderFleet` → `test_AC20_same_text_as_cli` red; swallow the offline error → `test_AC20_offline_error` red.

## AC-21 `GET /local/fleet`

File `src/daemon/daemon.test.ts`.

| Test | Expected | Fails when |
|---|---|---|
| `test_AC21_local_fleet_proxies_hub` | with credentials and a fake hub serving a fixed `FleetView`: 200, body deep-equal; the fake saw `GET /v1/fleet` with the device token | other |
| `test_AC21_local_fleet_without_credentials_409` | no credentials: 409 `{error: "not logged in to a hub; run: mesh login"}`; no hub request | other |
| `test_AC21_client_fleet` | `DaemonClient.fleet()` resolves to the same view | missing or different |

Positive control: the proxy test shows a 200 path, so the 409 is credential-driven.
Mutation: answer 404 without credentials → `test_AC21_local_fleet_without_credentials_409` red.

## AC-22 TUI `renderMachines`

File `src/cli/tui/render.test.ts`.

| Test | Expected | Fails when |
|---|---|---|
| `test_AC22_first_lines` | line 0 the header, line 1 empty, line 2 `MY MACHINES` | other |
| `test_AC22_skips_current` | the current machine's title absent; the other machine's title present, indented by two more spaces than `renderFleet` | current shown |
| `test_AC22_only_current_empty_text` | only the current machine: a line `  No other machines. Run mesh login on your other machines.` | other |
| `test_AC22_footer_last` | last line `m back to sessions · g goals · details: mesh machines`, with and without status | other |
| `test_AC22_status_above_footer` | status `fetch failed` is line `height - 2` | elsewhere |
| `test_AC22_height_exact` | heights 10 and 40: `lines.length === height` | other |
| `test_AC22_width_limit` | width 30, long names, ANSI colours: every line's visible length (ANSI stripped) ≤ 30 | longer |
| `test_AC22_session_footer_has_m` | `render(...)` session list footer contains `m machines` | missing |

Positive control: `test_AC22_skips_current` asserts the other machine is present, so an empty panel fails.
Mutation: status after the footer (as `renderGoals`) → `test_AC22_footer_last` red; no truncation → `test_AC22_width_limit` red.

## AC-23 Web Mine tab

File `test/e2e-web/mine.spec.ts` (Playwright with `test/e2e-web/hub.yaml`). Setup: users `alice`, `bob`; bob has two `me` machines, one nicknamed `m2`, one without sessions; alice has a `me` no-step session `s-al`.

| Test | Expected | Fails when |
|---|---|---|
| `test_AC23_mine_tab_lists_machines` | bob signs in, clicks nav **Mine**: URL ends `#/mine`; two `section.machine`; one title shows `m2` and its hostname; session rows show repo, name, state, step, age | tab, machine or session missing |
| `test_AC23_empty_machine_text` | the machine without sessions shows `no sessions` | missing |
| `test_AC23_no_machines_text` | a user without machines sees `No machines logged in as you yet. Run mesh login on each machine.` | missing |
| `test_AC23_other_users_me_not_on_live` | bob's Live has no row for `s-al`; alice's Live has it (positive control) | visible to bob |
| `test_AC23_new_session_within_20s` | page open; a new bob no-step session synced via the hub API (metadata only, no SSE hint); the row becomes visible with a 20 000 ms timeout and no reload | not shown in time |

Mutation: refetch only on SSE hints → `test_AC23_new_session_within_20s` red.

## AC-24 OpenAPI and route table

File `test/schemas.test.ts`, plus the hub route comparison.

| Test | Expected | Fails when |
|---|---|---|
| `test_AC24_openapi_up_to_date` | the generator's output equals the committed `schemas/hub-api.openapi.json` | stale |
| `test_AC24_openapi_lists_fleet` | `paths["/v1/fleet"].get` exists and its text mentions `live:read` | missing |
| `test_AC24_openapi_lists_name` | `paths["/v1/machines/{id}/name"].post` exists | missing |
| `test_AC24_route_table_method_path_rule_scope` | the set of `method path rule scope` from `HUB_API` equals the set the app serves | mismatch |

Positive control: the route table set is non-empty and contains the pre-existing `GET /v1/live` entry.
Mutation: drop the scope from the served fleet route → `test_AC24_route_table_method_path_rule_scope` red; edit `HUB_API` without `pnpm schemas` → `test_AC24_openapi_up_to_date` red.

## AC-25 Docs and skill

File `test/schemas.test.ts`.

| Test | Expected | Fails when |
|---|---|---|
| `test_AC25_skill_mentions_fleet` | `MESH_SKILL` contains `mesh_fleet` and `mesh machines` | missing |
| `test_AC25_skill_file_equal` | `skills/mesh/SKILL.md` === `MESH_SKILL` | differs |
| `test_AC25_install_guide_levels` | `docs/guide/install.md` contains `steps`, `me`, `all`, `--share-sessions me` and says `me` is the default for new setups | missing |
| `test_AC25_concepts_howto` | `docs/guide/concepts.md` and `docs/guide/howto.md` contain `mesh machines`; howto contains `See all your machines`, `mesh machine name`, `workspaceRoots`, `Mine` | missing |
| `test_AC25_plan_routes` | `docs/plan/implementation-plan.md` contains `GET /v1/fleet` and `POST /v1/machines/:id/name` | missing |
| `test_AC25_events_doc` | `docs/events.md` contains `machine.named` | missing |

Review-only part (wording: who sees what, upgrade order, TUI `m`) is checked by the reviewer.
Positive control: the files are read and non-empty (assert length > 0 before the `toContain`).
Mutation: edit `MESH_SKILL` without regenerating → `test_AC25_skill_file_equal` red.

## AC-26 Version and checks

| Test | Expected | Fails when |
|---|---|---|
| `test_AC26_version` (`test/schemas.test.ts`) | `package.json` version `0.1.9` | other |
| `pnpm check` (lint, typecheck, boundaries, test, build) | exit 0 | any fails |
| `pnpm boundaries` | `renderFleet` and `sessionVisible` live in `src/core`, import only core/protocol; the scan lives in `src/daemon` | a boundary violation |

Positive control: `pnpm check` on `main` passes before the change.
Mutation: import `node:child_process` in the scan → `test_AC14_no_child_process` red; import a daemon module from `src/core/fleet.ts` → `pnpm boundaries` red.

## AC-27 Hub confirmation of `me`

File `src/daemon/hub-link.test.ts` with `fakeHub()`. Sessions: step holder `s1`, no-step `s2`, `s3`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC27_unconfirmed_sends_step_holders_only` | `me`; replies `{accepted: 0}` for 3 syncs | each body's sessions are exactly `[s1]`; each body `machine.share === "me"` | a no-step session in any body |
| `test_AC27_log_once` | same | logger called exactly once with `the hub does not support share level me; sending step holders only` | missing or repeated |
| `test_AC27_first_sync_never_nostep` | fresh link; hub would answer `share: "me"` | the first body holds `[s1]` only | sent before confirmation |
| `test_AC27_confirmed_sends_nostep` | after a reply with `share: "me"`, next sync | body contains `s2`, `s3` as metadata (no `cwd`) | still missing |
| `test_AC27_reply_without_share_unconfirms` | confirmed, then a reply `{accepted}` | the next body is `[s1]` only | keeps sending |
| `test_AC27_credentials_switch_unconfirms` | confirmed; switch hub URL; sync; new hub confirms; sync | first body after the switch `[s1]` only; after confirmation `s2`, `s3` again; a switch to a hub that never confirms logs once for those credentials | sent right after the switch |
| `test_AC27_all_needs_no_confirmation` | `all`; replies never carry `share` | the first body already has `s2`, `s3`; no log line | withheld |
| `test_AC27_steps_never_sends_nostep` | `steps`; replies `share: "steps"` | never `s2`, `s3` | sent |

Positive control: `test_AC27_confirmed_sends_nostep` shows no-step sessions do get sent once confirmed.
Mutation: treat `me` as confirmed from the start → `test_AC27_first_sync_never_nostep` red; keep the confirmation across a credentials switch → `test_AC27_credentials_switch_unconfirms` red; log on every unconfirmed sync → `test_AC27_log_once` red.

## AC-28 `POST /v1/sync` reply carries `share`

File `test/my-mesh.test.ts` (raw HTTP with a device token).

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC28_reply_has_stored_share` | body with `machine: {share: "me"}` | 200 `toStrictEqual({accepted: n, share: "me"})` | missing, other |
| `test_AC28_reply_keeps_stored_without_machine` | next body without `machine` | `share: "me"` | absent |
| `test_AC28_reply_reflects_change` | body with `machine: {share: "all"}` | `share: "all"` | stale |
| `test_AC28_never_reported_no_key` | fresh machine, body without `machine` | `toStrictEqual({accepted: n})` (no `share` key, not `null`) | key present |

Positive control: `test_AC28_reply_has_stored_share` shows the key appears when stored.
Mutation: echo the request's share instead of the stored one → `test_AC28_reply_keeps_stored_without_machine` red; serialise `share: null` → `test_AC28_never_reported_no_key` red.

## AC-29 Messages to hidden sessions

File `test/my-mesh.test.ts`. Setup as AC-09, plus bob session `s-step` holding a step.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC29_alice_to_bob_me_session_404` | alice `POST /v1/messages {toSid: s-bob}` | 404 `{error: "session s-bob is not live on any machine"}`; after `w.flush()` nothing reached bob's daemon for `s-bob` | 201, other text, delivered |
| `test_AC29_same_as_unknown_sid` | alice to `s-nope` | the same status and message form | differs |
| `test_AC29_bob_can_message_own` | bob to `s-bob` | 201 and delivered after flush (positive control for delivery) | broken |
| `test_AC29_step_holder_reachable` | alice to `s-step` | 201, delivered | broken |
| `test_AC29_all_machine_reachable` | bob switched to `all`; alice to `s-bob` | 201 | refused |

Mutation: skip the visibility check in messages → `test_AC29_alice_to_bob_me_session_404` red; refuse every foreign session → `test_AC29_step_holder_reachable` red.

## AC-30 `steps` sends no inventory

File `src/daemon/hub-link.test.ts` (daemon with fake fetch and the real scan over a temp tree), plus one World test in `test/my-mesh.test.ts`. Setup: `shareSessions: "steps"`, `workspaceRoots: [T]` with a checkout of `example.org/team/alpha`, a no-step session in `example.org/team/beta` outside `T`; replies `share: "steps"`.

| Test | Expected | Fails when |
|---|---|---|
| `test_AC30_no_alpha_or_beta_in_any_body` | over 3 syncs with the clock moved past `REPO_SCAN_MS`, no `JSON.stringify(body)` contains `alpha` or `beta` | contains |
| `test_AC30_repos_sent_is_empty` | every `machine.repos` present is `[]`; the first sync carries `repos: []` | non-empty, or not sent on the first sync |
| `test_AC30_no_scan_under_steps` | the scan spy is never called | scan ran |
| `test_AC30_switch_me_to_steps_clears` (World) | bob `me` with an inventory, restarted as `steps`, flush: fleet `repos: []` | old inventory kept |

Positive control: `test_AC15_all_level_also_sends` (and AC-15 under `me`) with the same tree shows `alpha` and `beta` are sent, so their absence here comes from the level.
Mutation: build the inventory regardless of level → `test_AC30_no_alpha_or_beta_in_any_body` red; skip sending the empty list → `test_AC30_switch_me_to_steps_clears` red.

---

## Gaps and notes

- TUI key handling (`m` toggles, `g` from the panel, session keys inert, 5 s refresh, fetch error as status) has no acceptance criterion; an optional key-driving test only if a harness for `tui.ts` exists.
- Postgres variants (AC-05, AC-06, AC-07, AC-13 concurrent) run only when the existing Postgres test URL is set; the test report must say whether they ran.
- AC-23 runs under `pnpm test:web`, not `pnpm check`; the test report must say whether it ran.
- AC-11 ordering: "online before offline" is only distinguishable from "by `lastSeen` descending" when an offline machine could have a later `lastSeen` than an online one, which the 2-minute rule makes impossible; the test therefore kills the "sort by id" mutation, and the tie test covers the `id` tiebreak.
- AC-18 and AC-20 compare age-bearing text across two reads; they freeze the hub clock (World option). If the World cannot freeze it, they compare with the age column normalised and the report says so.
