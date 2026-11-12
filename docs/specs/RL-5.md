# Spec RL-5: Roster

## Status
Draft

Source: `docs/analysis/2026-11-12-pulse-relay-roster.md` §5.10 (Roster), §5.1 (agents of headless runs),
REQ-11, REQ-12, R-4, §7 (third-party agents), §6 and slice S5 of §9;
`docs/analysis/2026-11-12-claude-cli-spike.md` (6a, 6b, 6c) wins where it differs. Builds on MM-1 (repo
scan and inventory, share levels), RL-1 (headless runs, `agents.json`, `agentFileHash`), RL-2 (declared
rules) and RL-3 (pulse preset validation), landed as v0.1.10..v0.1.18. Release v0.1.19.

## Problem

Agent definitions are copied from repo to repo and drift; nothing says which agents exist, which copy
is current, or what a copy was taken from. A headless step can only run an agent that sits in the step
repo's `.claude/agents/`. Design §5.10 asks for a **roster**: the hub lists the agents of every repo
machines report and of registered **catalog sources**, by name and hash; a person installs a catalog
agent into a repo by pinned reference (the file unchanged, the pin in `.mesh/agents.lock`) and is told
when a copy was edited or its source moved on; a headless step can run a catalog agent its repo does
not contain.

## Scope

In:
- Daemon: during the MM-1 repo scan (only under `shareSessions` `me`/`all`), read the front matter and
  hash of `<checkout>/.claude/agents/*.md` and `<checkout>/.opencode/agent/*.md` of remote-backed
  checkouts, with the pins of `<checkout>/.mesh/agents.lock`; send them in `POST /v1/sync` on change,
  at most 2000 per machine. Push catalog source definitions **with their text** when the daemon has the
  source checked out.
- Hub: migration 11 (`agent_def`, `catalog_source`); `POST /v1/catalog-sources` (admin),
  `GET /v1/catalog-sources`, `POST /v1/catalog-sources/push`, `GET /v1/agents` (grouped, flags
  `diverged`/`pinned`/`behind`/`modified`), `GET /v1/agents/resolve`.
- Roster keys `<source>/<name>[@<ref>]` as `StepPolicy.agent` of headless steps: plan and pulse
  validation, offer data, and the daemon passing the definition through `--agents`/`--agent`.
- CLI: `mesh agents`, `mesh agent add|outdated|diff|update`, `mesh agent source add|ls`.
- Web: Roster page (`#/roster`).
- Docs: concepts, how-to, the mesh skill, the plan API table, the events list.

Out:
- Agent statistics, `GET /v1/agents/:key/stats`, Roster metrics, calibrators acting (S6). The
  `calibrator` of a catalog source is stored and shown only.
- User-level and plugin agents; agents outside the two folders; sub-folders of them.
- Installing into `.opencode/agent/` (install writes `.claude/agents/` only); converting formats.
- Installing a repo (non-catalog) agent: only catalog definitions have text on the hub.
- Removing a catalog source; editing a pushed definition on the hub.
- Pinning roster agents in a pulse snapshot (R-6 for agents; Open questions).
- TUI views of the roster.

## Interface contracts

