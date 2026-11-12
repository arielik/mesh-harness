# Test plan RL-5: Roster

Spec: `docs/specs/RL-5.md` (revision 1, approved in review round 2).

Inputs read: `docs/specs/RL-5.md` (interface contracts, acceptance criteria, open questions); the role
file `assets/sdd/.claude/agents/test-planner.md`; the format of `docs/specs/plans/RL-4-test-plan.md`;
the file names under `test/`, `test/helpers/`, `test/e2e-web/`, `test/fixtures/` and `src/*/*.test.ts`;
the exported names and signatures of `test/helpers/world.ts` (`World`, `Person` fields `syncs`,
`requests`, `logs`, `failOnce`, `dropReplyOnce`, `repoDir`; `PersonOptions` `shareSessions`, `repoId`,
`workspaceRoots`, `headless`; `FAKE_CLAUDE`), `test/helpers/relay-kit.ts` (`Relay`: `start`, `call`,
`goal`, `plan`, `stepOf`, `assign`, `act`, `events`, `offerMsg`, `runs`, `runOf`, `runDir`, `calls`,
`script`, `started`, `cli`, `headlessPerson`; `git`, `until`, `MESH_TOOL_RULES`, `AUDITOR`),
`test/helpers/pulse-kit.ts` (`Pk`: `bare`, `sync`, `pulse`, `pulseOk`, `act`, `fireOk`, `goal`,
`storeWrap`; `snap`, `sha`, `RELAY_PARAMS`), `test/helpers/git-tree.ts` (`fakeCheckout`),
`test/helpers/pg.ts` (`PG_URL`); the header comment of the fake `claude` fixture; the `hubYaml` token
max-age setting used in `test/pulse-daemon.test.ts`.
Not read: `docs/specs/plans/RL-5-impl-plan.md` (the implementation plan); any implementation source of
this row or of the code it changes (`src/protocol`, `src/core`, `src/store`, `src/hub`, `src/daemon`,
`src/claude`, `src/cli`, `web/`), not even to check a name.

Planned black-box from the contracts. Every negative assertion has a positive control in the same test
or a named sibling, so a test cannot pass because nothing happened. Each criterion names at least one
mutation of the implementation that must turn one of its tests red; the implementer or reviewer applies
it once by hand, confirms red, and reverts.

Rules from the spec's AC preamble that every test follows: groups are found by `name`, copies by `key`
(+ `kind` where two share a key), sources by `repo`, events by `type` (+ payload field), never by list
position of the whole stream, except where the criterion asserts an order. No test runs the real
`claude` binary (headless World tests use `FAKE_CLAUDE`; CLI tests talk to a World hub). Daemons that
must report agents have a git remote and `shareSessions: "me"` (or `all`). World tests that move the
clock past 14 days set `auth.session.device_max_age: "60d"` (as `test/pulse-daemon.test.ts`). Time comes
from `w.clock`. **Hashes are computed by the test itself** (`sha(text.replace(/\r\n/g, "\n"))`, the
documented `agentFileHash` contract) and compared with the implementation's answer, so the oracle is
independent of the code under test; one unit test (AC-04) asserts the two agree.

## Surfaces and files

| Surface | File | New or extended |
|---|---|---|
| unit, protocol (`AgentReport`, `SyncRequest`, `AgentsLock`, `CatalogPush`, `CatalogSourceSave`, `AgentDef`, `StepPolicy.agent`, `parseRosterKey`, `ROSTER_KEY_RULE`, `Pulse.agents`, `Goal.agents`) | `src/protocol/roster.test.ts` | new |
| unit, core (`catalogDigest`, `unifiedDiff`, `canonicalKey`) | `src/core/roster.test.ts` | new |
| unit, daemon discovery (`scanAgents`, temp dirs) | `src/daemon/roster.test.ts` | new |
| `HubStore` contract (SQLite always; Postgres only with `MESH_TEST_PG_URL`) | `src/store/hub-store.contract.test.ts` | extended (`describe("RL-5 roster store")`) |
| World / hub API: sync, visibility, catalog sources, push route, `GET /v1/agents`, resolve, validation, pins, offers, pulses | `test/roster-hub.test.ts` | new |
| World / daemon: discovery in sync, catalog push from real git checkouts, roster runs with the fake `claude` | `test/roster-daemon.test.ts` | new |
| CLI: `mesh agents`, `mesh agent add|outdated|diff|update`, `mesh agent source add|ls`, `mesh help` | `test/roster-cli.test.ts` | new |
| Playwright | `test/e2e-web/roster.spec.ts` (new), `test/e2e-web/hub.yaml` (user `erin`) | new / extended |
| docs, skill, version, OpenAPI, route table, boundaries | `test/schemas.test.ts` (`describe("RL-5 AC-23 docs and skill")`, `describe("RL-5 AC-24 checks, schema, routes")`), `src/claude/skill.test.ts` (skill equality, existing check) | extended |
| existing tests the spec says change | tests comparing `SCHEMA_VERSION`/migration counts (10 → 11), `TABLES`, the route list, the `mesh help` list | updated by the test-writer (spec, Compatibility); nothing else in them changes |

### Test-side helper (new, `test/helpers/roster-kit.ts`, built on `Relay` and `Pk`)

- Constants: `SRC_URL = "https://git.example.com/Team/Agents.git"`, `SRC = "git.example.com/team/agents"`
  (its canonical repo name `agents`); `SRC2 = "git.example.com/other/agents"` (second source with the
  same last segment); repos `ALPHA = "git.example.com/team/alpha"`, `BETA = ".../beta"`,
  `GAMMA = ".../gamma"`, `AARD = ".../aardvark"`. Commits `C1 = "c1".repeat(20)`, `C2 = "c2".repeat(20)`,
  `C3 = "c3".repeat(20)` (40 hex each; for the route tests no git is needed).
- Texts: `REV1` = `"---\r\ndescription: Reviews code\r\nmodel: sonnet\r\ntools: Read, Grep\r\nmesh-rules: [r.alpha, r.beta]\r\n---\r\n\r\nYou review.\r\n"`
  (CRLF on purpose), `REV2` = REV1 with `You review carefully.`, `REV3` = REV1 with `You review twice.`,
  `OTHER` = a plain LF definition `other`. `H(text) = sha(text.replace(/\r\n/g, "\n"))`; `H1 = H(REV1)`,
  `H2 = H(REV2)`, `H3 = H(REV3)`.
