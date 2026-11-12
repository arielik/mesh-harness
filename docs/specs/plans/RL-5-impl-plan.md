# RL-5 implementation plan: Roster

Spec: `docs/specs/RL-5.md` (revision 1, approved in review round 2). Branch: `feat/relay-design`.
Release v0.1.19. Design: `docs/analysis/2026-11-12-pulse-relay-roster.md` §5.10, §5.1, REQ-11, REQ-12,
R-4, R-6, §7, slice S5 of §9; `docs/analysis/2026-11-12-claude-cli-spike.md` 6a-6c (`--agents <file>`
plus `--agent <name>` work with `-p`; nothing needs to be written into the worktree).

This plan covers the implementation only. It plans no new tests: the test side writes them from the
spec's contracts and never reads this plan. Section 2 lists every existing test and generated file
whose asserted behaviour the spec changes, and nothing else. Section 3 records the choices this plan
makes where the spec leaves room; the spec itself is not changed by this plan. Section 4 has one
section per acceptance criterion (AC-01 .. AC-25): files, changes (functions), migrations, order
constraints, blast radius and risks.

## 0. Overview, build order, shared building blocks

Bottom-up along `.dependency-cruiser.cjs` (`protocol` has no internal imports; `core` ← `protocol`;
`store` ← `protocol`; `hub` ← `protocol`, `core`, `store`; `daemon` ← `protocol`, `core`, `store`,
`claude`; `cli` ← `protocol`, `core`, `claude`). Only `src/claude`, `src/mux` and `src/cli` may import
`node:child_process`: the daemon runs git through `src/claude` (`run`), never directly.

| Stage | Module | Work | Criteria |
|---|---|---|---|
| 1 | `src/protocol` | new `roster.ts` (schemas, `parseRosterKey`, `ROSTER_KEY_RULE`, view interfaces); `goal.ts` (`StepPolicy.agent`, `Goal.agents`); `pulse.ts` (`Pulse.agents`, `PulseView.agents`); `hub.ts` (`SyncRequest.machine.agents`); `hub-api.ts` (5 rows); `skill.ts` (`MESH_SKILL` rows); `index.ts` export | AC-01, AC-23, AC-24 |
| 2 | `src/core` | new `roster.ts`: `catalogDigest`, `unifiedDiff`, `canonicalKey`, `agentFront` (shared front matter reader); `index.ts` export | AC-02, AC-04, AC-08 |
| 3 | `src/store` | `hub-store.ts`: migration 11 (both dialects), 8 new methods; `hub-copy.ts`: `TABLES` | AC-03 |
| 4 | `src/hub` | `service.ts`: sync agents, catalog sources, push, agents view, resolve, roster validation, pins, offer data, event texts; `app.ts`: 5 routes | AC-05 .. AC-11, AC-18, AC-19, AC-25 |
| 5 | `src/claude` | `exec.ts`: `run` decodes stdout/stderr as UTF-8 streams (multi-byte safe) | AC-09 |
| 6 | `src/daemon` | new `roster.ts` (`scanAgents`, `catalogPushes`); `git.ts` (`remoteNameForCwd`); `daemon.ts` (scan, deps `git`/`scanAgents`, push after sync); `hub-link.ts` (`machine.agents`, `afterSync`); `runs.ts` (roster agents); `tools.ts` (rules from `agent.md`) | AC-04, AC-05, AC-09, AC-20, AC-21 |
| 7 | `src/cli` | new `roster-commands.ts` (`mesh agents`, `mesh agent …`); `mesh-commands.ts` registration | AC-12 .. AC-17 |
| 8 | `web/` | new `roster.tsx`; `main.tsx` nav and route; `api.ts`; `styles.css` | AC-22 |
| 9 | repo | docs, `skills/mesh/SKILL.md` via `pnpm schemas`, `schemas/*.json`, `package.json` 0.1.19, the existing tests of section 2, full check | AC-23, AC-24 |

Order constraints (global):
- Stage 1 first. Inside it `roster.ts` before `goal.ts`, `pulse.ts`, `hub.ts`: `goal.ts` and `pulse.ts`
  import `AgentDef` and the agent-name regex from `roster.ts`; `roster.ts` imports only `zod` (no
  import of `goal.ts`, else a cycle `goal.ts` → `roster.ts` → `goal.ts`, refused by the `no-circular` rule).
  `Repo` for `AgentCopy` is imported type-only from `session.ts` (which does not import `roster.ts`).
- Stage 2 before 4 and 6 (hub and daemon both use `agentFront`, `catalogDigest`, `canonicalKey`).
- Stage 3 before 4.
- Stage 5 before stage 6's catalog push (texts with multi-byte characters must arrive byte for byte).
- Stage 6 and 7 need the stage-4 routes beyond compiling; stage 8 needs `GET /v1/agents`.
- `pnpm schemas` after the last change to `src/protocol` (`HUB_API`, `SyncRequest`, `StepPolicy`/`PlanStep`,
  `Goal`, `Pulse`, `MESH_SKILL`).
- Docs and the version bump last.

### Shared building blocks