Names used below. **Agent name**: the RL-1 pattern `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; a file's
agent name is its file name without `.md` (front matter `name` is ignored). **Hash** of a text:
`agentFileHash(text)` (hex SHA-256 with CRLF turned into LF, `src/core/headless.ts`). **hash12** /
**commit7**: the first 12 / 7 characters. **Repo copy**: an agent file a machine reported in a repo.
**Catalog definition**: a `(source, name, hash)` a machine pushed, with its text. **Current** catalog
definition of `(source, name)`: the one in the source's latest push (at most one). **Canonical key**:
`<repo name>/<agent name>`, where repo name is the last segment of the repo id (for a catalog
definition, of the source's repo id).

### Types (new file src/protocol/roster.ts, exported from src/protocol/index.ts)

| Interface | Type | Change |
|---|---|---|
| `AgentKind` | zod | `z.enum(["claude", "opencode"])` (`.claude/agents/` resp. `.opencode/agent/`). |
| `AgentFront` | zod | `{ description?: string ≤1000, model?: string ≤100, tools?: string[] (≤100 items, each ≤200), rules?: string[] (≤200 items, each ≤100) }`. |
| `AgentPin` | zod | `{ source: string 1..200 /* repo id */, commit: /^[0-9a-f]{40}$/, hash: /^[0-9a-f]{64}$/ }`. |
| `AgentReport` | zod | `AgentFront` + `{ repo: string ≤200 /* repo id */, kind: AgentKind, path: string ≤300 /* relative, e.g. ".claude/agents/reviewer.md" */, name: agent name, hash: /^[0-9a-f]{64}$/, pin?: AgentPin }`. |
| `SyncRequest.machine.agents` (src/protocol/hub.ts) | zod field | New, optional: `z.array(AgentReport).max(2000)`. Absent: the hub keeps what it has; `[]`: the machine has none. |
| `AgentsLock` | zod | `{ version: z.literal(1), agents: { name: agent name, source: string, commit: 40 hex, hash: 64 hex }[] }` (strict entries). |
| `ROSTER_KEY_RULE` | const | `"agent key must be <source>/<name>[@<7-64 hex>]"`. |
| `parseRosterKey(s: string): { source: string; name: string; ref?: string } \| undefined` | function | Matches `^([A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9._-]+)*)/([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:@([0-9a-f]{7,64}))?$` and length ≤ 200; `source` is lowercased. A string without `/` or not matching → `undefined`. |
| `StepPolicy.agent` (src/protocol/goal.ts) | zod field | Accepts an agent name (as RL-1, same message) **or** a string with `/` that `parseRosterKey` accepts; a string with `/` it rejects fails with `ROSTER_KEY_RULE`. |
| `CatalogSourceSave` | zod, strict | Body of `POST /v1/catalog-sources`: `{ repo: string 1..300, folder: string 1..200, calibrator?: string 1..100 }`. |
| `CatalogPush` | zod, strict | Body of `POST /v1/catalog-sources/push`: `{ repo: string 1..300, commit: /^[0-9a-f]{40}$/, defs: { path: string 1..300, text: string 1..100000 }[] ≤ 2000 }`. |
| `CatalogSourceView` | interface | `{ repo: string /* id */, name: string, folder: string, calibrator?: string, createdBy: string, createdAt: number, count: number /* current definitions */, commit?: string, digest?: string, pushedAt?: number, pushedBy?: string }`. |
| `CatalogDefView` | interface | `AgentFront` + `{ key: string /* canonical */, source: string, name: string, path: string, hash: string, commits: string[] /* oldest first, ≤ 50 */, commit: string /* the matched or latest one */, current: boolean, pushedAt: number, text: string }`. |
| `AgentCopy` | interface | `{ key: string, repo: Repo, origin: "repo" \| "catalog", kind: AgentKind, path: string, hash: string, commit?: string /* catalog */, machines?: number /* repo: reporting machines the viewer sees */, pin?: AgentPin, pinned: boolean, behind: boolean, modified: boolean, seenAt: number }`. |
| `AgentVersion` | interface | `AgentFront` + `{ hash: string, copies: AgentCopy[] }`. |
| `AgentGroup` | interface | `{ name: string, versions: AgentVersion[], diverged: boolean, pinned: boolean, behind: boolean, modified: boolean }`. |
| `AgentsView` | interface | `{ agents: AgentGroup[]; sources: CatalogSourceView[] }`. |

### Pure functions (src/core/roster.ts, exported from src/core/index.ts)

| Function | Contract |
|---|---|
| `catalogDigest(defs: { path: string; hash: string }[]): string` | Hex SHA-256 of the lines `<path>\t<hash>\n`, sorted by `path` (code points), concatenated. `[]` → SHA-256 of `""`. |
| `unifiedDiff(a: string, b: string, labelA: string, labelB: string): string` | `""` when `a === b` after CRLF→LF. Otherwise `--- <labelA>\n+++ <labelB>\n` and hunks `@@ -<s>,<n> +<s>,<n> @@` (1-based starts; a side with 0 lines uses start = line before, as `diff -u`) with 3 lines of context, a minimal line diff (LCS), lines prefixed `' '`, `-`, `+`; two changes separated by at most 6 unchanged lines share one hunk. A text without a final newline is compared as if it had one. Example: `unifiedDiff("a\nb\nc\n", "a\nB\nc\n", "x", "y")` = `"--- x\n+++ y\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n"`. |
| `canonicalKey(repoId: string, name: string): string` | `<last segment of repoId>/<name>`. |

### Daemon discovery (src/daemon/roster.ts, src/daemon/daemon.ts, src/daemon/hub-link.ts)

- `scanAgents(checkouts: { dir: string; repo: Repo \| undefined }[]): AgentReport[]` (exported from
  src/daemon/roster.ts). Checkouts are taken in the given order; one without a repo, or whose repo id
  starts with `local/`, is skipped, and a repo id seen before is skipped (first checkout wins). In each,
  `.claude/agents/*.md` (kind `claude`) then `.opencode/agent/*.md` (kind `opencode`), file names
  sorted, regular files directly in the folder only. Skipped: a name that is not an agent name, a file
  over 262 144 bytes, an unreadable file. Per file: `hash` = `agentFileHash(text)`; front matter with
  `parseAgentFile` (`description`, `model`, `tools`, `mesh-rules` → `rules`; a `tools` that is a map is
  left out); `description` cut to 1000 characters, `tools` to 100 and `rules` to 200 entries (entries
  over their length cap dropped); `path` relative with `/`. `pin` (kind `claude` only) = the entry of
  `<checkout>/.mesh/agents.lock` with the same `name` (`{source, commit, hash}`); a lock that does not
  parse as `AgentsLock` gives no pins. At most 2000 reports in total (the first 2000 in this order).
- The daemon computes the list with each MM-1 rescan (`REPO_SCAN_MS`) from `findCheckouts(workspaceRoots)`;
  under `shareSessions: "steps"` the list is `[]` and nothing is read.
- Sync: `machine.agents` is sent when its JSON differs from the last list sent with an accepted sync (as
  `repos`); otherwise the key is absent.

### Daemon catalog push

On each rescan, under `shareSessions` `me`/`all`, the daemon calls `GET /v1/catalog-sources` (a 404 or
an error: skipped until the next rescan). For each source whose `repo` equals the repo id of a scanned
checkout (first in scan order) and whose `<checkout>/<folder>` is a folder: defs = its `*.md` files
directly in it, sorted, whose name is an agent name and whose text is ≤ 100 000 characters, at most
2000, each `{path: "<folder>/<file>", text}` (text as read, unchanged). When `catalogDigest` of
`{path, hash: agentFileHash(text)}` differs from the source's `digest` (or it has none), the daemon calls
`POST /v1/catalog-sources/push {repo, commit: headCommit(checkout), defs}`. A refusal is logged as
`catalog push of <repo> refused: <message>` and tried again on the next rescan. A checkout without a
`HEAD` commit is not pushed.

### Hub store (src/store/hub-store.ts, src/store/hub-copy.ts)

| Interface | Change |
|---|---|
| `HubStore.SCHEMA_VERSION` | 11. `HUB_MIGRATIONS` and `HUB_MIGRATIONS_PG` each gain one entry (length 11). |
| Migration 11 | `agent_def (id TEXT PRIMARY KEY, origin TEXT NOT NULL, machine TEXT, repo TEXT NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL, current INTEGER NOT NULL, value TEXT NOT NULL, body TEXT, updated_at INTEGER NOT NULL)` with indexes on `(origin, machine)` and `(name)`; `catalog_source (repo TEXT PRIMARY KEY, value TEXT NOT NULL, created_at INTEGER NOT NULL)`. Postgres uses `BIGINT` for the time columns. A v10 database migrates with its data unchanged. |
| `replaceMachineAgents(machine: string, agents: AgentReport[], now: number): Promise<boolean>` | New; replaces every repo-origin row of the machine; `false` (nothing written) when the set equals the stored one. |
| `listRepoAgents(f?: { name?: string }): Promise<(AgentReport & { machine: string; at: number })[]>` | New. |
| `saveCatalogSource(s)`, `getCatalogSource(repo)`, `listCatalogSources()` | New; list by repo id. |
| `putCatalogDefs(repo: string, commit: string, defs: { path: string; name: string; hash: string; text: string; front: AgentFront }[], by: string, now: number): Promise<{ added: number }>` | New; a `(repo, name, hash)` not stored yet is added (`added` counts them), an existing one gets `commit` appended to `commits` (no duplicate; oldest dropped past 50) and its `pushedAt`; afterwards exactly the pushed `(name, hash)` pairs of the repo are current. Texts are never deleted. |
| `listCatalogDefs(f: { repo?: string; name?: string; current?: boolean }): Promise<CatalogDefView[]>` | New; with `text`. |
| `TABLES` (src/store/hub-copy.ts) | Gains, after `pulse_slot`: `{ name: "agent_def" }`, `{ name: "catalog_source" }`. |

### Hub behaviour (src/hub/service.ts)

**Sync.** With `machine.agents`, the hub drops reports whose `repo` is not in the machine's inventory
(after this sync's `repos`) and calls `replaceMachineAgents`; when it wrote, it records event
`agents.reported {machine, count}`. Without the key nothing changes.

**Visibility.** A repo copy reported by machine M is visible to M's user, and to everyone when M's
stored share level is `all`. Catalog definitions and sources are visible to every member (and to
service tokens with `goals:read`).

**Resolve** `(key)` → one catalog definition or an error (status, text), used by `GET /v1/agents/resolve`,
plan and pulse validation and offers:
1. `parseRosterKey` fails → 400 `ROSTER_KEY_RULE`.
2. Sources `S` with `repoMatches({id, name}, source)` (src/core/repo-id.ts): none → 404
   `no catalog source matches <source>`; more than one → 409 `<source> matches <n> catalog sources: <ids, comma-separated>`.
3. Without `ref`: the current definition of `(S, name)`; none → 404 `no agent <name> in catalog source <S id>`.
   With `ref`: the definitions of `(S, name)` whose `hash` or any of whose `commits` starts with `ref`;
   none → 404 `no definition of <canonical key> matches @<ref>`; more than one hash → 409
   `@<ref> matches <n> definitions of <canonical key>; give more characters`. `commit` of the result =
   the matched commit (the newest matching one), else its newest commit.

**Grouping** (`GET /v1/agents`): repo copies the caller sees, merged per `(repo id, path, hash, pin)`
(`machines` = number of machines, `seenAt` = newest report), plus one catalog copy per current catalog
definition (`commit` = its newest commit, `seenAt` = `pushedAt`). Copy flags: `pinned` = has `pin`;
`modified` = `pin` and `hash ≠ pin.hash`; `behind` = `pin` and the current definition of
`(pin.source, name)` exists with `hash ≠ pin.hash`. Catalog copies have all three false. A version's
front matter is that of its first copy. Group flags: `diverged` = more than one version; the others =
any copy's. Order: groups by name; versions by number of copies (desc) then hash; copies catalog first,
then by key, then kind.

**Plan validation.** `POST /v1/goals/:id/plan`, pulse create/update and `POST /v1/goals/from-preset`
add, for each step whose `agent` contains `/`, the problem `step "<id>": <resolve error text>` when
resolve fails (same 422 forms as `unknown profile`). RL-1's rule that `agent` needs `mode: headless`
applies to roster keys too.

**Offers.** For a headless step whose `agent` contains `/`, the offer message data (RL-1) gains
`agentDef: { key: <canonical key>, source: <source repo id>, name, hash, commit }` from resolve at
offer time, or `agentError: <resolve error text>` when it fails (the offer is still made). `agent`
stays the policy string. Other offers: unchanged.

**Events** (`docs/events.md`; payloads never carry texts, descriptions or paths):
`catalog.saved {repo, folder}`, `catalog.pushed {repo, commit, added, count}`, `agents.reported {machine, count}`.

### Routes (src/hub/app.ts, src/protocol/hub-api.ts)

| Route | Rule / scope / tag | Contract |
|---|---|---|
| `POST /v1/catalog-sources` | `admin`, tag `admin` | Body `CatalogSourceSave`. `repo`: `repoFromRemote(repo)?.id` when that parses and does not start with `local/`, else the lowercased input without a trailing `.git` when it matches `^[a-z0-9][a-z0-9.-]*(/[a-z0-9._-]+)+$`, else 422 `repo must be a repo id (host/path) or a remote URL`. `folder` must match `^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$` with no `.` or `..` segment, else 422 `folder must be a relative path inside the repo`. 201 with `CatalogSourceView` when new; 200 when it replaced the folder/calibrator of an existing one (`createdBy`/`createdAt` and pushed data kept). Event `catalog.saved`. Non-admin → 403. |
| `GET /v1/catalog-sources` | `member`, `goals:read`, tag `goals` | `{ sources: CatalogSourceView[] }` by repo id. |
| `POST /v1/catalog-sources/push` | `member`, tag `daemon` | Body `CatalogPush`. No machine on the token → 403 `a catalog push needs a device token`; unknown `repo` → 404 `no catalog source <repo>`; the machine's stored inventory lacks it → 403 `this machine does not report <repo> in its repo inventory`; a path that is not `<folder>/<agent name>.md` → 422 `catalog push: <path> is not <folder>/<name>.md`; a path twice → 422 `catalog push: <path> appears twice`. Else stores (`putCatalogDefs`, front matter as the daemon parses it), sets the source's `commit`, `digest` (`catalogDigest` of the pushed paths and hashes), `count`, `pushedAt`, `pushedBy`; event `catalog.pushed`; 200 `{ source: CatalogSourceView, added: number }`. |
| `GET /v1/agents` | `member`, `goals:read`, tag `goals` | Query `name` (exact agent name, optional). `AgentsView` (`sources` = all catalog sources). |
| `GET /v1/agents/resolve` | `member`, `goals:read`, tag `goals` | Query `key` (required; absent → 400 `ROSTER_KEY_RULE`). 200 `CatalogDefView`, or the resolve error as `{error}` with its status. |

### CLI (src/cli/roster-commands.ts; `mesh help` lists `agents` and `agent`)

Repo root of a command = the nearest folder at or above `--repo <path>` (default: the current folder)
that contains `.git`; none → exit 2 `not in a git checkout: <path>`. Lock = `<root>/.mesh/agents.lock`,
written as `JSON.stringify({version: 1, agents}, null, 2) + "\n"`, entries sorted by name, keys in the
order `name, source, commit, hash`. Installed file = `<root>/.claude/agents/<name>.md`. A hub refusal
prints its text and exits 1. Wrong arguments print the usage and exit 2; a bad key prints
`ROSTER_KEY_RULE` and exits 2.

| Command | Contract |
|---|---|
| `mesh agents [--name <n>] [--json]` | `GET /v1/agents`. `--json`: the `AgentsView` (2-space JSON). Else per group the line `<name>  versions <V>  copies <C>` followed by `  <flag>` for each true flag in the order `diverged`, `pinned`, `behind`, `modified`; per version `  <hash12>  <description or ->`; per copy `    <key>  <origin>` where origin is `repo` or `catalog <commit7>`, then `  pin <pin.commit7>` when pinned, `  behind`, `  modified` when true. No groups → `No agents on the roster.` Exit 0. |
| `mesh agent add <key> [--repo <path>] [--force]` | Resolves `key`. When the installed file exists, its hash differs from the definition's and there is no `--force` → exit 1 `<root>/.claude/agents/<name>.md exists and differs from <canonical key>@<commit7>; use --force to replace it` (nothing written). Else writes the definition's `text` byte for byte (creating folders), sets the lock entry `{name, source, commit, hash}` (replacing one of the same name, creating the lock), prints `Installed <canonical key>@<commit7> into .claude/agents/<name>.md (hash <hash12>); pinned in .mesh/agents.lock.`, exit 0. |
| `mesh agent outdated [--repo <path>] [--json]` | No lock → `No pinned agents in <root>.` exit 0. Per entry (lock order): `latest` = resolve `<source>/<name>` (no ref). Status: `missing` when the installed file is absent; else the comma-joined subset of `modified` (file hash ≠ pin hash) and `behind` (latest resolved and its hash ≠ pin hash) or `gone` (latest not resolved); `ok` when none. Line `<name>  <canonical key>@<pin commit7>  <status>` plus `  latest <commit7>` when behind. `--json`: `{ agents: { name, source, commit, hash, status, latest?: { hash, commit } }[] }`. Exit 0 when every status is `ok`, else 1. |
| `mesh agent diff <name> [--repo <path>]` | Not in the lock → exit 1 `<name> is not pinned in <root>/.mesh/agents.lock`. Else prints `unifiedDiff(<installed text or "">, <latest text>, ".claude/agents/<name>.md", "<canonical key>@<latest commit7>")`, or `<name>: no difference from <canonical key>@<commit7>` when it is empty. A resolve error → exit 1 with its text. Exit 0. |
| `mesh agent update <name> [--repo <path>] [--yes]` | Not in the lock → as `diff`. When the latest hash equals the pin hash and the installed file's hash equals it too → `<name> is up to date (<canonical key>@<commit7>).` exit 0. Else prints the diff as `diff` does, then without `--yes` asks `Replace .claude/agents/<name>.md with <canonical key>@<commit7>? [y/N] ` (the injected `readLine`, else stdin when it is a terminal); `y`/`yes` (any case) → writes the latest text and lock entry, prints `Updated <name> to <canonical key>@<commit7> (hash <hash12>).` exit 0; any other answer → `Not updated.` exit 1; no terminal and no `--yes` → `Not updated: run with --yes to confirm without a terminal.` exit 1. |
| `mesh agent source add <repo> --folder <path> [--calibrator <user>]` | `POST /v1/catalog-sources`; prints `Saved catalog source <repo id> (folder <folder>).` exit 0. |
| `mesh agent source ls [--json]` | `GET /v1/catalog-sources`; per source `<repo>  <folder>  <count> agent(s)  <commit7 or ->` plus `  calibrator <user>` when set; none → `No catalog sources.` `--json`: the reply. Exit 0. |

### Roster agents in headless runs (src/daemon/runs.ts, src/daemon/tools.ts)

For a headless offer whose `agent` contains `/`, at the start of the run, in place of reading
`<worktree>/.claude/agents/<agent>.md` (RL-1):
- no `agentDef` → not started with reason `roster agent <agent> was not resolved by the hub: <agentError or "no definition">`;
- `GET /v1/agents/resolve?key=<agentDef.source>/<agentDef.name>@<agentDef.hash>`; a refusal or no
  answer → not started `roster agent <agentDef.key> is not available: <message>`; `agentFileHash(text) ≠
  agentDef.hash` → not started `roster agent <agentDef.key> does not match its hash`;
- writes `<runDir>/agent.md` = text and `agents.json` = `{"<agentDef.name>": {…}}` built from it exactly
  as RL-1 (description, prompt, tools plus `MESH_TOOL_RULES`, model); argv as RL-1 with
  `--agents <runDir>/agents.json --agent <agentDef.name>`; run file `agent = {name: agentDef.name, key:
  agentDef.key, hash: agentDef.hash}` (so telemetry `agentKey`/`agentHash` and the review decider use
  them). Nothing is read from or written to the worktree's `.claude/agents/`.
- Not started = RL-1's not-started path (`exit: "crashed"`, step closed `fail` with summary
  `headless run of <step> did not start: <reason>`).
- `mesh_review` in such a run takes the declared rules from `<runDir>/agent.md` (front matter
  `mesh-rules`; no sibling rules file).

### Web (web/src/roster.tsx, web/src/main.tsx, web/src/api.ts)

- Header nav link `Roster` (`href="#/roster"`, class `active` on that route) after `Mine`.
- The page loads `GET /v1/agents` on open and again on every `changed` stream hint.
- `h2` `Roster`; `input[name="roster-filter"]` keeps groups whose name contains the text (any case).
- One `section.roster-group` per group with `data-name`, an `h3` with the name and one `span.roster-flag`
  per true flag (text = flag name, order as the CLI); per version a `div.roster-version` with
  `data-hash` (full hash) showing hash12, description, model, `tools: a, b` and `rules: a, b` when
  present; per copy an `li.roster-copy` with `data-key` whose text contains the origin (`repo` or
  `catalog <commit7>`), `pin <commit7>` when pinned and `behind`/`modified` when true.
- `section.roster-sources` lists each source as `li` with `data-repo`, text containing repo, folder and
  `<count> agent(s)`.
- No groups → `p.empty` `No agents on the roster yet.`; a filter matching none → `p.empty`
  `No agent matches "<text>".`

### Docs

| File | Change |
|---|---|
| `docs/guide/concepts.md` | "Roster": what is discovered (two folders, front matter fields, hash, share levels, remote-backed repos only, 2000 cap, user/plugin agents not), catalog sources (admin registers, a machine with the checkout pushes texts, digest), the flags, install by reference and the lock file format, roster keys in headless steps (`@ref`, resolved at offer time). |
| `docs/guide/howto.md` | "Share agents through the roster": register a source, `mesh agents`, `mesh agent add`, `outdated`, `diff`, `update`, a headless step with a roster key. |
| `src/protocol/skill.ts` `MESH_SKILL` + `skills/mesh/SKILL.md` | Rows for `mesh agents` and `mesh agent add <source>/<name>` (with `outdated`/`diff`/`update`). |
| `docs/plan/implementation-plan.md` §5.6 | Rows for the five new routes (v0.1.19). |
| `docs/events.md` | `catalog.saved`, `catalog.pushed`, `agents.reported`. |

### Compatibility

- A sync without `machine.agents` (older daemon) leaves stored rows unchanged; an older hub ignores the
  key and answers 404 to `GET /v1/catalog-sources`, which the daemon skips.
- Steps whose `agent` has no `/` behave as RL-1. Existing tests that compare `SCHEMA_VERSION`/migration
  counts (10), `TABLES`, the route list or the `mesh help` list are updated by the test-writer.

## Acceptance criteria

Surfaces: unit tests (`src/core`, `src/protocol`, `src/daemon/roster.ts`); `HubStore` contract test
(SQLite always; the Postgres leg runs only when `MESH_TEST_PG_URL` is set); World tests
(`test/helpers/world.ts` and kits; the test side may extend them) with the fake `claude` of RL-1; CLI
tests; Playwright (`test/e2e-web`, `pnpm test:web`). Fixture rules: a daemon reports only repos with a git
remote and only when its `shareSessions` is `me` or `all` (World defaults to `steps`); World tests that
move the clock past 14 days give device tokens a longer max age (as `test/pulse-daemon.test.ts`); web
e2e specs share one hub, so the Roster spec logs in as a new user `erin` (added to
`test/e2e-web/hub.yaml`) that no other spec asserts on. No test runs the real `claude` binary. Tests
find groups by name, copies by key, sources by repo id, events by `type`.

| Id | Criterion | Surface | What exact state makes it FAIL? |
|---|---|---|---|
| AC-01 | Schemas: `AgentReport` accepts a full report and rejects a bad hash, 101 tools, an unknown `kind`; `SyncRequest` accepts 2000 agents and rejects 2001; `AgentsLock` rejects `version: 2` and an entry with an extra key; `CatalogPush` rejects a 39-hex commit, a text of 100 001 characters and 2001 defs; `StepPolicy.agent` accepts `auditor`, `agents/reviewer`, `git.example.com/team/agents/reviewer@1a2b3c4` and rejects `a/b@xyz` with `ROSTER_KEY_RULE` and `-x` with the RL-1 message. `parseRosterKey("Example.com/Team/Agents/rev@abcdef1")` = `{source: "example.com/team/agents", name: "rev", ref: "abcdef1"}`; `"rev"`, `"a/"`, `"a/b@abc"` → `undefined`. | unit | Any accept/reject the other way, a different message or parse result. |
| AC-02 | `catalogDigest` equals the documented SHA-256 for two defs given in either order and for `[]`; `unifiedDiff` returns the documented example exactly, `""` for texts equal up to CRLF, an addition-only diff from `""` (`@@ -0,0 +1,2 @@`), and one hunk for two changed lines with 6 unchanged lines between them but two hunks with 7; `canonicalKey("git.example.com/team/agents", "rev")` = `agents/rev`. | unit | A different string. |
| AC-03 | Contract: `SCHEMA_VERSION` 11, both lists length 11; a v10 database (SQLite file; Postgres when set) migrates with goals, pulses and items intact; `replaceMachineAgents` replaces only that machine's rows and returns `false` for an identical set; `putCatalogDefs` counts `added`, appends a commit once, keeps 50 commits, makes exactly the pushed pairs current and keeps old texts; `listCatalogDefs` filters by repo, name, current; catalog sources save/get/list; `TABLES` lists both tables and `mesh hub migrate` copies their rows. | contract | A wrong version, count, row, flag or a lost row. |
| AC-04 | Discovery: `scanAgents` over a checkout with remote holding `.claude/agents/{reviewer.md,bad name.md}`, `.opencode/agent/doc.md` (tools as a map) and a 300 KB file gives exactly two reports in order `reviewer` (claude) then `doc` (opencode), with front matter, `rules` from `mesh-rules`, hash = `agentFileHash`, no `tools` for `doc`; a second checkout of the same repo and a checkout without remote add nothing; 2001 files → 2000 reports; a lock entry for `reviewer` sets `pin`, an invalid lock sets none. | unit (temp dirs) | Any report missing, extra, out of order or with a different field. |
| AC-05 | Sync: a World daemon with `shareSessions: "me"` and a remote-backed checkout with two agents makes `GET /v1/agents` (as its user) show both repo copies with `key` `<repo name>/<name>`, `machines: 1`; the next sync without changes has no `machine.agents`; after deleting a file and a rescan the copy is gone; after switching to `steps` and a sync the user sees no repo copies; with `shareSessions: "steps"` from the start no agent file is read and nothing is sent. Event `agents.reported` only when rows changed. | World | A copy shown, missing or kept wrongly, an agents key sent without a change, or a missing/extra event. |
| AC-06 | Visibility: machine of `alice` with share `me` → `bob` does not see its copies, `alice` does; after it switches to `all` (and syncs) `bob` sees them; catalog copies are seen by both. | World | A copy visible to the wrong user. |
| AC-07 | Catalog source: `POST /v1/catalog-sources` by a member → 403; by an admin with `https://git.example.com/Team/Agents.git` → 201 with `repo: "git.example.com/team/agents"`, `name: "agents"`; again with another folder → 200, `createdAt` kept; `repo: "nope"` and `folder: "../x"` → 422 with the documented texts; event `catalog.saved`; `GET /v1/catalog-sources` lists it. | World (hub API) | A wrong status, field or text, or a missing event. |
| AC-08 | Push route: token without machine → 403; unknown repo → 404; a machine whose inventory lacks the repo → 403; `agents/x/y.md`, `agents/bad name.md` and a duplicate path → 422 with the documented texts; a valid push of two defs → 200 `added: 2`, source `count: 2`, `commit`, `digest` = `catalogDigest`; a second push at another commit with one text changed and one removed → `added: 1`, `count: 1`, the removed name has no current definition but its text is still resolvable by `@hash`; event `catalog.pushed` each time. | World (hub API) | A wrong status, text, count, digest, current flag or event. |
| AC-09 | Daemon push: with a registered source and a World daemon (`me`) whose checkout of it holds `agents/rev.md`, the hub stores `rev` with the file's text byte for byte and `commit` = the checkout HEAD; a rescan without changes makes no push call; editing the file → one push on the next rescan; under `steps` no push; a hub 404 on `GET /v1/catalog-sources` does not stop the sync. | World | A missing, extra or different push, or a broken sync. |
| AC-10 | `GET /v1/agents`: with `reviewer` in repos `alpha` (hash H1, pinned to the catalog at H1), `beta` (hash H2, pinned at H1) and the catalog (current H3): one group `reviewer` with `diverged`, `pinned`, `behind`, `modified` true; versions ordered by copies; `alpha` copy `pinned`, `behind`, not `modified`; `beta` copy `modified` and `behind`; the catalog copy first in its version with `commit` and no flags; `?name=other` → no groups; two machines reporting the same `alpha` copy → one copy with `machines: 2`; `sources` lists the source. | World (hub API) | A wrong flag, order, merge or field. |
| AC-11 | Resolve: `?key=agents/rev` → the current definition with `text`, `commit` = newest; `@<commit7>` of an older push → that definition and that commit; `@<hash prefix>` → it; no `key` and `a/b@xyz` → 400 `ROSTER_KEY_RULE`; unknown source, unknown name, two sources named `agents`, a ref matching nothing and a ref matching two hashes → the documented status and text. | World (hub API) | A wrong definition, status or text. |
| AC-12 | `mesh agents`: the AC-10 roster prints exactly the documented lines (group line with flags, version lines, copy lines with `catalog <commit7>`, `pin <commit7>`, `behind`, `modified`); `--name rev` filters; `--json` prints the `AgentsView`; an empty roster prints `No agents on the roster.`; all exit 0. | CLI (hub of a World) | Any line or exit code differs. |
| AC-13 | `mesh agent add agents/rev --repo <checkout>`: the file equals the definition text byte for byte (CRLF kept), `agentFileHash(file)` = lock `hash`; the lock equals the documented JSON (entries sorted, key order, trailing newline); output line exact; a second add of another agent keeps the first entry; an existing different file → exit 1 with the documented text and no change; with `--force` replaced; `--repo /tmp/not-a-repo` → exit 2 `not in a git checkout: …`; `add rev` → exit 2 `ROSTER_KEY_RULE`; a hub 404 → exit 1 with its text. | CLI | A byte, lock entry, message or exit code differs, or a write on refusal. |
| AC-14 | `mesh agent outdated`: for entries ok, edited (`modified`), source moved on (`behind  latest <commit7>`), both (`modified,behind`), file deleted (`missing`) and name dropped from the source (`gone`) prints the documented lines and exits 1; all ok → exit 0; no lock → `No pinned agents in <root>.` exit 0; `--json` statuses and `latest`. | CLI | A wrong status, line or exit code. |
| AC-15 | `mesh agent diff rev` prints `unifiedDiff` of the installed text against the latest definition with the documented labels; identical → the documented no-difference line; unpinned name → exit 1 with the documented text. | CLI | Different output or exit code. |
| AC-16 | `mesh agent update rev`: up to date → documented line, exit 0, nothing written; behind with injected `readLine` answering `y` → diff, the exact prompt, file and lock updated to the latest, documented line, exit 0; answering `n` → `Not updated.` exit 1, nothing written; no `readLine` and stdin not a terminal → the no-terminal line, exit 1; `--yes` → updated without a prompt. | CLI | A write without confirmation, a missing prompt, wrong text or exit code. |
| AC-17 | `mesh agent source add <repo> --folder agents` prints the documented line (admin); as a member exits 1 with the hub's 403 text; `mesh agent source ls` prints the documented line per source, `No catalog sources.` when none; `mesh help` lists `agents` and `agent`. | CLI | A wrong line, exit code or help list. |
| AC-18 | Validation: a plan with a headless step `agent: "agents/rev"` (catalog has it) → 201 and the stored policy keeps the string; `agent: "nosuch/rev"` → 422 with problem `step "<id>": no catalog source matches nosuch`; `agent: "agents/rev"` without `mode: headless` → the RL-1 problem; `POST /v1/pulses` and `POST /v1/goals/from-preset` with `params.agent = "agents/nope"` → 422 with problem `step "<id>": no agent nope in catalog source <id>`. | World (hub API) | A missing, extra or differently worded problem, or a stored change. |
| AC-19 | Offer data: assigning a headless step with `agent: "agents/rev"` puts `agentDef {key: "agents/rev", source, name: "rev", hash, commit}` (current definition) in the message data; with `@<older commit7>` the older hash; when the source gained a second match after approval → `agentError` with the 409 text and no `agentDef`; an RL-1 step `agent: "auditor"` gets neither key. | World (hub API) | A key missing, extra or different. |
| AC-20 | Roster run: the daemon accepts the AC-19 offer and starts the fake `claude` with argv as RL-1 ending in `--agents <runDir>/agents.json --agent rev`; `<runDir>/agent.md` equals the catalog text; `agents.json` = `{"rev": {description, prompt, tools: [...front matter tools, ...MESH_TOOL_RULES], model}}`; the worktree has no `.claude/agents/rev.md` before or after; run telemetry `agentKey: "agents/rev"`, `agentHash` = the definition hash; a review record submitted by the run counts undeclared rules against `mesh-rules` of `agent.md`. | World + fake claude | Any argv, file, telemetry or rule count differs, or a file written into the worktree. |
| AC-21 | Roster run not started: offer data with `agentError` → step closed `fail` with summary `headless run of <step> did not start: roster agent agents/rev was not resolved by the hub: <text>`; the hub answering 404 on resolve → `…roster agent agents/rev is not available: <text>`; a resolved text whose hash differs (test hub stub) → `…roster agent agents/rev does not match its hash`; in each case the fake `claude` is never started. | World + fake claude | A started process, a different summary or no close. |
| AC-22 | Web Roster (as `erin`, after seeding her machine's sync with agents and an admin-registered, pushed source): nav link `Roster` opens `#/roster`; groups, flags, versions, copies and sources render with the documented selectors and texts; the filter hides non-matching groups and shows `No agent matches "<text>".`; a new agent reported by a sync appears within 20 s without a reload. | Playwright | A selector or text missing, a filter error, or no refresh. |
| AC-23 | Docs: concepts, how-to, mesh skill, plan API table and events list cover the Docs table; `MESH_SKILL` names `mesh agents` and `mesh agent add` and equals `skills/mesh/SKILL.md`. No team-, company- or person-specific name is added to code or docs (examples use `example.com` hosts). | review + skill test | A missing section, row or mention, a mismatch, or a specific name. |
| AC-24 | `package.json` version `0.1.19`; `pnpm check` passes (lint, typecheck, boundaries, test, build); `pnpm test:web` passes after `pnpm build`; `schemas/hub-api.openapi.json` matches `pnpm schemas` and lists the five new routes with the documented rule, scope and tag; `HUB_API` matches the served routes. | CI | Any check fails or the document differs. |

## Open questions

- 2026-11-12 **Agent name.** Design lists `name` among the front matter fields; RL-1 runs agents by
  file name. Assumed: the agent name is the file name without `.md`; front matter `name` is ignored.
- 2026-11-12 **Visibility under `me`.** The design says "under its share level". Assumed the MM-1 session
  rule: repo copies of a `me` machine are seen only by its user, of an `all` machine by everyone;
  catalog definitions by every member.
- 2026-11-12 **`@commit` vs `@hash`.** §5.10 writes `@commit` for install, §3 `@<hash>` for one
  definition. Assumed one `@<ref>` (7–64 hex) matching either a definition hash or a commit the hub saw
  in a push; the hub knows only commits a machine pushed at (pushes happen when content changes, not on
  every commit).
- 2026-11-12 **Installing repo agents.** Repo copies are sent without texts (§5.10), so only catalog
  definitions can be installed; to share a repo's agents, register that repo as a catalog source.
- 2026-11-12 **R-6 for roster agents.** A roster key without `@ref` is resolved when the hub makes the
  offer, so a pulse runs the source's current definition at each slot. Pin with `@<hash>` to freeze it.
  Snapshotting roster agents on the pulse is left to a later slice.
- 2026-11-12 **Canonical key collisions.** Two sources with the same last segment share a canonical key
  in views; resolve then answers 409 and the full repo id must be used as `<source>`.
- 2026-11-12 **Push trigger.** The daemon pushes when the digest of the folder differs from the hub's,
  not on every new commit of the source.
- 2026-11-12 **`outdated` exit code.** Assumed 1 when any entry is not `ok` (scriptable), 0 otherwise.
- 2026-11-12 **Calibrator.** Stored and shown on catalog sources only; acting on it is S6.
- 2026-11-12 **Caps.** The design gives 2000 per machine; assumed in addition 256 KiB per discovered
  file, 100 000 characters per pushed text, 2000 definitions per push, 1000 characters of description.