- `Rk5.start()` → `Relay.start(["alice", "bob", "carol", "erin"], {admins: ["bob"]})` + `Pk`;
  `bob` = admin, `alice`/`carol` = members. `source(repo = SRC_URL, folder = "agents")` = bob
  `POST /v1/catalog-sources`. `pusher(user, repos)` = `Pk.bare(user, host, {repos})` (a device token
  whose machine reports `repos`). `push(m, commit, defs: Record<name, text>)` = `POST
  /v1/catalog-sources/push {repo: SRC, commit, defs: [{path: "agents/<name>.md", text}]}` with `m.token`.
- `report(m, agents: AgentReport[], share = "me")` = a raw `POST /v1/sync` with `machine: {share, repos,
  agents}` (the hub-API form `test/my-mesh.test.ts` uses).
- `rescan(p)` = advance `w.clock` past the daemon's repo-scan interval and `w.tick()` + `w.flush()` (the
  seam MM-1 tests use for rescans; see Risks).
- `pushCalls(p)` = `p.requests.filter(r => r.method === "POST" && r.path === "/v1/catalog-sources/push")`.

## Criteria

Notation per test: **Setup / Stimulus → Expect. FAILS when … . Control: … . Mutation: …**

### AC-01 Schemas (unit, `src/protocol/roster.test.ts`)

- `test_AC01_agent_report`: a full report (`repo`, `kind: "claude"`, `path: ".claude/agents/reviewer.md"`,
  `name: "reviewer"`, 64-hex `hash`, `description`, `model`, `tools: ["Read"]`, `rules: ["r.alpha"]`,
  `pin: {source: SRC, commit: C1, hash: H1}`) parses; `hash` of 63 hex / uppercase hex, `tools` of 101
  items, `kind: "cursor"` each fail. FAILS when the full report fails or a bad one parses. Control: the
  full report and `tools` of exactly 100 items parse. Mutation: `tools.max(101)` → red; `kind` as
  `z.string()` → red.
- `test_AC01_sync_agents_cap`: `SyncRequest` with `machine.agents` of 2000 reports parses, 2001 fails;
  without `agents` parses and the parsed value has no `agents` key (absent stays absent, `[]` stays
  `[]`). Mutation: `.max(2001)` → red; `.default([])` on the field → red (absent turns into `[]`).
- `test_AC01_agents_lock`: `{version: 1, agents: [{name, source, commit, hash}]}` parses; `version: 2`
  fails; an entry with an extra key `x` fails. Control: `version: 1`, `agents: []` parses. Mutation:
  entries without `.strict()` → red.