**B1. Protocol `src/protocol/roster.ts`** (new; `export * from "./roster.ts"` in `src/protocol/index.ts`,
placed before `./goal.ts`).
- `AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` and `AGENT_NAME_RULE` (the RL-1 message, moved
  here verbatim from `goal.ts`: "an agent name is 1-64 letters, digits, '.', '_' or '-', starting with a
  letter or digit"); `AgentName = z.string().regex(AGENT_NAME_RE, AGENT_NAME_RULE)`.
- `HEX40 = /^[0-9a-f]{40}$/`, `HEX64 = /^[0-9a-f]{64}$/`.
- `AgentKind`, `AgentFront` (`z.object`, each field optional with the caps of the spec), `AgentPin`,
  `AgentReport = AgentFront.extend({...})`, `AgentsLock` (entries `z.strictObject`; top level
  `z.object({version: z.literal(1), agents: z.array(entry)})`), `AgentDef` (`z.strictObject`),
  `CatalogSourceSave` and `CatalogPush` (`z.strictObject`; `defs` entries `z.object({path, text})`,
  `.max(2000)`).
- `ROSTER_KEY_RULE` and `ROSTER_KEY_RE` (the spec's regex); `parseRosterKey(s)`: `s.length > 200` or no
  match → `undefined`; else `{ source: m[1].toLowerCase(), name: m[2], ...(m[3] ? { ref: m[3] } : {}) }`.
  `"a/b@abc"` fails because the ref group needs 7-64 hex and `@abc` then leaves an unmatched tail.
- Interfaces `CatalogSourceView`, `CatalogDefView`, `AgentCopy`, `AgentVersion`, `AgentGroup`, `AgentsView`
  exactly as the spec's table (types only; `AgentCopy.repo: Repo` via `import type { Repo } from "./session.ts"`).

**B2. Core `src/core/roster.ts`** (new; exported from `src/core/index.ts` after `./headless.ts`).
- `canonicalKey(repoId, name)`: `${repoId.slice(repoId.lastIndexOf("/") + 1)}/${name}`.
- `catalogDigest(defs)`: copy, sort by `path` with `a < b ? -1 : a > b ? 1 : 0` (code-unit order, the
  same as code points for the ASCII paths the push allows), `createHash("sha256")` over
  `defs.map(d => `${d.path}\t${d.hash}\n`).join("")`, hex.
- `unifiedDiff(a, b, labelA, labelB)`: normalize CRLF→LF; equal → `""`. Split into lines with
  `text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n")`, and `""` → `[]` (a text
  without a final newline is compared as if it had one). LCS table over line arrays (O(n·m) memory;
  agent files are ≤ 256 KiB, see risk R5), backtrack preferring deletions first so that within a
  changed run all `-` come before all `+`. Build an edit script of `{op: " " | "-" | "+", line}`.
  Hunks: indices of changes; group changes whose gap of unchanged lines is ≤ 6 (2 × context); each hunk
  spans from 3 lines before its first change to 3 after its last (clamped). Header
  `@@ -<s1>,<n1> +<s2>,<n2> @@` with 1-based starts, and for a side with `n = 0` start = the line
  before (0 when at the top). Output `--- labelA\n+++ labelB\n` + hunks, each line `op + line + "\n"`.
- `agentFront(text): AgentFront` (shared by daemon discovery and the hub push so that "front matter as
  the daemon parses it" holds by construction): `parseAgentFile(text)` (from `./headless.ts`);
  `description` sliced to 1000; `model` kept only when ≤ 100 characters; `tools` (undefined when the
  front matter value is a map: `listField` already returns `undefined` for a non-array object) with
  entries over 200 characters dropped, then cut to 100; `rules` (from `mesh-rules`) with entries over
  100 dropped, then cut to 200; keys left out when undefined.

**B3. Hub private helpers** (`src/hub/service.ts`, new section `// ---------- roster (RL-5) ----------`
after the RL-4 debrief section).
- `static agentCopyVisible(viewer: Actor, m: MachineRow | undefined): boolean`: `m?.share === "all" ||
  (m?.share === "me" && m.userId === viewer.userId)`. Not `sessionVisible` (that lets the owner see
  everything; the spec hides `steps`/absent copies from the owner too).
- `resolveRoster(key): Promise<{ ok: true; def: CatalogDefView } | { ok: false; status: number; error: string }>`
  (never throws; used by validation, pins, the resolve route):
  1. `parseRosterKey(key)` undefined → `{400, ROSTER_KEY_RULE}`.
  2. `sources = store.listCatalogSources()`; exact `repo === source` else
     `sources.filter(s => repoMatches({id: s.repo, name: s.name}, source))`; 0 → 404
     `no catalog source matches ${source}`; > 1 → 409 `${source} matches ${n} catalog sources: ${ids.join(", ")}`.
  3. No ref: `listCatalogDefs({repo: S.repo, name, current: true})[0]` or 404
     `no agent ${name} in catalog source ${S.repo}`. With ref: `listCatalogDefs({repo, name})` filtered by
     `hash.startsWith(ref) || commits.some(c => c.startsWith(ref))`; none → 404
     `no definition of ${canonicalKey(S.repo, name)} matches @${ref}`; distinct hashes > 1 → 409
     `@${ref} matches ${n} definitions of ${key}; give more characters`; `commit` = the last (newest)
     entry of `commits` that starts with `ref`, else `commits.at(-1)`.
- `rosterKeysOf(steps)`: distinct `agent` values containing `/`, each with the first step id using it.
- `pinAgents(steps, existing: Record<string, AgentDef> = {}): Promise<{ agents: Record<string, AgentDef>; problems: string[] }>`:
  starts from `{...existing}`; for each roster key not in it, `resolveRoster`; ok →
  `{key: def.key, source: def.source, name: def.name, hash: def.hash, commit: def.commit}`; else problem
  `step "${id}": ${error}` for every step using that key.
- `rosterProblems(steps)` = `(await pinAgents(steps)).problems`.

## 1. Files touched (summary)

New: `src/protocol/roster.ts`, `src/core/roster.ts`, `src/daemon/roster.ts`, `src/cli/roster-commands.ts`,
`web/src/roster.tsx`.
Changed: `src/protocol/{index,goal,pulse,hub,hub-api,skill}.ts`, `src/core/index.ts`,
`src/store/{hub-store,hub-copy}.ts`, `src/hub/{service,app}.ts`, `src/claude/exec.ts`,
`src/daemon/{daemon,hub-link,runs,tools,git,index}.ts`, `src/cli/mesh-commands.ts`,
`web/src/{main.tsx,api.ts,styles.css}`, `docs/guide/{concepts,howto}.md`, `docs/plan/implementation-plan.md`,
`docs/events.md`, `skills/mesh/SKILL.md` (generated), `schemas/*.json` (generated), `package.json`.
No change to `src/main.ts` is needed (the daemon's git dep defaults in `defaultDeps`).

## 2. Existing tests and generated files whose asserted behaviour the spec changes

The spec's Compatibility section assigns the count/list updates to the test-writer; the developer
touches these only when the test side has not, and changes nothing else in them.

| File | Lines (as of 347299d) | Why | Change |
|---|---|---|---|
| `src/store/hub-store.contract.test.ts` | 435, 440, 576-578, 668-670, 769-771, 954-956, 1107-1109, 1301 | `SCHEMA_VERSION` and both migration lists become 11 | `10` → `11` |
| `src/store/hub-store.contract.test.ts` | 805, 988, 1162 | downgrade tests (v7/v8/v9 → current) assert the final version | `10` → `11` (migration 11 uses `IF NOT EXISTS`, so the dropped-and-rerun pattern still works; see R1) |
| `src/store/hub-store.contract.test.ts` | 1213, 1216 (`test_AC05_round_trip`) | a stored pulse without `agents` now reads as `agents: {}` (`Pulse.agents` `.default({})`) | expected objects gain `agents: {}` |
| `test/m46-ops.test.ts` | 71-74 | `/readyz` schema 10 → 11 | `schema: 11` (comment line gains "RL-5 (migration 11) to 11") |
| `test/schemas.test.ts` | 561 (`test_AC24_version`) | package version 0.1.19 | superseded by the new version pin, as the earlier pins were (comment) |
| `schemas/hub-api.openapi.json`, `schemas/*.json` | generated | new routes and schema fields | regenerate with `pnpm schemas` |
| `skills/mesh/SKILL.md` | generated | `MESH_SKILL` rows | regenerate with `pnpm schemas` |

Checked and not affected: the route-list tests (`test/schemas.test.ts` compare `HUB_API` to the served
routes; both change together), `mesh help` tests (they use `toMatch`/`toContain`), the CLI snapshots
(`test/__snapshots__/cli.test.ts.snap` holds service files only), `test/m46-ops.test.ts` table counts
(they name only their own tables), goal objects in tests (`Goal.agents` stays absent unless a roster key
is pinned, see C6).

## 3. Choices this plan makes where the spec leaves room

- C1. **Store ids.** `agent_def.id`: repo rows `r\n<machine>\n<repo>\n<path>`; catalog rows
  `c\n<repo>\n<name>\n<hash>`. Repo rows: `origin = "repo"`, `current = 1`, `body` NULL, `value` = the
  `AgentReport` JSON. Catalog rows: `origin = "catalog"`, `machine` NULL, `body` = text, `value` =
  `{path, commits, pushedAt, front}`. Within one sync, duplicate `(repo, path)` reports keep the first.
- C2. **`replaceMachineAgents` equality**: compare the stored and the new sets as JSON of the reports
  sorted by `(repo, path)`; equal → `false`, nothing written (so `seenAt` does not move without a change).
- C3. **Front matter caps**: over-length entries are dropped first, then the list is cut (B2); a
  `model` over 100 characters is left out (a report with it would fail `AgentReport`).
- C4. **Symlinks** in the agent folders are skipped (`lstatSync().isFile()`), matching "regular files
  directly in the folder only".
- C5. **Push texts** are read with `git cat-file blob <oid>` (the oid from `git ls-tree -z`), which
  gives the same bytes as `git show C:<path>` without path quoting. Text length is checked in UTF-16
  code units (`string.length`), the unit zod's `.max(100000)` uses.
- C6. **Empty pins**: `Goal.agents` is written only when it has at least one entry; `Pulse.agents` is
  always written (`{}` when none).
- C7. **Service tokens** see repo copies of `all` machines only (they are no machine's user) and every
  catalog copy.
- C8. **CLI root**: `--repo` resolved against the current folder; the refusal prints the resolved
  absolute path. An `.mesh/agents.lock` that exists but does not parse as `AgentsLock` → exit 1
  `<root>/.mesh/agents.lock is not a valid agents lock` for `add`/`update` (never overwritten); for
  `outdated`/`diff` the same text, exit 1.
- C9. **Catalog push timing**: one push pass after each sync that followed a new rescan (B6), serialized;
  its errors never fail the sync.
- C10. **Idempotency key** of a push: `catalog-<sha256(repo)[0..12]>-<commit>-<digest[0..12]>`.

## 4. Per acceptance criterion

### AC-01 Schemas and roster keys

Files: `src/protocol/roster.ts` (B1), `src/protocol/goal.ts`, `src/protocol/pulse.ts`, `src/protocol/hub.ts`, `src/protocol/index.ts`.

Changes:
- `goal.ts`: `import { AgentDef, AGENT_NAME_RE, AGENT_NAME_RULE, parseRosterKey, ROSTER_KEY_RULE } from "./roster.ts"`.
  `StepPolicy.agent` = `z.string().superRefine((s, ctx) => { if (s.includes("/")) { if (!parseRosterKey(s)) ctx.addIssue({ code: "custom", message: ROSTER_KEY_RULE }); } else if (!AGENT_NAME_RE.test(s)) ctx.addIssue({ code: "custom", message: AGENT_NAME_RULE }); }).optional()`.
  One issue per value, so `-x` yields exactly the RL-1 message and `a/b@xyz` exactly `ROSTER_KEY_RULE`.
  `Goal.agents: z.record(z.string(), AgentDef).optional()` after `profiles`.
- `pulse.ts`: `import { AgentDef } from "./roster.ts"`; `Pulse.agents: z.record(z.string(), AgentDef).default({})`
  after `profiles`; `PulseView = Omit<Pulse, "preset" | "profiles" | "agents"> & { …, agents: Record<string, string> }`.
- `hub.ts`: `SyncRequest.machine` gains `agents: z.array(AgentReport).max(2000).optional()`.
- `PlanStep` spreads `StepPolicy.shape`, so plans, presets and pulses accept roster keys with no further change.

Order: B1 first. Blast radius: every parser of plans (`PlanInput`, presets' `PlanInput.parse` in
`core/presets.ts`), stored goals and pulses (`Goal.parse`, `Pulse.parse` in the store), the JSON
schemas. Risks: `superRefine` on `StepPolicy.agent` changes the JSON Schema output of `StepPolicy`
(the `pattern` disappears from the generated schema); acceptable, regenerated by `pnpm schemas`. The
zod 4 `z.record(z.string(), …)` + `.default({})` input type makes `agents` optional for store inputs.

### AC-02 Pure helpers

Files: `src/core/roster.ts` (B2), `src/core/index.ts`.

Changes: `catalogDigest`, `unifiedDiff`, `canonicalKey` as B2. Check the spec example by hand while
writing: `a\nb\nc\n` vs `a\nB\nc\n` → script ` a`, `-b`, `+B`, ` c`; one hunk 1..3 on both sides →
`@@ -1,3 +1,3 @@`. Addition-only from `""`: `@@ -0,0 +1,2 @@`. Hunk merge threshold: gap ≤ 6 unchanged
lines merge (3 trailing + 3 leading context touch), 7 split.

Order: none beyond B1 (types). Blast radius: new file only. Risks: R5 (LCS size).

### AC-03 Store: migration 11 and roster rows

Files: `src/store/hub-store.ts`, `src/store/hub-copy.ts`.

Migration 11 (SQLite), appended to `HUB_MIGRATIONS` with a `// v0.1.19 (RL-5): the roster.` comment:
```
CREATE TABLE IF NOT EXISTS agent_def (id TEXT PRIMARY KEY, origin TEXT NOT NULL, machine TEXT, repo TEXT NOT NULL,
  name TEXT NOT NULL, hash TEXT NOT NULL, current INTEGER NOT NULL, value TEXT NOT NULL, body TEXT, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS agent_def_machine ON agent_def (origin, machine);
CREATE INDEX IF NOT EXISTS agent_def_name ON agent_def (name);
CREATE TABLE IF NOT EXISTS catalog_source (repo TEXT PRIMARY KEY, value TEXT NOT NULL, created_at INTEGER NOT NULL);
```
`HUB_MIGRATIONS_PG` gets the same with `BIGINT` for `updated_at` and `created_at`. `SCHEMA_VERSION`
follows (`HUB_MIGRATIONS.length`).

New `HubStore` methods (section `// ---------- roster (RL-5) ----------`):
- `replaceMachineAgents(machine, agents, now)`: C1/C2; `SELECT value FROM agent_def WHERE origin = 'repo' AND machine = ?`;
  equal → `false`; else `DELETE … WHERE origin = 'repo' AND machine = ?` and one `INSERT` per report
  (`current = 1`, `updated_at = now`); `true`. Runs inside the caller's `tx`.
- `listRepoAgents(f)`: `SELECT machine, value, updated_at FROM agent_def WHERE origin = 'repo' [AND name = ?] ORDER BY id`
  (binary order via `this.db.dialect.binary("id")`) → `{...AgentReport.parse(value), machine, at: updated_at}`.
- `saveCatalogSource(s: StoredCatalogSource)`, `getCatalogSource(repo)`, `listCatalogSources()` (ordered
  by `dialect.binary("repo")`). New exported type `StoredCatalogSource = Omit<CatalogSourceView, never>`
  (the view is stored as is: `repo, name, folder, calibrator?, createdBy, createdAt, count, commit?,
  digest?, pushedAt?, pushedBy?`); upsert `ON CONFLICT (repo) DO UPDATE SET value = excluded.value`
  (`created_at` never updated).
- `putCatalogDefs(repo, commit, defs, by, now)`: for each def, id `c\n…`; `SELECT value` → missing:
  insert `{path, commits: [commit], pushedAt: now, front}` with `body = text`, `added++`; present:
  `commits` = existing without `commit` duplicates (append only when absent), `.slice(-50)`, `pushedAt =
  now`, `path` = the pushed path, `UPDATE value, updated_at` (body untouched). Then
  `UPDATE agent_def SET current = 0 WHERE origin = 'catalog' AND repo = ?` and `UPDATE … SET current = 1
  WHERE id IN (…)` (in chunks of 500 parameters). `by` is not stored per definition (it lives on the
  source's `pushedBy`); kept in the signature as the spec gives it. Returns `{ added }`.
- `listCatalogDefs(f)`: `SELECT repo, name, hash, current, value, body FROM agent_def WHERE origin = 'catalog'`
  plus filters; maps to `CatalogDefView` (`key = canonicalKey(repo, name)` — the store may not import
  `core`, so a local one-line copy `repoId.slice(lastIndexOf("/") + 1)`; `source = repo`; `commit =
  commits.at(-1)`; `current = current === 1`; `text = body`; front fields spread). Order: name, then
  `pushedAt` desc, then hash (stable for resolve's "newest").
- `hub-copy.ts` `TABLES`: after `pulse_slot`, `// RL-5` then `{ name: "agent_def" }`, `{ name: "catalog_source" }`.
  No identity columns, so the generic copy loop covers them (including `body` TEXT).

Order: after stage 1 (types). Blast radius: every hub open (migration runs), `mesh hub migrate`, the
contract tests of section 2. Risks: R1 (re-run of migration 11 in downgrade tests); `current` is a
non-reserved key word in Postgres and SQLite, usable unquoted (if a Postgres run disagrees, quote it in
both dialects via `this.db.dialect` — the Postgres legs are not run here, CI runs them).

### AC-04 Daemon discovery: `scanAgents`

Files: `src/daemon/roster.ts` (new), `src/daemon/index.ts` (export `scanAgents`).

`scanAgents(checkouts)`:
- `seen = new Set<string>()`; for each checkout: skip when `!repo || repo.id.startsWith("local/") || seen.has(repo.id)`; add.
- For `[{dir: ".claude/agents", kind: "claude"}, {dir: ".opencode/agent", kind: "opencode"}]`:
  `readdirSync` (missing → none), names sorted (code units), keep `name.endsWith(".md")`, `base = name.slice(0, -3)`
  matching `AGENT_NAME_RE`, `lstatSync(p).isFile()` (C4) and `size ≤ 262144`; `readFileSync(p, "utf8")`
  in try/catch (unreadable → skip).
- Report: `{...agentFront(text), repo: repo.id, kind, path: `${dir}/${name}`, name: base, hash: agentFileHash(text)}`,
  plus `pin` for kind `claude` from the lock.
- Lock: once per checkout, `readFileSync(<dir>/.mesh/agents.lock)` → `JSON.parse` → `AgentsLock.safeParse`;
  failure → no pins. Pin = `{source, commit, hash}` of the entry with the same `name`.
- Stop at 2000 reports (return early).

Order: after B2. Blast radius: new code. Risks: a file that is valid UTF-8 only partially is read with
replacement characters — its hash then is of the decoded text, consistent with RL-1's `readFileSync(…,"utf8")`.

### AC-05 Sync of repo copies

Files: `src/daemon/daemon.ts`, `src/daemon/hub-link.ts`, `src/hub/service.ts`.

Daemon:
- `DaemonDeps` gains `scanAgents?(checkouts): AgentReport[]` and `git?(cwd, args): Promise<RunResult>`;
  `defaultDeps` sets `git: (cwd, args) => runCommand("git", [...args], { cwd, timeoutMs: 60_000 })`
  (`run` from `src/claude`, already imported as `runCommand`).
- `repoScan` becomes `{ at, repos, agents, checkouts, seq }`; a rescan computes `checkouts =
  findCheckouts(workspaceRoots)` once, `repos = deps.scanRepos ? deps.scanRepos(roots) :
  repoInventory(checkouts.map(c => c.repo))` (the injected `scanRepos` keeps working),
  `agents = (deps.scanAgents ?? scanAgents)(checkouts)`, `seq++`. New private `machineAgents()`:
  `shareSessions === "steps"` → `[]` (no read; under `steps` `machineRepos()` never scans); else the
  scan's `agents` (calling `machineRepos()` first so the scan is fresh).
- `HubLink` deps: `machineAgents: () => this.machineAgents()`.

HubLink:
- `HubLinkDeps.machineAgents?: () => AgentReport[]`; field `sentAgents: string | undefined`, reset in
  `factsFor`. In `doFlush`, next to `repos`: `agents = deps.machineAgents?.()`, `agentsJson`; `sendAgents
  = agents !== undefined && this.sentAgents !== agentsJson`; body `machine` gains
  `...(sendAgents ? { agents } : {})`; after the `rpc` resolves, `if (sendAgents) this.sentAgents = agentsJson`.
  A refused sync throws before that line, so the next sync sends again.

Hub `sync`:
- After `touchMachine`, when `req.machine?.agents !== undefined`: `inv = new Set((await store.getMachine(machine))?.repos?.map(r => r.id) ?? [])`;
  `kept = agents.filter(a => inv.has(a.repo))`; `if (await store.replaceMachineAgents(machine, kept, now))`
  emit `{ type: "agents.reported", user: actor.userId, payload: { machine, count: kept.length } }`.
  `emit` publishes `changed` after commit (web refresh, AC-22).

Visibility (AC-05/06) is applied at read time (AC-10's `agentsView` with B3 `agentCopyVisible`), so a
machine whose stored share became `steps` (by a newer daemon's sync or an older daemon's sync with
`share: steps` and no `agents` key) hides its rows without deleting them.

Order: AC-04 before; hub part after AC-03. Blast radius: every sync (one more optional key, one more
store call only when the key is present); `/v1/sync` body schema (`schemas/*.json`). Risks: the first
sync after a daemon restart re-sends the list (`sentAgents` undefined) — `replaceMachineAgents` then
returns `false`, so no event; intended.

### AC-06 Visibility of copies

Files: `src/hub/service.ts`.

Changes: B3 `agentCopyVisible`, used by `agentsView` (AC-10) per repo row, with the machine rows
loaded once per call (`store.listMachines()` into a map). Catalog copies and `sources` are never
filtered. Order: with AC-10. Blast radius: none outside the roster view. Risks: none beyond C7.

### AC-07 Catalog sources: `POST`/`GET /v1/catalog-sources`

Files: `src/hub/service.ts`, `src/hub/app.ts`, `src/protocol/hub-api.ts`.

Service:
- `saveCatalogSource(actor, body: CatalogSourceSave): Promise<{ view: CatalogSourceView; created: boolean }>`
  in `store.tx`:
  - `fromRemote = repoFromRemote(body.repo)`; id = `fromRemote && !fromRemote.id.startsWith("local/") ?
    fromRemote.id : undefined`; else `lower = body.repo.toLowerCase().replace(/\.git$/, "")` when it
    matches `^[a-z0-9][a-z0-9.-]*(/[a-z0-9._-]+)+$`; else 422 `repo must be a repo id (host/path) or a remote URL`.
  - id not matching `^[a-z0-9][a-z0-9._-]*(/[a-z0-9._-]+)+$` → 422 `repo id ${id} cannot be used in an agent key`.
    (`repoFromRemote` lowercases, so `Team/Agents.git` → `git.example.com/team/agents`; `a~b` survives
    `repoFromRemote` and is refused here.)
  - `folder`: regex `^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$` and no segment `.`/`..` → else 422
    `folder must be a relative path inside the repo`.
  - existing → `{...existing, folder, calibrator?}` (calibrator replaced or removed as given), 200;
    new → `{repo: id, name: lastSegment(id), folder, calibrator?, createdBy: actor.userId, createdAt: now, count: 0}`, 201.
  - event `catalog.saved {repo: id, folder}`.
- `listCatalogSourcesView()`: `{ sources: store.listCatalogSources() }`.

App (`// ---------- roster (RL-5) ----------` after the profiles block):
- `r("POST", "/v1/catalog-sources", "admin", async (c, a) => { const r = await svc.saveCatalogSource(a, await body(c, CatalogSourceSave)); return c.json(r.view, r.created ? 201 : 200); })`
- `r("GET", "/v1/catalog-sources", "member", …, "goals:read")`.

`hub-api.ts`: rows `POST /v1/catalog-sources` (`admin`, tag `admin`, body `CatalogSourceSave`, status 201)
and `GET /v1/catalog-sources` (`member`, scope `goals:read`, tag `goals`).

Order: after AC-03. Blast radius: two new routes; OpenAPI. Risks: the `admin` rule returns 403 for a
member before the body is read (existing middleware), as AC-07 expects.

### AC-08 Push route

Files: `src/hub/service.ts`, `src/hub/app.ts`, `src/protocol/hub-api.ts`.

Service `pushCatalog(actor, body: CatalogPush): Promise<{ source: CatalogSourceView; added: number }>` in `store.tx`, checks in the spec's order:
1. `!actor.machineId` → 403 `a catalog push needs a device token`.
2. `src = getCatalogSource(body.repo)` none → 404 `no catalog source ${body.repo}`.
3. `machine.repos` lacks `body.repo` → 403 `this machine does not report ${body.repo} in its repo inventory`.
4. per def: `rest = path.startsWith(src.folder + "/") ? path.slice(folder.length + 1) : undefined`;
   valid when `rest` has no `/`, ends with `.md`, and the name matches `AGENT_NAME_RE` → else 422
   `catalog push: ${path} is not ${src.folder}/<name>.md`; duplicates (Set) → 422 `catalog push: ${path} appears twice`.
   (Path checks run in def order; the first failure wins.)
5. `total = sum(text.length)` > 8 000 000 → 422 `catalog push: texts total ${total} characters, over 8000000`.
6. `defs = body.defs.map(d => ({path, name, hash: agentFileHash(d.text), text: d.text, front: agentFront(d.text)}))`;
   `{added} = store.putCatalogDefs(src.repo, body.commit, defs, actor.userId, now)`; source ←
   `{...src, commit, digest: catalogDigest(defs), count: defs.length, pushedAt: now, pushedBy: actor.userId}`;
   event `catalog.pushed {repo, commit, added, count}`.

App: `r("POST", "/v1/catalog-sources/push", "member", …)` (no scope), body read with the existing
`body(c, CatalogPush)` (see R3 on size).
`hub-api.ts`: row with tag `daemon`, body `CatalogPush`.

Order: after AC-07. Blast radius: one route. Risks: R3.

### AC-09 Daemon catalog push

Files: `src/daemon/roster.ts`, `src/daemon/git.ts`, `src/daemon/daemon.ts`, `src/daemon/hub-link.ts`, `src/claude/exec.ts`.

Changes:
- `src/claude/exec.ts` `run`: `child.stdout?.setEncoding("utf8")` and the same for stderr, so a
  multi-byte character split across chunks is decoded correctly (B6 relies on exact texts). Behaviour
  for ASCII output is unchanged.
- `git.ts`: `remoteNameForCwd(cwd)`: the same lookup as `repoForCwd` (`origin`, else the first remote
  in config order), returning the name.
- `roster.ts` `catalogPushes(o: { sources: CatalogSourceView[]; checkouts: {dir, repo}[]; git; log }): Promise<CatalogPush[]>`:
  for each source, the first checkout (scan order) whose `repo.id === source.repo`:
  1. `R = remoteNameForCwd(dir)`; `C` = stdout of `git rev-parse --verify -q refs/remotes/<R>/HEAD^{commit}`
     (code 0) else of `git rev-parse --verify -q HEAD^{commit}`; none → skip.
  2. `source.commit` S: `C === S` → skip; `git merge-base --is-ancestor S C` code ≠ 0 → log
     `catalog push of ${repo} skipped: ${C7} does not descend from ${S7}`, skip.
  3. `git ls-tree -z C -- <folder>/` → records `<mode> <type> <oid>\t<path>`; keep mode `100644`/`100755`,
     type `blob`, `path` = `<folder>/<file>` with no further `/`, `file` = `<agent name>.md`; sorted by
     path; empty listing → skip ("no such folder"). Texts via `git cat-file blob <oid>` (C5), keep
     `text.length ≤ 100000`, at most 2000.
  4. `!S || catalogDigest(defs.map(d => ({path, hash: agentFileHash(text)}))) !== source.digest` → push
     `{repo, commit: C, defs}`.
- `daemon.ts` `catalogPass()` (private, serialized by a `pushing` promise): runs when
  `shareSessions !== "steps"`, a link exists and `repoScan.seq !== lastPushSeq`; sets `lastPushSeq`;
  `GET /v1/catalog-sources` via `link.rpc` (any error, including 404: return silently until the next
  rescan); `catalogPushes(...)`; each push via `link.rpc("POST", "/v1/catalog-sources/push", body, C10 key)`;
  `HubRpcError` → log `catalog push of ${repo} refused: ${message}`; other errors logged; nothing queued
  offline (a GET/POST failing while offline is retried at the next rescan, `lastPushSeq` is reset on failure).
- `hub-link.ts`: `HubLinkDeps.afterSync?: () => Promise<void>`, called (not awaited by the sync's
  error path: `void deps.afterSync?.().catch(log)`) after the outbox loop of `doFlush` succeeds, so the
  inventory the hub checks in AC-08 step 3 has been sent first and a failing push never breaks a sync.

Order: after AC-05 (scan plumbing) and AC-08 (route). Blast radius: one extra `GET` per rescan
(every 5 min) under `me`/`all`; git processes only for checkouts of registered sources. Risks: R2
(`run` change), R4 (two daemons race: the hub accepts whichever push arrives; a push at C1 arriving
after C2 is impossible once the stored commit is C2, because the daemon at C1 checks ancestry against
the stored commit first; a true race inside one rescan window is accepted by the spec's "only forward"
check on the daemon side — see R4).

### AC-10 `GET /v1/agents`

Files: `src/hub/service.ts`, `src/hub/app.ts`, `src/protocol/hub-api.ts`.

Service `agentsView(viewer, name?): Promise<AgentsView>` in `store.tx`:
1. `machines` map; `rows = listRepoAgents({name})` filtered by `agentCopyVisible`.
2. Merge repo rows by `${repo}\n${path}\n${hash}\n${JSON.stringify(pin ?? null)}` → copy
   `{key: canonicalKey(repo, name), repo: {id, name: inventory name of that id on the machine, else last segment},
   origin: "repo", kind, path, hash, machines: distinct machine count, pin?, seenAt: max at}` plus the
   front of the first row (for the version).
3. `current = listCatalogDefs({current: true, name})`; map `${source}\n${name}` → def. Catalog copies:
   `{key, repo: {id: source, name: source's name}, origin: "catalog", kind: "claude", path, hash,
   commit: def.commit, pinned: false, behind: false, modified: false, seenAt: def.pushedAt}`.
4. Repo copy flags: `pinned = !!pin`; `modified = !!pin && hash !== pin.hash`; `behind = !!pin &&
   (cur = current.get(pin.source + "\n" + name)) !== undefined && cur.hash !== pin.hash`.
5. Group by agent name → versions by hash; version front = first copy's front after copy ordering
   (copies: catalog first, then `key`, then `kind`, code-unit order); versions by copy count desc, then
   hash; groups by name; group flags `diverged = versions.length > 1`, others = any copy's.
6. `sources = listCatalogSources()`.

App: `r("GET", "/v1/agents", "member", async (c, a) => c.json(await svc.agentsView(a, c.req.query("name") || undefined)), "goals:read")`.
`hub-api.ts`: row with query `{ name: "exact agent name" }`, tag `goals`.

Order: after AC-03, AC-05, AC-08. Blast radius: one route, reads only. Risks: R6 (size of the view).

### AC-11 `GET /v1/agents/resolve`

Files: `src/hub/service.ts`, `src/hub/app.ts`, `src/protocol/hub-api.ts`.

Service `resolveAgent(key: string | undefined): Promise<CatalogDefView>`: absent → `HubError(400, ROSTER_KEY_RULE)`;
`resolveRoster(key)` (B3) → ok returns `{...def, commit: resolved commit}`, else `HubError(status, error)`.
App: `r("GET", "/v1/agents/resolve", "member", async (c) => c.json(await svc.resolveAgent(c.req.query("key"))), "goals:read")`;
the existing error mapper turns `HubError` into `{error}` with its status. `hub-api.ts`: row with query
`{ key: "<source>/<name>[@<ref>]" }`, tag `goals`.

Order: B3. Blast radius: none. Risks: Hono matches `/v1/agents/resolve` literally; no `/v1/agents/:x`
route exists in S5, so no shadowing.

### AC-12 `mesh agents`

Files: `src/cli/roster-commands.ts` (new), `src/cli/mesh-commands.ts`.

`agentsCommand(c): Command` (`name: "agents"`, summary "the roster: agents of repos and catalog sources"):
parse `--name` (value flag), `--json`; `HubClient` from `loadCredentials(c.paths)` (as `pulse-commands.ts`);
`GET /v1/agents[?name=…]` (URL-encoded). `--json` → `JSON.stringify(view, null, 2)`. Text: per group
`${name}  versions ${V}  copies ${C}` + `  ${flag}` per true flag in `diverged, pinned, behind, modified`;
per version `  ${hash.slice(0,12)}  ${description ?? "-"}`; per copy
`    ${key}  ${origin === "repo" ? "repo" : `catalog ${commit.slice(0,7)}`}` + `  pin ${pin.commit.slice(0,7)}`
when pinned, `  behind`, `  modified`. No groups → `No agents on the roster.` A `HubCallError` → its
message, exit 1. Register in `meshCommands` after `pulseCommand(c)`: `agentsCommand(c), agentCommand(c)`.

Order: after AC-10. Blast radius: `mesh help` gains two lines. Risks: none.

### AC-13 `mesh agent add`

Files: `src/cli/roster-commands.ts`.

Helpers (module-private): `repoRoot(c, a)` (walk up from `resolve(c.cwd, a.str("repo") ?? ".")` until
`existsSync(join(dir, ".git"))`; none → usage-style exit 2 `not in a git checkout: <path>` (C8));
`readLock(root)` (`undefined` when absent, throws C8 text when invalid); `writeLock(root, entries)`
(sorted by name, objects rebuilt in key order `name, source, commit, hash`,
`JSON.stringify({version: 1, agents}, null, 2) + "\n"`, `mkdirSync(.mesh, {recursive})`);
`resolve(client, key)` → `GET /v1/agents/resolve?key=…` returning `CatalogDefView`.

`agent add <key>`: `parseRosterKey(key)` undefined → print `ROSTER_KEY_RULE`, exit 2 (also for a key
without `/`). Root, then resolve (hub refusal → its text, exit 1). Target
`<root>/.claude/agents/<def.name>.md`: exists and `agentFileHash(existing) !== def.hash` and no
`--force` → exit 1 with the spec text (`${commit7}` of `def.commit`). Else `mkdirSync` and
`writeFileSync(target, def.text)` (a JS string written as UTF-8; CR characters kept), lock entry
`{name: def.name, source: def.source, commit: def.commit, hash: def.hash}` replacing the same name,
print the spec line, exit 0. Order of effects: all checks and the resolve before the first write.

`agentCommand(c)` (`name: "agent"`) dispatches `add | outdated | diff | update | source add | source ls`;
anything else → usage, exit 2.

Order: after AC-11. Blast radius: writes only under `--repo`. Risks: `writeFileSync` with a string
cannot reproduce bytes that were not valid UTF-8 on the source side; the hub only holds texts that
went through JSON, i.e. valid Unicode strings, so "byte for byte" holds for every storable text.

### AC-14 `mesh agent outdated`

Files: `src/cli/roster-commands.ts`.

No lock → `No pinned agents in ${root}.` exit 0. Per entry in lock order: `latest = resolve(`${source}/${name}`)`;
catch `HubCallError` with status 404 and message starting `no agent ` → `gone`; any other error (fetch
failure, 401, 409, other refusal) → print its text, no status line, exit 1 at once. File
`<root>/.claude/agents/<name>.md` absent → `missing`; else statuses `modified` (file hash ≠ pin hash)
and `behind` (latest found and hash ≠ pin hash) or `gone`, comma-joined, `ok` when none. Line
`${name}  ${canonicalKey(source, name)}@${commit7}  ${status}` + `  latest ${latest.commit7}` when behind.
`--json`: `{agents: [{name, source, commit, hash, status, latest?: {hash, commit}}]}` (`latest` when
resolved). Exit 0 iff all `ok`.

Order: after AC-13 helpers. Blast radius: read only. Risks: the hub client wraps network failures —
check `hub-client.ts` `hubFetch` turns them into an `Error` with a readable text (it does for other
commands).

### AC-15 `mesh agent diff`

Files: `src/cli/roster-commands.ts`.

Lock entry by name, none → exit 1 `${name} is not pinned in ${root}/.mesh/agents.lock`. Latest = resolve;
error → its text, exit 1. Installed text (`""` when absent). `d = unifiedDiff(installed, latest.text,
`.claude/agents/${name}.md`, `${canonicalKey(source, name)}@${latest.commit7}`)`; `""` → `${name}: no
difference from ${key}@${commit7}`; else print `d` exactly with `io.write` when present (RL-1's
no-newline writer, `context.ts`), else `io.out(d.replace(/\n$/, ""))`. Exit 0.

Order: after AC-02 and AC-14 helpers. Blast radius: none. Risks: `io.out` adds a newline per call;
the `write`/strip rule above keeps the printed text equal to `unifiedDiff`'s output.

### AC-16 `mesh agent update`

Files: `src/cli/roster-commands.ts`.

As `diff` for lookup and resolve. `latest.hash === entry.hash && installedHash === entry.hash` → `${name}
is up to date (${key}@${commit7}).` exit 0. Else print the diff (as AC-15). Without `--yes`:
`readLine = c.readLine ?? (process.stdin.isTTY ? readline-based (as hub-commands.ts) : undefined)`;
none → `Not updated: run with --yes to confirm without a terminal.` exit 1; answer
`/^(y|yes)$/i.test(answer.trim())` → write; else `Not updated.` exit 1. Write = file text + lock entry
`{name, source: latest.source, commit: latest.commit, hash: latest.hash}`; print `Updated ${name} to
${key}@${commit7} (hash ${hash12}).` exit 0. The prompt text is passed to `readLine` (which prints it).

Order: after AC-15. Blast radius: writes only after confirmation. Risks: the readline helper in
`hub-commands.ts` is local; copy its 8 lines rather than export (keeps the change in the new file).

### AC-17 `mesh agent source add|ls` and `mesh help`

Files: `src/cli/roster-commands.ts`.

`source add <repo> --folder <path> [--calibrator <user>]`: missing repo or folder → usage exit 2;
`POST /v1/catalog-sources` → `Saved catalog source ${view.repo} (folder ${view.folder}).` exit 0; refusal
(403 for a member) → its text, exit 1. `source ls [--json]`: per source
`${repo}  ${folder}  ${count} agent(s)  ${commit7 ?? "-"}` + `  calibrator ${user}`; none → `No catalog
sources.`; `--json` → the reply. Help: the two `Command` entries (`agents`, `agent`) make `mesh help`
list them; `agent` gets a `help` text with the full usage.

Order: after AC-07. Blast radius: help output. Risks: none.

### AC-18 Plan, pulse and ingest validation

Files: `src/hub/service.ts`.

- `proposePlan`: after the profile loop, `errors.push(...await this.rosterProblems(input.steps))`. The
  RL-1 rule (`agent needs mode: headless`) is already in `validatePolicies` (it tests `s.agent !==
  undefined`, any form) — no change in `core/policy.ts`.
- `presetChecks`: after the profile problems, `problems.push(...await this.rosterProblems(plan.steps))`
  (covers `POST /v1/pulses`, a pulse update of `preset`/`params`, `POST /v1/goals/from-preset`).
- The stored policy keeps the string (no rewriting anywhere).

Order: B3, AC-11. Blast radius: every plan proposal and preset check does one source listing per
distinct roster key (none when no step has a `/` agent). Risks: the 422 detail arrays already exist
in both paths; the problem text format is the shared `step "<id>": …`.

### AC-19 Goal pins and offer data

Files: `src/hub/service.ts`.

- `approvePlan`: after the plan is found and checked `pending`, before `savePlan(approved)`:
  `const pins = await this.pinAgents(plan.steps, goal.agents ?? {})`; problems → `throw new HubError(422,
  `the plan has ${n} problem(s): ${problems.join("; ")}`, problems)` (nothing written yet; the tx rolls
  back regardless). When `pins.agents` has more keys than `goal.agents`, `saveGoal({...goal, agents:
  pins.agents, updatedAt: now})` before `applyApproved` (which re-reads the goal through `getGoal`, so
  the pins survive its `saveGoal`). Existing entries are kept as they are (no re-resolve).
  `proposePlan(approve: true)` goes through `approvePlan`, so it gets the same behaviour.
- `offerStep`: in the `headless` record, when `step.policy.agent` contains `/`: `def =
  opts.goal.agents?.[agent]` → `...(def ? { agentDef: def } : { agentError: `${agent} is not pinned in ${goal.id}` })`.
  `opts.goal` is loaded inside the offering transaction in every caller (`assignStep`, `assignGoal`,
  `emitReady` via `getGoal`, the pulse `attempt` via `createWithPlan`'s returned goal), so it carries
  the pins. Steps without `/` get neither key.

Order: after AC-18. Blast radius: approval of any plan (one extra pass over steps; resolve only for
new roster keys); offer message data of roster steps only. Risks: a plan approved before RL-5 has no
roster keys (spec Compatibility), so no stored goal lacks a needed pin except by a manual store edit,
which the `agentError` path covers.

### AC-20 Roster run

Files: `src/daemon/runs.ts`, `src/daemon/tools.ts`, `src/daemon/daemon.ts`.

- `RunMeta` gains `agentDef?: AgentDef` and `agentError?: string`; `accept` (line ~392) saves
  `AgentDef.safeParse(d.agentDef)` data and a string `d.agentError` next to `agent`.
- `start`: when `meta.agent?.includes("/")`, replace the RL-1 block with `rosterAgent(run, next, meta)`:
  1. no `agentDef` → `notStarted(next, `roster agent ${meta.agent} was not resolved by the hub: ${meta.agentError ?? "no definition"}`)`.
  2. `link.rpc<CatalogDefView>("GET", `/v1/agents/resolve?key=${encodeURIComponent(`${def.source}/${def.name}@${def.hash}`)}`)`;
     throw or no link → `notStarted(next, `roster agent ${def.key} is not available: ${message}`)`.
  3. `agentFileHash(text) !== def.hash` → `notStarted(next, `roster agent ${def.key} does not match its hash`)`.
  4. `writeFileAtomic(file(run, "agent.md"), text)`; `agents.json` built exactly as the RL-1 block
     (extract that block into a private `agentsJson(name, text)` used by both paths); `next.agent =
     {name: def.name, key: def.key, hash: def.hash}`; `headlessArgv({... agent: def.name})`.
  The RL-1 path (no `/`) is unchanged. Nothing touches `<worktree>/.claude/agents/`.
- `runForSid` returns also `agentFile?: string` = `<run.dir>/agent.md` when that file exists.
- `tools.ts` `reviewUpload`: when `run?.agentFile` is set, `agentText = readText(run.agentFile)` and the
  sibling rules text is `undefined`; the `contextOf` fallback is skipped when the policy agent contains
  `/` (a roster key is never a file name in the worktree). `ToolHost.runOf` type gains `agentFile?`.

Order: after AC-19 (offer data) and AC-11 (resolve). Blast radius: headless runs of roster steps only;
the extraction of `agentsJson` touches the RL-1 path (same output). Risks: R7 (the run start is async
and now does a hub call; a slow hub delays the start, bounded by the link timeout).

### AC-21 Roster run not started

Files: `src/daemon/runs.ts`.

Covered by AC-20 steps 1-3: all three go through the existing `notStarted` → `crashed` → close `fail`
with `headless run of <step> did not start: <reason>`; `runner.start` is never reached. The worktree
is created before (as RL-1's not-started path does) and removed by the existing cleanup.

Order: with AC-20. Blast radius / risks: as AC-20.

### AC-22 Web Roster page

Files: `web/src/roster.tsx` (new), `web/src/main.tsx`, `web/src/api.ts`, `web/src/styles.css`.

- `api.ts`: `agents: async () => call<AgentsView>("GET", "/v1/agents")` (type imported from
  `../../src/protocol/roster.ts`, type-only).
- `main.tsx`: `<a href="#/roster" className={route === "#/roster" ? "active" : ""}>Roster</a>` right
  after the `Mine` link; route branch `route === "#/roster" ? <RosterPage hint={hint} />`.
- `roster.tsx` `RosterPage({hint})`: `useEffect` on `[hint]` loads `api.agents()`; `h2` "Roster";
  `input name="roster-filter"`; groups filtered by `name.toLowerCase().includes(text.toLowerCase())`;
  `section.roster-group[data-name]` with `h3` (name + `span.roster-flag` per true flag in CLI order);
  per version `div.roster-version[data-hash]` with hash12, description, model, `tools: a, b`,
  `rules: a, b` when present; `ul` of `li.roster-copy[data-key]` with origin text (`repo` or `catalog
  <commit7>`), `pin <commit7>`, `behind`, `modified`; `section.roster-sources` with `li[data-repo]`
  (`repo`, `folder`, `<count> agent(s)`). Empty → `p.empty` `No agents on the roster yet.`; filter
  without match → `p.empty` `No agent matches "<text>".`
- `styles.css`: minimal rules for the new classes, reusing existing tokens.

The `erin` user in `test/e2e-web/hub.yaml` is test-side fixture work (spec: "the test side may extend
them"); not planned here. Order: after AC-10. Blast radius: one page, one nav link (other specs that
count nav links: none found). Risks: the `changed` hint fires on `agents.reported` because `emit`
publishes `changed`; the 20 s budget holds with the existing debounce.

### AC-23 Docs and skill

Files: `docs/guide/concepts.md` (section "Roster"), `docs/guide/howto.md` ("Share agents through the
roster"), `src/protocol/skill.ts` (`MESH_SKILL` rows for `mesh agents` and `mesh agent add
<source>/<name>` with `outdated`/`diff`/`update`), `skills/mesh/SKILL.md` (via `pnpm schemas`),
`docs/plan/implementation-plan.md` §5.6 (rows for the five routes, "Roster (v0.1.19)"),
`docs/events.md` (`catalog.saved`, `catalog.pushed`, `agents.reported` with payload keys).
`src/hub/service.ts` `describe()` gains the three event texts (`registered catalog source <repo>`,
`<repo> pushed at <commit7>: <added> new, <count> current`, `<machine> reported <count> agent(s)`).

Content as the spec's Docs table, including the limits (front matter `mesh-rules` only; RL-1 repo agents
unpinned; committed content of the remote's default branch only, forward only). Examples use
`git.example.com` hosts only; no team, company or person names.

Order: after the code (texts quote real commands). Blast radius: docs only. Risks: the skill test
compares `MESH_SKILL` to the generated file — regenerate after the last edit.

### AC-24 Version, checks, OpenAPI

Files: `package.json` (`0.1.19`), `src/protocol/hub-api.ts` (five rows: AC-07, AC-08, AC-10, AC-11),
`schemas/hub-api.openapi.json` and `schemas/*.json` (`pnpm schemas`), the tests of section 2.

Steps: `pnpm schemas`; `pnpm check` (lint, typecheck, boundaries, test, build); `pnpm build` then
`pnpm test:web`. Boundaries to watch: `src/daemon/roster.ts` imports `core`, `protocol` only; git
through `src/claude` (`run`); `src/store/hub-store.ts` imports no `core` (local last-segment helper);
`src/protocol/roster.ts` imports only `zod` and a type from `./session.ts`.

Risks: the Postgres legs of the contract test do not run here (no `MESH_TEST_PG_URL`); CI runs them.

### AC-25 R-6 for pulses

Files: `src/hub/service.ts`.

- `createPulse`: after `presetChecks` (which already refused unresolvable keys), `agents = (await
  this.pinAgents(plan.steps)).agents`; stored on the pulse (`agents` field of `store.createPulse`).
- `updatePulse`: in the `preset`/`params` branch, `agents: (await this.pinAgents(plan.steps)).agents`
  (fresh resolve, no existing pins: an update of these fields re-resolves); other updates keep
  `next.agents` from the spread.
- `pulseView`: destructure `agents` too; `agents: Object.fromEntries(entries.map(([k, v]) => [k, v.hash]))`.
- `createWithPlan`: option `agents: Record<string, AgentDef>`; `createGoal({..., ...(Object.keys(agents).length ? { agents } : {})})` (C6).
  `fireSlot` passes `p.agents`; `goalFromPreset` passes `(await this.pinAgents(plan.steps)).agents`.
- The slot's later offer (`attempt` → `offerStep`) reads `goal.agents` (AC-19), never the source.

Order: after AC-19. Blast radius: pulse create/update/view and every fire. Risks: `Pulse.agents` is
non-optional in the output type, so every `Pulse` literal in `src/` (store `createPulse` input type,
service) must carry it — typecheck finds them; stored pulses read as `{}`.

## 5. Risks (cross-cutting)

- R1. Migration re-run in the contract tests' downgrade cases: they drop the RL-2/RL-3 tables, set the
  version back to 7/8/9 and reopen; the agent tables still exist then, so migration 11 must use
  `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` (as migration 10 does).
- R2. `run`'s decoding change (`setEncoding("utf8")`) is shared by every external command the CLI and
  daemon run; output of ASCII commands is identical; only split multi-byte sequences change (for the
  better).
- R3. Hub body size: no body limit is configured in `app.ts`/`server.ts` today (checked at 347299d), so
  an ~8 MB push reaches the service and its 8 000 000 check answers the documented 422. Do not add a
  smaller limit for this route; a proxy limit in front of a deployed hub is an operations matter.
- R4. Concurrent pushes from two daemons: the hub applies each push as given (the spec puts the
  forward-only rule on the daemon). The window is one rescan; once the newer commit is stored, the
  older daemon's ancestry check stops it. AC-09 asserts the end state after both rescans, which holds.
- R5. `unifiedDiff` LCS is O(n·m); two 256 KiB files of short lines (~25 000 lines each) would need
  ~625 M cells. Mitigation: strip the common prefix and suffix before the LCS (exact, keeps the result
  minimal); the remaining middle is small for real agent files.
- R6. `GET /v1/agents` with 2000 reports × many machines: one query plus in-memory grouping; acceptable
  for S5, no paging in the spec.
- R7. A roster run's start depends on the hub being reachable for the resolve; offline → not started
  with the documented reason (no retry), which is the spec's contract.