- `test_AC01_catalog_push`: valid body (40-hex commit, one def of 100 000 chars) parses; 39-hex commit,
  a text of 100 001 chars, 2001 defs, an extra top-level key each fail; a body whose texts total
  8 000 100 chars (100 × 80 001) **parses** (the total is a hub check, not schema). Mutation:
  `text.max(100001)` → red; adding a summed-length refinement to the schema → red (that total belongs
  to AC-08's 422).
- `test_AC01_step_policy_agent`: `StepPolicy` `agent` = `auditor`, `agents/reviewer`,
  `git.example.com/team/agents/reviewer@1a2b3c4` (each with `mode: "headless"`) parse; `a/b@xyz` fails
  with message exactly `ROSTER_KEY_RULE` (`"agent key must be <source>/<name>[@<7-64 hex>]"`); `-x` fails
  with the RL-1 message (text copied from the existing RL-1 test, not from source). Control: the three
  positives. Mutation: run the RL-1 name check before testing for `/` → `agents/reviewer` red; use the
  RL-1 message for `a/b@xyz` → red.
- `test_AC01_parse_roster_key`: `parseRosterKey("Example.com/Team/Agents/rev@abcdef1")` toEqual
  `{source: "example.com/team/agents", name: "rev", ref: "abcdef1"}` (source lowercased, name case
  kept); `"agents/rev"` → `{source: "agents", name: "rev"}` with no `ref` key; `"rev"`, `"a/"`,
  `"a/b@abc"` (ref < 7), `"a/b@" + "f".repeat(65)`, a 201-char key → `undefined`; a 200-char valid key
  parses. Mutation: lowercase the name too → red; `{6,64}` → `a/b@abcdef` (6) parses → red (add that
  case); drop the length cap → red.
- `test_AC01_pulse_goal_agents`: a stored pulse literal without `agents` parses with `agents` `{}`;
  `Goal` without `agents` parses with no key; `AgentDef` with an extra key fails. Mutation: `Pulse.agents`
  without `.default({})` → red.

### AC-02 Pure functions (unit, `src/core/roster.test.ts`)

- `test_AC02_catalog_digest`: defs `[{path: "agents/b.md", hash: HB}, {path: "agents/a.md", hash: HA}]`
  and the reverse order both equal `sha("agents/a.md\t" + HA + "\n" + "agents/b.md\t" + HB + "\n")`;
  `[]` = `sha("")` (`e3b0c442…b855`). Sorting by code points: paths `agents/B.md` and `agents/a.md` give
  `B` first. FAILS on any other string. Mutation: `localeCompare` sort → red (the `B`/`a` case); join
  without the final `\n` → red.
- `test_AC02_unified_diff_example`: `unifiedDiff("a\nb\nc\n", "a\nB\nc\n", "x", "y")` ===
  `"--- x\n+++ y\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n"`. Mutation: omit `,<n>` when n is 1 elsewhere is
  covered below; swap `-`/`+` order → red.
- `test_AC02_unified_diff_equal_crlf`: `("a\r\nb\r\n", "a\nb\n")` → `""`; `("a\nb", "a\nb\n")` → `""`
  (missing final newline compared as present). Control: `("a\n", "b\n")` is non-empty. Mutation: no CRLF
  normalisation → red.
- `test_AC02_unified_diff_add_only`: `("", "p\nq\n", "x", "y")` = `"--- x\n+++ y\n@@ -0,0 +1,2 @@\n+p\n+q\n"`;
  `("p\n", "", …)` = `…@@ -1,1 +0,0 @@\n-p\n`. Mutation: start 1 for an empty side → red.
- `test_AC02_unified_diff_hunks`: 20 lines `l1..l20`; change lines 5 and 12 (6 unchanged between) → one
  `@@` header (`@@ -2,14 +2,14 @@`); change 5 and 13 (7 between) → exactly two `@@` headers
  (`@@ -2,7 +2,7 @@` and `@@ -10,7 +10,7 @@`). A run of two replaced lines prints both `-` before both `+`.
  Single changed line in a 1-line file: `("a\n", "b\n")` → `@@ -1,1 +1,1 @@`. Mutation: merge threshold
  `≤ 7` → red; interleaved `-`/`+` → red.
- `test_AC02_canonical_key`: `canonicalKey("git.example.com/team/agents", "rev")` = `"agents/rev"`;
  `canonicalKey("agents", "rev")` = `"agents/rev"`. Mutation: first segment instead of last → red.

### AC-03 Store contract (`src/store/hub-store.contract.test.ts`, SQLite; Postgres leg when `MESH_TEST_PG_URL`)

- `test_AC03_schema_version`: `SCHEMA_VERSION === 11`, `HUB_MIGRATIONS.length === 11`,
  `HUB_MIGRATIONS_PG.length === 11`. Mutation: forget the PG entry → red.
- `test_AC03_v10_migrates`: build a v10 SQLite file by applying the first 10 migrations, insert a goal,
  a pulse and an item (with their store calls at v10 or raw rows), open it with the current store → the
  three read back deep-equal; `listRepoAgents()` = `[]`, `listCatalogSources()` = `[]`. Postgres: same on
  a fresh DB (not run here). FAILS when a row is lost or the open throws. Mutation: migration 11 drops and
  recreates `goal` → red.
- `test_AC03_replace_machine_agents`: m1 with reports `[r1, r2]`, m2 with `[r3]` → `true` each;
  `replaceMachineAgents("m1", [r1, r2])` again → `false`; `replaceMachineAgents("m1", [r2])` → `true`;
  `listRepoAgents()` = r2 (machine m1) + r3 (machine m2) with `at`; `listRepoAgents({name: r3.name})` =
  r3 only. FAILS when m2's row disappears or an identical set returns `true`. Control: the `true`
  returns. Mutation: delete all repo-origin rows instead of the machine's → red; always return `true` → red.
- `test_AC03_put_catalog_defs`: `putCatalogDefs(SRC, C1, [rev H1, other HO])` → `{added: 2}`;
  `(SRC, C2, [rev H1, other HO])` → `{added: 0}`, rev's `commits` = `[C1, C2]`; again `(SRC, C2, …)` →
  commits still `[C1, C2]` (no duplicate); `(SRC, C3, [rev H2])` → `{added: 1}`;
  `listCatalogDefs({repo: SRC, current: true})` = rev H2 only; `listCatalogDefs({repo: SRC, name:
  "other"})` still holds HO with its `text` and `current: false`; 52 pushes of rev H2 at distinct commits
  → `commits.length === 50`, oldest two dropped, newest last. Filter `{name: "rev"}` across two repos
  returns both repos' rows; `{current: false}` returns only non-current. Mutation: keep 51 → red; delete
  texts not pushed → red; leave `other` current → red.
- `test_AC03_catalog_sources`: `saveCatalogSource` two sources, `getCatalogSource(SRC)` deep-equals the
  saved value, `getCatalogSource("x/y")` undefined, `listCatalogSources()` ordered by repo id. Mutation:
  list by `created_at` with reverse insertion → red.
- `test_AC03_tables_and_migrate`: `TABLES` names include `agent_def` and `catalog_source` right after
  `pulse_slot`; `mesh hub migrate` from a SQLite store holding a source and two defs into a fresh SQLite
  (and Postgres when set) → same `listCatalogSources()` and `listCatalogDefs({})` (texts included).
  Mutation: leave `catalog_source` out of `TABLES` → red.

### AC-04 Discovery (unit, `src/daemon/roster.test.ts`, temp dirs with `fakeCheckout`)

- `test_AC04_scan_two_reports`: checkout A (`fakeCheckout(dir, "https://git.example.com/team/alpha.git")`)
  holding `.claude/agents/reviewer.md` (REV1), `.claude/agents/bad name.md`, `.claude/agents/big.md`
  (300 KB), `.claude/agents/sub/x.md`, `.opencode/agent/doc.md` (front matter `tools: {read: true}`,
  `description`) → exactly two reports, `reviewer` (`kind: "claude"`, `path: ".claude/agents/reviewer.md"`,
  `hash: H1`, `description`, `model`, `tools: ["Read", "Grep"]`, `rules: ["r.alpha", "r.beta"]`,
  `repo: ALPHA`) then `doc` (`kind: "opencode"`, no `tools` key). Hash equals the test oracle **and**
  `agentFileHash(REV1)`. FAILS on a missing/extra/out-of-order report or a different field. Control:
  `reviewer` present. Mutation: no size cap → red (big.md reported); `name` from front matter → red;
  opencode before claude → red.
- `test_AC04_skips_and_first_wins`: the same list with a second checkout of the same remote (another
  agent inside) after A, a checkout with no remote, and a checkout whose repo id starts with `local/` →
  same two reports. Control: reversed order makes the second checkout's agent appear (first wins).
  Mutation: last checkout wins → red.
- `test_AC04_caps`: 2001 agent files `a0000.md…a2000.md` → 2000 reports, the last `a1999`; a
  description of 1500 chars → 1000; 150 tools → 100; 250 rules → 200; a rule entry of 101 chars is
  dropped while the others stay. Mutation: cut to 2001 → red; truncate an over-long rule instead of
  dropping → red.
- `test_AC04_pins`: `.mesh/agents.lock` with an entry `{name: "reviewer", source: SRC, commit: C1, hash:
  H1}` and one for `ghost` → `reviewer.pin` = `{source, commit, hash}`; `doc` (opencode, even with a
  lock entry named `doc`) has no pin; an invalid lock (`version: 2`) → no report has `pin`. Mutation:
  pin opencode files → red; accept a lock with `version: 2` → red.

### AC-05 Sync (World `test/roster-daemon.test.ts` + hub API `test/roster-hub.test.ts`)

- `test_AC05_daemon_reports` (daemon): alice's daemon `shareSessions: "me"`, `repoId: ALPHA`, checkout
  with `.claude/agents/{reviewer,other}.md`; `rescan` → last sync body has `machine.agents` of 2;
  `GET /v1/agents` as alice → two groups with copies `alpha/reviewer`, `alpha/other`, `origin: "repo"`,
  `machines: 1`; one `agents.reported {machine, count: 2}`. Next `rescan` without changes → that sync
  has no `agents` key and no new `agents.reported`. Delete `other.md`, `rescan` → the sync carries 1
  report, `alpha/other` copy gone, a second `agents.reported` with `count: 1`. FAILS on a copy kept,
  a key sent without a change, or a missing/extra event. Mutation: always send `agents` → red; hub
  emits the event on every sync with the key → red.
- `test_AC05_switch_to_steps` (daemon): continue: switch alice's share to `steps` (config change +
  restart as MM-1 tests do), sync → alice sees no repo copies (`GET /v1/agents` no `repo` origin copy).
  Control: before the switch she saw them. Mutation: visibility by report rather than stored share → red.
- `test_AC05_steps_from_start` (daemon): carol's daemon `steps` with the same checkout → over three
  rescans every `p.syncs[i].machine.agents` is absent or `[]`; no `agent_def` rows visible (as an admin
  with share irrelevance: `listRepoAgents` via the World hub store if exposed, else `GET /v1/agents` as
  carol). Mutation: scan under `steps` → red.
- `test_AC05_outside_inventory` (hub API): `report(m, [alpha reviewer, beta reviewer])` with
  `repos: [ALPHA]` only → `GET /v1/agents` as the user shows `alpha/reviewer`, no `beta/reviewer`.
  Control: the alpha copy present. Mutation: no inventory filter → red.
- `test_AC05_old_daemon_steps` (hub API): `report(m, [alpha reviewer], "me")` → visible to its user;
  then a sync with `machine: {share: "steps", repos}` and no `agents` key → its user sees no copy (rows
  kept: switching back to `me` without an `agents` key shows the copy again). Mutation: drop rows on
  `steps` → the restore control red; ignore stored share → red.

### AC-06 Visibility (World, `test/roster-hub.test.ts`)

- `test_AC06_me_then_all`: alice's machine reports `alpha/reviewer` under `me`; a source with a pushed
  `rev`. As alice: the repo copy and the catalog copy `agents/rev`; as carol: only the catalog copy.
  alice syncs `share: "all"` → carol sees the repo copy. Service token with `goals:read` sees the catalog
  copy. FAILS when carol sees the repo copy under `me` or not under `all`. Control: alice's own view and
  carol's catalog copy. Mutation: `me` visible to all members → red; catalog filtered by share → red.

### AC-07 Catalog source route (World hub API)

- `test_AC07_member_403`: carol `POST /v1/catalog-sources {repo: SRC_URL, folder: "agents"}` → 403;
  no `catalog.saved` event. Control: bob's call below → 201.
- `test_AC07_admin_create_replace`: bob with `SRC_URL` → 201, body `repo: "git.example.com/team/agents"`,
  `name: "agents"`, `folder: "agents"`, `createdBy: "bob"`, `count: 0`, no `commit`; event
  `catalog.saved {repo: SRC, folder: "agents"}`. Again with `folder: "defs", calibrator: "carol"` →
  200, `createdAt`/`createdBy` equal to the first, `folder: "defs"`, `calibrator: "carol"`. After a push
  between the two saves, the 200 reply keeps `commit`, `digest`, `count`. `repo: "Git.Example.com/Team/X.git"`
  (id form) → 201 `git.example.com/team/x`. Mutation: replace resets `createdAt` → red; 201 on
  replace → red.
- `test_AC07_422_texts`: `repo: "nope"` → 422 `repo must be a repo id (host/path) or a remote URL`;
  `folder: "../x"`, `"a/./b"`, `"/abs"` → 422 `folder must be a relative path inside the repo`;
  `repo: "https://git.example.com/team/a~b.git"` → 422 `repo id git.example.com/team/a~b cannot be used in
  an agent key` (the id as `repoFromRemote` gives it; the test asserts the prefix `repo id ` and suffix
  ` cannot be used in an agent key`, plus that it contains `a~b`). Control: valid saves above.
  Mutation: accept `..` segments → red.
- `test_AC07_list`: `GET /v1/catalog-sources` as carol → `{sources}` containing SRC (and the
  `git.example.com/team/x` one), ordered by repo id. Mutation: admin-only GET → red.

### AC-08 Push route (World hub API)

- `test_AC08_refusals`: a source SRC; a login token without machine (`w.login` web token or service
  token) → 403 `a catalog push needs a device token`; a device token of a machine reporting SRC pushing
  `repo: "git.example.com/team/none"` → 404 `no catalog source git.example.com/team/none`; a machine
  whose inventory lacks SRC → 403 `this machine does not report git.example.com/team/agents in its repo
  inventory`; paths `agents/x/y.md`, `agents/bad name.md`, `other/rev.md` → 422 `catalog push: <path> is
  not agents/<name>.md`; two defs at `agents/rev.md` → 422 `catalog push: agents/rev.md appears twice`;
  100 defs × 80 001 chars → 422 `catalog push: texts total 8000100 characters, over 8000000`. After all
  of them: no `catalog.pushed` event, source without `commit`. Control: `test_AC08_valid_pushes` with the
  same machine. Mutation: skip the inventory check → red; `>=` cap at 8 000 000 exactly — add a push
  totalling 8 000 000 that must succeed → red.
- `test_AC08_valid_pushes`: push `C1 {rev: REV1, other: OTHER}` → 200 `added: 2`, `source.count: 2`,
  `source.commit: C1`, `source.digest = catalogDigest` computed by the test as `sha` of the sorted
  `<path>\t<hash>\n` lines, `pushedBy` = the user; event `catalog.pushed {repo: SRC, commit: C1, added: 2,
  count: 2}` with no `text`/`path`/`description` key. Push `C2 {rev: REV2}` → `added: 1`, `count: 1`;
  `GET /v1/agents/resolve?key=agents/other` → 404 `no agent other in catalog source <SRC>`;
  `?key=agents/other@<HO first 12>` → 200 with `text: OTHER`; two `catalog.pushed` events. Mutation:
  delete texts of dropped names → red; `count` counts all stored defs → red.

### AC-09 Daemon push (World `test/roster-daemon.test.ts`, real git checkouts)

Fixture: alice's daemon (`me`), `repoId` = SRC, checkout a real git repo (`git init`, remote `origin`
`SRC_URL`) with `agents/rev.md` = REV1 committed at `A1`; bob registers SRC with folder `agents`.

- `test_AC09_pushes_committed`: `rescan` → exactly one push call; `resolve agents/rev` text === REV1
  byte for byte (CRLF kept), `commit` = `git rev-parse HEAD` = A1. Next `rescan` → no new push call.
  Mutation: push on every rescan → red; normalise CRLF before storing → red.
- `test_AC09_uncommitted_ignored`: edit `rev.md` (not committed) + untracked `agents/new.md` →
  `rescan` → no push call, resolve still REV1. Commit the edit (A2) → `rescan` → exactly one push with
  `commit: A2` and the edited text; resolve `agents/new` still 404 (untracked). Mutation: read the
  working tree → red.
- `test_AC09_origin_head`: commit A3 (rev REV3) locally; set `refs/remotes/origin/main` = A2 and
  `refs/remotes/origin/HEAD` → `refs/remotes/origin/main`; fresh source (or before any push) → the push
  has `commit: A2` and A2's text, not A3's. Mutation: use `HEAD` before `origin/HEAD` → red.
- `test_AC09_two_daemons_forward_only`: two daemons (alice, carol, both `me`) with clones: alice at C1,
  carol at C2 (child of C1, changes `rev`). Run in order alice-then-carol and, in a second World,
  carol-then-alice: in both, source `commit` = C2, current rev = C2's text; carol-first: alice's rescan
  makes no push call and logs `catalog push of git.example.com/team/agents skipped: <C1_7> does not
  descend from <C2_7>`; then two more rescans each → no push call from either. FAILS when the source
  moves back to C1. Mutation: no `merge-base --is-ancestor` check → red.
- `test_AC09_steps_and_404`: a `steps` daemon with the same checkout → no `GET /v1/catalog-sources` and
  no push in `p.requests`. `failOnce(/\/v1\/catalog-sources$/, 404)` on alice → that rescan's sync is
  still sent and accepted (`p.syncs` grows, sessions/inventory updated), and the next rescan pushes.
  Mutation: throw out of the scan on the 404 → red.

### AC-10 `GET /v1/agents` (World hub API)

Fixture (raw syncs, so hashes are exact): source SRC, pushes so the current `reviewer` is H3 at C3 (with
an older push of H1 at C1). Machine m1 (alice, `all`) reports `alpha/reviewer` H1 pinned `{SRC, C1, H1}`,
`beta/reviewer` H2 pinned `{SRC, C1, H1}`, `gamma/reviewer` H2 unpinned (claude) and
`gamma` `.opencode/agent/reviewer.md` H2, `aardvark/reviewer` H3 unpinned with a different
`description` than the catalog; machine m2 (carol, `all`) reports the same `alpha/reviewer` copy.

- `test_AC10_group_flags`: `GET /v1/agents` as alice → one group `reviewer` with `diverged`, `pinned`,
  `behind`, `modified` all true. Copy `alpha/reviewer`: `pinned` true, `behind` true, `modified` false,
  `machines: 2`, `seenAt` = the newer report time. Copy `beta/reviewer`: `modified` true, `behind` true.
  Catalog copy `agents/reviewer`: `origin: "catalog"`, `commit: C3`, `seenAt` = its `pushedAt`, all three
  flags false. Mutation: `behind` compares against the copy's hash instead of the pin hash → red;
  catalog copy `pinned: true` → red.
- `test_AC10_order`: versions = `[H2 (3 copies), H3 (2: catalog, aardvark), H1 (1: alpha, merged)]`; a tie
  variant (a second `delta/reviewer` H1 copy) is then ordered by hash ascending, computed in the test; in H2 the copies are `beta/reviewer`, `gamma/reviewer` claude,
  `gamma/reviewer` opencode; in H3 the catalog copy comes first although `aardvark/reviewer` sorts
  before `agents/reviewer`; version H3's `description` = the catalog's (first copy). Groups ordered by
  name (add a second agent `zeta` and `other`). Mutation: copies by key only → red; front matter of the
  last copy → red.
- `test_AC10_filter_sources`: `?name=other-name` (no such agent) → `agents: []`, `sources` still lists
  SRC; `?name=reviewer` → only that group. Control: unfiltered call has ≥ 2 groups. Mutation: ignore
  `name` → red.

### AC-11 Resolve (World hub API)

Fixture: SRC with pushes C1 `{rev: REV1}`, C2 `{rev: REV2}`; ambiguity fixtures added per test.

- `test_AC11_current_and_refs`: `?key=agents/rev` → 200 `CatalogDefView` with `text: REV2`, `hash: H2`,
  `commit: C2`, `current: true`, `key: "agents/rev"`, `source: SRC`, `commits: [C2]`; `@<C1 first 7>` →
  `hash: H1`, `commit: C1`, `current: false`; `@<H1 first 12>` → H1; full source key
  `git.example.com/team/agents/rev` → H2. After a third push C3 identical to C2, `@<C2_7>` → commit C2
  (the matched one), no ref → commit C3 (newest). Mutation: `commit` always newest → red.
- `test_AC11_errors`: no `key` → 400 `{error: ROSTER_KEY_RULE}`; `a/b@xyz` → 400 same; `nosuch/rev` →
  404 `no catalog source matches nosuch`; `agents/nope` → 404 `no agent nope in catalog source
  git.example.com/team/agents`; register SRC2 (`other/agents`) → `agents/rev` → 409 `agents matches 2
  catalog sources: git.example.com/other/agents, git.example.com/team/agents` (ids in the order the
  test asserts with a sorted comparison of the list part), while the full id key still resolves (200);
  `agents/rev@0000000` → 404 `no definition of agents/rev matches @0000000`; a ref matching two hashes
  (choose texts until H1 and a third hash share a first hex char, or use a 7-char commit prefix shared by
  two pushes with different texts: commits `abcdef1…` and `abcdef2…`, ref `abcdef`, too short — so use
  commits `abcdef1a…` and `abcdef1b…`, ref `abcdef1`) → 409 `@abcdef1 matches 2 definitions of
  agents/rev; give more characters`. Control: each fixture also resolves something valid. Mutation:
  first match wins on ambiguity → red.

### AC-12 `mesh agents` (CLI `test/roster-cli.test.ts`, hub of a World, `Relay.cli`)

- `test_AC12_lines`: the AC-10 roster (alice's view) → stdout equals the expected lines built in the
  test: `reviewer  versions 3  copies 6  diverged  pinned  behind  modified`, per version
  `  <hash12>  <description or ->`, per copy `    <key>  repo` / `    agents/reviewer  catalog <C3_7>`,
  `    alpha/reviewer  repo  pin <C1_7>  behind`, `    beta/reviewer  repo  pin <C1_7>  behind  modified`;
  exit 0. Mutation: flags in another order → red; full hash → red.
- `test_AC12_name_json_empty`: `--name reviewer` → only that group; `--json` → `JSON.parse(stdout)`
  deep-equals `GET /v1/agents` and stdout is 2-space indented; a fresh World → `No agents on the
  roster.` exit 0. Mutation: `--name` not passed to the hub → red.

### AC-13 `mesh agent add` (CLI)

Fixture: SRC pushed with REV1 (CRLF) at C1; a real git checkout `repo` (no `.mesh`).

- `test_AC13_install_bytes_and_lock`: `mesh agent add agents/rev --repo <repo>/sub/dir` → exit 0, stdout
  `Installed agents/rev@<C1_7> into .claude/agents/rev.md (hash <H1_12>); pinned in .mesh/agents.lock.`;
  `<repo>/.claude/agents/rev.md` buffer equals REV1 (CRLF kept); `.mesh/agents.lock` text ===
  `JSON.stringify({version: 1, agents: [{name: "rev", source: "git.example.com/team/agents", commit: C1,
  hash: H1}]}, null, 2) + "\n"`. Mutation: write `source: "agents"` (key as typed) → red; normalise line
  endings → red.
- `test_AC13_second_agent_sorted`: `add agents/other` → lock has `other` then `rev` (sorted by name),
  `rev` unchanged. Mutation: append instead of sort → red.
- `test_AC13_existing_differs`: overwrite `rev.md` with `x` → `add agents/rev` → exit 1, stderr/stdout
  `<repo>/.claude/agents/rev.md exists and differs from agents/rev@<C1_7>; use --force to replace it`;
  file still `x`, lock bytes unchanged. `--force` → file = REV1, exit 0. Control: an existing file equal
  to REV1 (no `--force`) → exit 0. Mutation: ignore the existing file → red.
- `test_AC13_errors`: `--repo <tmp dir without .git>` → exit 2 `not in a git checkout: <path>`; `add
  rev` → exit 2 with `ROSTER_KEY_RULE`; `add agents/nope` → exit 1 `no agent nope in catalog source
  git.example.com/team/agents`, nothing written (no `.mesh`, no `.claude`). Mutation: create the lock
  before resolve → red.

### AC-14 `mesh agent outdated` (CLI)

Fixture: catalog `a`, `b`, `c`, `d`, `e`, `f` pushed at C1, installed with `add`; then a push at C2
changes `c` and `d`, drops `f`; locally edit `b` and `d`, delete `e`'s file.

- `test_AC14_statuses`: exit 1; lines (lock order) `a  agents/a@<C1_7>  ok`, `b  …  modified`,
  `c  …  behind  latest <C2_7>`, `d  …  modified,behind  latest <C2_7>`, `e  …  missing`, `f  …  gone`.
  Mutation: `gone` for every resolve failure → red in the next test; `behind,modified` order → red.
- `test_AC14_all_ok_and_no_lock`: a lock whose entries are all current → exit 0; no lock → `No pinned
  agents in <root>.` exit 0. Mutation: exit 1 when no lock → red.
- `test_AC14_json`: `--json` → `{agents: [...]}` with each `{name, source, commit, hash, status}`, and
  `latest: {hash, commit: C2}` only on `c` and `d`. Mutation: `latest` on every entry → red.
- `test_AC14_hub_failures`: hub stopped (`w.stopHub()`) → exit 1, the error text printed, no line
  matching `/  (ok|gone|missing|modified|behind)/`; a revoked/invalid token (401) → the same shape.
  Control: after `startHubAgain` the status lines return. Mutation: treat any 404 or error as `gone` → red.

### AC-15 `mesh agent diff` (CLI)

- `test_AC15_diff`: installed REV1 pinned at C1, latest REV2 at C2 → stdout = `unifiedDiff(REV1, REV2,
  ".claude/agents/rev.md", "agents/rev@<C2_7>")` (the function imported from `src/core`, plus the test's
  own literal for the one-line change: `@@ -5,3 +5,3 @@` region with `-You review.` / `+You review
  carefully.`), exit 0. Installed file missing → diff from `""`. Identical (after `update`) →
  `rev: no difference from agents/rev@<C2_7>` exit 0. `diff ghost` → exit 1 `ghost is not pinned in
  <root>/.mesh/agents.lock`. Mutation: labels swapped → red.

### AC-16 `mesh agent update` (CLI, injected `readLine` through the CLI test seam)

- `test_AC16_up_to_date`: pinned = latest = file → `rev is up to date (agents/rev@<C1_7>).` exit 0; file
  and lock mtime/bytes unchanged.
- `test_AC16_confirm_yes`: latest at C2, `readLine` answers `Y` → stdout has the diff, then the prompt
  exactly `Replace .claude/agents/rev.md with agents/rev@<C2_7>? [y/N] `, then `Updated rev to
  agents/rev@<C2_7> (hash <H2_12>).`; file = REV2, lock entry `{commit: C2, hash: H2}`, exit 0.
- `test_AC16_confirm_no`: answer `n` → `Not updated.` exit 1, file and lock bytes unchanged. Answer `""`
  → same. Mutation: default yes → red.
- `test_AC16_no_terminal`: no `readLine`, stdin not a TTY → `Not updated: run with --yes to confirm
  without a terminal.` exit 1, nothing written; `--yes` → updated, no prompt in stdout. Mutation: write
  without confirmation → red.
- `test_AC16_modified_only`: latest = pin but file edited → not "up to date"; update restores REV1 after
  `y`. Mutation: compare only pin and latest → red.

### AC-17 `mesh agent source` and help (CLI)

- `test_AC17_source_add_ls`: bob `mesh agent source add https://git.example.com/Team/Agents.git --folder
  agents` → `Saved catalog source git.example.com/team/agents (folder agents).` exit 0; carol same → exit
  1 with the hub's 403 text; `ls` before → `No catalog sources.`, after one push with a calibrator →
  `git.example.com/team/agents  agents  2 agent(s)  <C1_7>  calibrator carol`, a second unpushed source
  `…  0 agent(s)  -`; `--json` = `GET /v1/catalog-sources` reply. Missing `--folder` → usage, exit 2.
- `test_AC17_help`: `mesh help` lists `agents` and `agent`. Mutation: drop from help → red.

### AC-18 Validation (World hub API)

- `test_AC18_plan_ok`: SRC with `rev`; plan with a headless step `{id: "audit", mode: "headless", agent:
  "agents/rev"}` → 201; `stepOf` policy `agent === "agents/rev"` (not rewritten to an id or hash).
  Mutation: store the resolved hash in the policy → red.
- `test_AC18_plan_errors`: `agent: "nosuch/rev"` → 422 whose problems include exactly `step "audit": no
  catalog source matches nosuch`; `agent: "agents/rev"` without `mode` → the RL-1 problem text (copied
  from the RL-1 test) and no roster problem required; goal plan unchanged (no plan stored). Control:
  `test_AC18_plan_ok`. Mutation: skip resolve on plan propose → red.
- `test_AC18_pulse_and_preset`: a preset whose headless step uses `agent: "{{agent}}"` (the
  `RELAY_PARAMS` shape) with `params.agent = "agents/nope"` → `POST /v1/pulses` 422 problem `step
  "<id>": no agent nope in catalog source git.example.com/team/agents`; same body on `POST
  /v1/goals/from-preset` → same 422, no pulse or goal created. Control: `agents/rev` → 201. Mutation:
  validate pulses before parameter substitution → red.

### AC-19 Goal pins and offers (World hub API; a bare headless-capable machine for offers)

- `test_AC19_pin_on_approve`: approve a plan with step `audit` `agent: "agents/rev"` (current H1, C1) →
  `GET` goal `agents["agents/rev"]` toEqual `{key: "agents/rev", source: SRC, name: "rev", hash: H1,
  commit: C1}`; assign `audit` → offer data `agentDef` equals it, `agent === "agents/rev"`, no
  `agentError`. Mutation: no pin on approve → red.
- `test_AC19_offer_stable`: after that, push `rev` REV2 and register SRC2 (same name `agents`); a new
  offer of a second step with the same key (or a re-assign after decline) → still `agentDef.hash === H1`,
  no `agentError`. Mutation: offers resolve at offer time → red (H2, or 409 from the ambiguity).
- `test_AC19_ref_and_v2`: step with `agents/rev@<C1_7>` while current is H2 → pinned hash H1, commit C1;
  propose and approve a v2 plan with the same `agents/rev` key while current is H3 → entry still H1;
  a v2 step with a new key `agents/rev@<H3_12>` adds that entry with H3. Mutation: re-resolve on every
  approval → red.
- `test_AC19_approve_fails`: propose a plan with `agents/rev2`, push without `rev2`, approve → 422
  `the plan has 1 problem(s): step "<id>": no agent rev2 in catalog source git.example.com/team/agents`;
  the plan stays pending (`GET` shows the pending plan, no `agents` entry, no steps ready). Control: the
  same approve after re-pushing `rev2` → 200. Mutation: approve then pin best-effort → red.
- `test_AC19_not_pinned_and_rl1`: remove the goal's entry through the hub store (World hub store
  handle or `storeWrap` on the goal read; see Risks) → offer data `agentError === "agents/rev is not
  pinned in <G>"` and no `agentDef`; the offer is still made. A step `agent: "auditor"` → offer data has
  neither `agentDef` nor `agentError`. Mutation: resolve as a fallback → red.

### AC-20 Roster run (World + fake claude, `test/roster-daemon.test.ts`)

Fixture: alice `headlessPerson` (its checkout has **no** `.claude/agents/rev.md`); SRC pushed with REV1
(front matter tools `Read, Grep`, model `sonnet`, `mesh-rules: [r.alpha, r.beta]`); goal on alice's repo
with headless `audit` `agent: "agents/rev"` approved and offered to her machine.

- `test_AC20_argv_files`: `r.started("audit")` → the fake's argv equals the RL-1 argv shape (asserted as
  in the RL-1 tests) and ends with `--agents <runDir>/agents.json --agent rev`; `<runDir>/agent.md`
  bytes === REV1; `agents.json` parses to `{rev: {description: "Reviews code", prompt: <body after
  front matter, as RL-1 builds it>, tools: ["Read", "Grep", ...MESH_TOOL_RULES], model: "sonnet"}}`;
  `existsSync(<worktree>/.claude/agents/rev.md)` false before start and after `endRun`. Mutation: write
  the definition into the worktree → red; `--agent agents/rev` → red.
- `test_AC20_telemetry_rules`: the run's telemetry/run file has `agentKey: "agents/rev"`, `agentHash:
  H1`; the fake submits (through `mesh_review` in its script) a record with items of rules `r.alpha` and
  `r.zeta` → the review counts `r.zeta` undeclared and `r.alpha` declared (RL-2 counters as their
  tests read them). Mutation: read rules from the worktree → red (no file there, all undeclared).

### AC-21 Roster run not started (World + fake claude)

- `test_AC21_agent_error`: goal entry removed (AC-19 method) → step `fail`, summary `headless run of
  audit did not start: roster agent agents/rev was not resolved by the hub: agents/rev is not pinned in
  <G>`; no calls file for `audit`. Control: AC-20 starts the fake.
- `test_AC21_resolve_404`: `failOnce(/\/v1\/agents\/resolve/, 404)` on alice → summary `…did not start:
  roster agent agents/rev is not available: simulated` (the `failOnce` error text); no calls file.
- `test_AC21_hash_mismatch`: hub stub: `storeWrap({listCatalogDefs})` returning the definition with a
  changed `text` (hash field unchanged) → summary `…roster agent agents/rev does not match its hash`;
  no calls file. Mutation (all three): start the fake despite the error → red; trust `agentDef.hash`
  without hashing the text → red.

### AC-22 Web Roster (Playwright `test/e2e-web/roster.spec.ts`, user `erin`)

- `test_AC22_nav_and_render`: seed via API: erin's device machine syncs (`share: "me"`, repo
  `git.example.com/e2e/roster-a`) reports `reviewer` pinned + modified; an admin of the e2e hub
  registers a source and a device pushes `reviewer` (another hash) and `linter`. Log in as erin; nav
  link `Roster` (after `Mine`) → URL `#/roster`, link has class `active`; `h2` `Roster`;
  `section.roster-group[data-name="reviewer"] span.roster-flag` texts `["diverged", "pinned", "behind",
  "modified"]`; `div.roster-version[data-hash=<full>]` shows hash12 and description, `tools: Read,
  Grep`, `rules: r.alpha, r.beta`; `li.roster-copy[data-key="roster-a/reviewer"]` contains `repo`,
  `pin <commit7>`, `behind`, `modified`; the catalog copy contains `catalog <commit7>`;
  `section.roster-sources li[data-repo=<id>]` contains folder and `2 agent(s)`.
- `test_AC22_filter`: type `LINT` → only `linter` group; type `zzz` → `p.empty` `No agent matches
  "zzz".`; clear → both groups. Control: both visible before.
- `test_AC22_live`: with the page open, erin's machine syncs a new agent `scribe` → `section.roster-group
  [data-name="scribe"]` visible within 20 s, no `page.reload()`. Mutation: load once on open → red.
- Empty state (`No agents on the roster yet.`) is asserted in a fresh-context check only if erin sees
  no group before seeding (first test, before seeding).

### AC-23 Docs (review + `test/schemas.test.ts`)

- `test_AC23_docs`: `docs/guide/concepts.md` has a `Roster` heading and mentions `.claude/agents`,
  `.opencode/agent`, `agents.lock`, `diverged`, `behind`, `modified`, `pinned`, `mesh-rules`,
  `rules.yaml`, `@`; `docs/guide/howto.md` has `Share agents through the roster` and the commands `mesh
  agents`, `mesh agent add`, `outdated`, `diff`, `update`; `docs/plan/implementation-plan.md` lists the
  five routes with v0.1.19; `docs/events.md` lists `catalog.saved`, `catalog.pushed`,
  `agents.reported`; `MESH_SKILL` contains `mesh agents` and `mesh agent add` and equals
  `skills/mesh/SKILL.md`. Generic-name check: grep the row's diff for team/company/person names; examples
  use `example.com` (review step).

### AC-24 Checks and schemas

- `test_AC24_openapi_routes`: `schemas/hub-api.openapi.json` equals `pnpm schemas` output and lists
  `POST /v1/catalog-sources` (rule `admin`, tag `admin`), `GET /v1/catalog-sources`, `GET /v1/agents`,
  `GET /v1/agents/resolve` (`member`, `goals:read`, tag `goals`), `POST /v1/catalog-sources/push`
  (`member`, tag `daemon`); `HUB_API` matches the served routes (existing check).
- `test_AC24_version`: `package.json` version `0.1.19`.
- `test_AC24_boundaries`: `catalogDigest`, `unifiedDiff`, `canonicalKey` exported from `src/core/index.ts`;
  roster types from `src/protocol/index.ts`; `pnpm boundaries` passes. Plus `pnpm check` and `pnpm
  test:web` after `pnpm build`.

### AC-25 R-6 for pulses (World hub API, `test/roster-hub.test.ts`)

Fixture: SRC current `rev` H1 at C1; preset `SOLO_HL`-shaped with headless step `agent: "{{agent}}"`,
params `agent: "agents/rev"`; device max age 60d.

- `test_AC25_pulse_pins`: `POST /v1/pulses` → stored pulse `agents["agents/rev"].hash === H1`,
  `PulseView.agents` toEqual `{"agents/rev": H1}`; `POST /v1/goals/from-preset` → goal
  `agents["agents/rev"].hash === H1`. Mutation: no pin at create → red.
- `test_AC25_fire_keeps_pin`: push `rev` H2; `fireOk` → the new goal's `agents["agents/rev"].hash ===
  H1`, its offer `agentDef.hash === H1`. Update `window` only → pulse still H1, next fire H1. Mutation:
  re-resolve on fire → red; update re-resolves always → red.
- `test_AC25_update_params_repins`: update `params` (e.g. a `repo` change or the same `agent` with
  another param value) → pulse `agents` hash H2; next fire offers `agentDef.hash === H2`. Same with a
  `preset` change. Control: the window-only update above kept H1. Mutation: re-pin only on `preset` →
  red.

## Risks and notes for the spec author

- 2026-11-12 **Rescan seam.** AC-05 and AC-09 need a deterministic rescan. The plan uses the clock +
  `tick` path MM-1 tests use; if the repo scan runs on a real timer, the test-writer asks the
  implementer for an exported trigger (not checked here, since the source was not read).
- 2026-11-12 **Removing a goal pin (AC-19, AC-21).** The spec says "entry removed through the store".
  The plan uses the World's hub store handle if the test side has one, else `Pk.storeWrap` on the goal
  read; either is acceptable as long as the HTTP surface is unchanged.
- 2026-11-12 **Hash-mismatch stub (AC-21).** `storeWrap` on `listCatalogDefs` assumes resolve reads
  through that store method (the only one the contract names that returns `text`). If it does not, the
  test-writer stubs the hub reply to the daemon instead (a request interceptor on the person), which is
  the "test hub stub" the criterion names.
- 2026-11-12 **AC-10 extra copies.** The criterion's fixture cannot distinguish "catalog first" and
  "by copies" orders with only alpha/beta/catalog; the plan adds `gamma` (two kinds) and `aardvark`
  copies. These are additions to the fixture, not new behaviour.
- 2026-11-12 **AC-11 409 order.** The spec says the ids are comma-separated but not their order; the
  plan compares the listed ids as a set (conservative reading).
- 2026-11-12 **AC-07 `a~b` text.** The id `repoFromRemote` produces for `a~b` is not specified; the plan
  asserts the message's fixed prefix, suffix and that it contains `a~b`.
- **Postgres legs** of the store contract (AC-03) run only with `MESH_TEST_PG_URL`; not run here, judged
  on the SQLite leg; CI runs them.
- **Checks run by the planner:** none (`pnpm lint`, `typecheck`, `boundaries`, `test`, `build`, `check`,
  `schemas`, `test:web` not run: this row only adds a Markdown plan; no code changed).
