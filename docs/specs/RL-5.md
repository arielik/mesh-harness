# Spec RL-5: Roster

## Status
Draft, revision 1 (blockers F1, F2 and suggestions F3-F11 of review round 1 addressed).

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
  at most 2000 per machine. Push catalog source definitions **with their text**, committed content only,
  when the daemon has the source checked out.
- Hub: migration 11 (`agent_def`, `catalog_source`); `POST /v1/catalog-sources` (admin),
  `GET /v1/catalog-sources`, `POST /v1/catalog-sources/push`, `GET /v1/agents` (grouped, flags
  `diverged`/`pinned`/`behind`/`modified`), `GET /v1/agents/resolve`.
- Roster keys `<source>/<name>[@<ref>]` as `StepPolicy.agent` of headless steps: plan and pulse
  validation, pinning by hash (R-6) on pulses and goals, offer data from the pin, and the daemon passing
  the pinned definition through `--agents`/`--agent`.
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
- Pinning RL-1 repo agents (`<worktree>/.claude/agents/<name>.md`) by hash (Open questions).
- Sibling `<name>.rules.yaml` files of catalog and discovered agents (Open questions).
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
| `AgentPin` | zod | `{ source: string 1..200 /* the full repo id of the catalog source, = CatalogDefView.source */, commit: /^[0-9a-f]{40}$/, hash: /^[0-9a-f]{64}$/ }`. |
| `AgentReport` | zod | `AgentFront` + `{ repo: string ≤200 /* repo id */, kind: AgentKind, path: string ≤300 /* relative, e.g. ".claude/agents/reviewer.md" */, name: agent name, hash: /^[0-9a-f]{64}$/, pin?: AgentPin }`. |
| `SyncRequest.machine.agents` (src/protocol/hub.ts) | zod field | New, optional: `z.array(AgentReport).max(2000)`. Absent: the hub keeps what it has; `[]`: the machine has none. |
| `AgentsLock` | zod | `{ version: z.literal(1), agents: { name: agent name, source: string /* full source repo id */, commit: 40 hex, hash: 64 hex }[] }` (strict entries). |
| `AgentDef` | zod, strict | `{ key: string /* canonical */, source: string /* full source repo id */, name: agent name, hash: 64 hex, commit: 40 hex }`: one pinned catalog definition. |
| `Goal.agents` (src/protocol/goal.ts) | zod field | New, optional: `z.record(z.string(), AgentDef)`, keyed by the step's policy string (`agent`). Stored in the goal's value (no new column). |
| `Pulse.agents` (src/protocol/pulse.ts) | zod field | New: `z.record(z.string(), AgentDef).default({})`, keyed as `Goal.agents`; a stored pulse without it reads as `{}`. `PulseView.agents`: `Record<string, string>` (policy string to hash), as `profiles`. |
| `ROSTER_KEY_RULE` | const | `"agent key must be <source>/<name>[@<7-64 hex>]"`. |
| `parseRosterKey(s: string): { source: string; name: string; ref?: string } \| undefined` | function | Matches `^([A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9._-]+)*)/([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:@([0-9a-f]{7,64}))?$` and length ≤ 200; `source` is lowercased. A string without `/` or not matching → `undefined`. |
| `StepPolicy.agent` (src/protocol/goal.ts) | zod field | Accepts an agent name (as RL-1, same message) **or** a string with `/` that `parseRosterKey` accepts; a string with `/` it rejects fails with `ROSTER_KEY_RULE`. |
| `CatalogSourceSave` | zod, strict | Body of `POST /v1/catalog-sources`: `{ repo: string 1..300, folder: string 1..200, calibrator?: string 1..100 }`. |
| `CatalogPush` | zod, strict | Body of `POST /v1/catalog-sources/push`: `{ repo: string 1..300, commit: /^[0-9a-f]{40}$/, defs: { path: string 1..300, text: string 1..100000 }[] ≤ 2000 }`. The cap on the summed `text` length (8 000 000) is a hub check (Routes), not part of the schema. |
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
| `unifiedDiff(a: string, b: string, labelA: string, labelB: string): string` | `""` when `a === b` after CRLF→LF. Otherwise `--- <labelA>\n+++ <labelB>\n` and hunks `@@ -<s>,<n> +<s>,<n> @@`, always with `,<n>` (also when n is 1; 1-based starts; a side with 0 lines uses start = the line before, e.g. `-0,0`) with 3 lines of context, a minimal line diff (LCS), lines prefixed `' '`, `-`, `+`; within a run of changed lines all `-` lines come before all `+` lines; two changes separated by at most 6 unchanged lines share one hunk. A text without a final newline is compared as if it had one. Example: `unifiedDiff("a\nb\nc\n", "a\nB\nc\n", "x", "y")` = `"--- x\n+++ y\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n"`. |
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

The daemon pushes **committed** content only, never its working tree. On each rescan, under
`shareSessions` `me`/`all`, it calls `GET /v1/catalog-sources` (a 404 or an error: skipped until the next
rescan). For each source whose `repo` equals the repo id of a scanned checkout (first in scan order):
1. Remote `R` = the remote that gave the checkout its repo id (`origin`, else the first). Candidate
   commit `C` = `git rev-parse --verify -q refs/remotes/<R>/HEAD^{commit}`, else `HEAD^{commit}`; none:
   not pushed.
2. When the source has a `commit` `S`: `C = S`: not pushed; `git merge-base --is-ancestor S C` fails
   (S is not an ancestor of C, or S is unknown to the checkout): not pushed, logged as
   `catalog push of <repo> skipped: <C7> does not descend from <S7>`. So a checkout on another branch or
   behind the stored commit never replaces the current definitions.
3. Defs = the blobs (modes `100644`/`100755`; symlinks and sub-trees skipped) directly in `<folder>/` of
   C's tree (`git ls-tree -z C -- <folder>/`), sorted by path, whose file name is `<agent name>.md` and
   whose text (`git show C:<path>`, UTF-8) is ≤ 100 000 characters, at most 2000, each
   `{path: "<folder>/<file>", text}` (text unchanged). No such folder in C: not pushed.
4. When the source has no `commit`, or `catalogDigest` of `{path, hash: agentFileHash(text)}` differs from
   its `digest`, the daemon calls `POST /v1/catalog-sources/push {repo, commit: C, defs}`. Otherwise no call.

Uncommitted and untracked files are therefore never pushed, and the `commit` of a push always contains
its texts. A refusal is logged as `catalog push of <repo> refused: <message>` and tried again on the next
rescan.

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

**Visibility.** A repo copy reported by machine M is visible to M's user when M's stored share level is
`me` or `all`, and to everyone when it is `all`; when M's stored share level is `steps` or absent, its
stored copies are visible to nobody (the rows are kept). Catalog definitions and sources are visible to every member (and to
service tokens with `goals:read`).

**Resolve** `(key)` → one catalog definition or an error (status, text), used by `GET /v1/agents/resolve`,
plan and pulse validation and offers:
1. `parseRosterKey` fails → 400 `ROSTER_KEY_RULE`.
2. A source whose repo id equals `source` is `S`. Else sources with `repoMatches({id, name}, source)`
   (src/core/repo-id.ts): none → 404
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

**Pins (R-6).** A roster key is resolved once, at the trust boundary, into an `AgentDef` (`key`,
`source` = the definition's full source repo id, `name`, `hash`, `commit` from resolve); afterwards
nothing re-resolves it:
- Pulse create, and a pulse update that changes `preset` or `params` (where profiles are snapshotted):
  `Pulse.agents` = one entry per distinct roster-key `agent` of the instantiated plan. An update of other
  fields keeps `agents`.
- A slot fire: the goal's `agents` = the pulse's `agents`. `POST /v1/goals/from-preset`: the goal's
  `agents` = the roster keys of its plan resolved at that call.
- `approvePlan` (also through `proposePlan` with `approve`): for each roster-key `agent` of the approved
  plan that has no entry in the goal's `agents`, resolve and add it; an entry already there is kept (a
  later plan moves a pin only by naming another key, e.g. with `@<ref>`). A resolve failure → 422
  `the plan has <k> problem(s): step "<id>": <text>; …` and nothing is approved (the plan stays pending).

**Offers.** For a headless step whose `agent` contains `/`, the offer message data (RL-1) gains
`agentDef` = the goal's `agents[<agent>]`, or, when the goal has no such entry, `agentError:
"<agent> is not pinned in <goal id>"` (the offer is still made). Offers never resolve, so a later push,
a new source with the same name, or a dropped name does not change what a pinned step runs. `agent`
stays the policy string. Other offers: unchanged.

**Events** (`docs/events.md`; payloads never carry texts, descriptions or paths):
`catalog.saved {repo, folder}`, `catalog.pushed {repo, commit, added, count}`, `agents.reported {machine, count}`.

### Routes (src/hub/app.ts, src/protocol/hub-api.ts)

| Route | Rule / scope / tag | Contract |
|---|---|---|
| `POST /v1/catalog-sources` | `admin`, tag `admin` | Body `CatalogSourceSave`. `repo`: `repoFromRemote(repo)?.id` when that parses and does not start with `local/`, else the lowercased input without a trailing `.git` when it matches `^[a-z0-9][a-z0-9.-]*(/[a-z0-9._-]+)+$`, else 422 `repo must be a repo id (host/path) or a remote URL`. A resulting id that does not match `^[a-z0-9][a-z0-9._-]*(/[a-z0-9._-]+)+$` (so a roster key could not name it) → 422 `repo id <id> cannot be used in an agent key`. `folder` must match `^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$` with no `.` or `..` segment, else 422 `folder must be a relative path inside the repo`. 201 with `CatalogSourceView` when new; 200 when it replaced the folder/calibrator of an existing one (`createdBy`/`createdAt` and pushed data kept). Event `catalog.saved`. Non-admin → 403. |
| `GET /v1/catalog-sources` | `member`, `goals:read`, tag `goals` | `{ sources: CatalogSourceView[] }` by repo id. |
| `POST /v1/catalog-sources/push` | `member`, tag `daemon` | Body `CatalogPush`. No machine on the token → 403 `a catalog push needs a device token`; unknown `repo` → 404 `no catalog source <repo>`; the machine's stored inventory lacks it → 403 `this machine does not report <repo> in its repo inventory`; a path that is not `<folder>/<agent name>.md` → 422 `catalog push: <path> is not <folder>/<name>.md`; a path twice → 422 `catalog push: <path> appears twice`; summed `text` length over 8 000 000 → 422 `catalog push: texts total <n> characters, over 8000000`. Else stores (`putCatalogDefs`, front matter as the daemon parses it), sets the source's `commit`, `digest` (`catalogDigest` of the pushed paths and hashes), `count`, `pushedAt`, `pushedBy`; event `catalog.pushed`; 200 `{ source: CatalogSourceView, added: number }`. |
| `GET /v1/agents` | `member`, `goals:read`, tag `goals` | Query `name` (exact agent name, optional). `AgentsView` (`sources` = all catalog sources). |
| `GET /v1/agents/resolve` | `member`, `goals:read`, tag `goals` | Query `key` (required; absent → 400 `ROSTER_KEY_RULE`). 200 `CatalogDefView`, or the resolve error as `{error}` with its status. |

### CLI (src/cli/roster-commands.ts; `mesh help` lists `agents` and `agent`)

Repo root of a command = the nearest folder at or above `--repo <path>` (default: the current folder)
that contains `.git`; none → exit 2 `not in a git checkout: <path>`. Lock = `<root>/.mesh/agents.lock`,
written as `JSON.stringify({version: 1, agents}, null, 2) + "\n"`, entries sorted by name, keys in the
order `name, source, commit, hash`; an entry's `source` is the definition's `CatalogDefView.source`
(the full repo id, never the key's source as typed). Installed file = `<root>/.claude/agents/<name>.md`.
The **latest** of a lock entry = resolve `<entry.source>/<entry.name>` (no ref). A hub refusal
prints its text and exits 1. Wrong arguments print the usage and exit 2; a bad key prints
`ROSTER_KEY_RULE` and exits 2.

| Command | Contract |
|---|---|
| `mesh agents [--name <n>] [--json]` | `GET /v1/agents`. `--json`: the `AgentsView` (2-space JSON). Else per group the line `<name>  versions <V>  copies <C>` followed by `  <flag>` for each true flag in the order `diverged`, `pinned`, `behind`, `modified`; per version `  <hash12>  <description or ->`; per copy `    <key>  <origin>` where origin is `repo` or `catalog <commit7>`, then `  pin <pin.commit7>` when pinned, `  behind`, `  modified` when true. No groups → `No agents on the roster.` Exit 0. |
| `mesh agent add <key> [--repo <path>] [--force]` | Resolves `key`. When the installed file exists, its hash differs from the definition's and there is no `--force` → exit 1 `<root>/.claude/agents/<name>.md exists and differs from <canonical key>@<commit7>; use --force to replace it` (nothing written). Else writes the definition's `text` byte for byte (creating folders), sets the lock entry `{name, source, commit, hash}` (replacing one of the same name, creating the lock), prints `Installed <canonical key>@<commit7> into .claude/agents/<name>.md (hash <hash12>); pinned in .mesh/agents.lock.`, exit 0. |
| `mesh agent outdated [--repo <path>] [--json]` | No lock → `No pinned agents in <root>.` exit 0. Per entry (lock order): its latest. A resolve failure other than a 404 whose text starts with `no agent ` (hub offline, 401, 409, any other refusal) → prints that text and no status line, exit 1. Status: `missing` when the installed file is absent; else the comma-joined subset of `modified` (file hash ≠ pin hash) and `behind` (latest resolved and its hash ≠ pin hash) or `gone` (resolve answered 404 `no agent <name> in catalog source <id>`); `ok` when none. Line `<name>  <canonical key>@<pin commit7>  <status>` plus `  latest <commit7>` when behind. `--json`: `{ agents: { name, source, commit, hash, status, latest?: { hash, commit } }[] }`. Exit 0 when every status is `ok`, else 1. |
| `mesh agent diff <name> [--repo <path>]` | Not in the lock → exit 1 `<name> is not pinned in <root>/.mesh/agents.lock`. Else prints `unifiedDiff(<installed text or "">, <latest text>, ".claude/agents/<name>.md", "<canonical key>@<latest commit7>")`, or `<name>: no difference from <canonical key>@<commit7>` when it is empty. A resolve error → exit 1 with its text. Exit 0. |
| `mesh agent update <name> [--repo <path>] [--yes]` | Not in the lock → as `diff`. When the latest hash equals the pin hash and the installed file's hash equals it too → `<name> is up to date (<canonical key>@<commit7>).` exit 0. Else prints the diff as `diff` does, then without `--yes` asks `Replace .claude/agents/<name>.md with <canonical key>@<commit7>? [y/N] ` (the injected `readLine`, else stdin when it is a terminal); `y`/`yes` (any case) → writes the latest text and lock entry, prints `Updated <name> to <canonical key>@<commit7> (hash <hash12>).` exit 0; any other answer → `Not updated.` exit 1; no terminal and no `--yes` → `Not updated: run with --yes to confirm without a terminal.` exit 1. |
| `mesh agent source add <repo> --folder <path> [--calibrator <user>]` | `POST /v1/catalog-sources`; prints `Saved catalog source <repo id> (folder <folder>).` exit 0. |
| `mesh agent source ls [--json]` | `GET /v1/catalog-sources`; per source `<repo>  <folder>  <count> agent(s)  <commit7 or ->` plus `  calibrator <user>` when set; none → `No catalog sources.` `--json`: the reply. Exit 0. |

### Roster agents in headless runs (src/daemon/runs.ts, src/daemon/tools.ts)

For a headless offer whose `agent` contains `/`, at the start of the run, in place of reading
`<worktree>/.claude/agents/<agent>.md` (RL-1):
- no `agentDef` → not started with reason `roster agent <agent> was not resolved by the hub: <agentError or "no definition">`;
- `GET /v1/agents/resolve?key=<agentDef.source>/<agentDef.name>@<agentDef.hash>` (the full source id, so
  never ambiguous); a refusal or no
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
  `mesh-rules` only; a sibling `<name>.rules.yaml` is not carried, see Open questions).

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
| `docs/guide/concepts.md` | "Roster": what is discovered (two folders, front matter fields, hash, share levels, remote-backed repos only, 2000 cap, user/plugin agents not), catalog sources (admin registers, a machine with the checkout pushes the committed texts of the remote's default branch, only forward, digest), the flags, install by reference and the lock file format (`source` = full repo id), roster keys in headless steps (`@ref`, pinned by hash when the pulse is saved or the plan approved, R-6), and the limits: declared rules come from front matter `mesh-rules` only (a sibling `<name>.rules.yaml` is not carried); RL-1 repo agents are not pinned. |
| `docs/guide/howto.md` | "Share agents through the roster": register a source, `mesh agents`, `mesh agent add`, `outdated`, `diff`, `update`, a headless step with a roster key. |
| `src/protocol/skill.ts` `MESH_SKILL` + `skills/mesh/SKILL.md` | Rows for `mesh agents` and `mesh agent add <source>/<name>` (with `outdated`/`diff`/`update`). |
| `docs/plan/implementation-plan.md` §5.6 | Rows for the five new routes (v0.1.19). |
| `docs/events.md` | `catalog.saved`, `catalog.pushed`, `agents.reported`. |

### Compatibility

- A sync without `machine.agents` (older daemon) leaves stored rows unchanged; an older hub ignores the
  key and answers 404 to `GET /v1/catalog-sources`, which the daemon skips.
- Stored pulses and goals without `agents` read as having no pins; no roster key existed before v0.1.19,
  so no stored step needs one.
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
| AC-05 | Sync: a World daemon with `shareSessions: "me"` and a remote-backed checkout with two agents makes `GET /v1/agents` (as its user) show both repo copies with `key` `<repo name>/<name>`, `machines: 1`; the next sync without changes has no `machine.agents`; after deleting a file and a rescan the copy is gone; after switching to `steps` and a sync the user sees no repo copies; with `shareSessions: "steps"` from the start no sync carries a `machine.agents` other than absent or `[]`. A sync (hub API) whose `machine.agents` holds a report for a repo outside its `repos` inventory stores no copy for that repo (the others are stored). A machine with stored share `me` and stored copies, then synced with share `steps` and no `agents` key (an older daemon): its copies are visible to nobody, its user included. Event `agents.reported` only when rows changed. | World (+ hub API) | A copy shown, missing or kept wrongly, an agents key sent without a change, a report outside the inventory stored, or a missing/extra event. |
| AC-06 | Visibility: machine of `alice` with share `me` → `bob` does not see its copies, `alice` does; after it switches to `all` (and syncs) `bob` sees them; catalog copies are seen by both. | World | A copy visible to the wrong user. |
| AC-07 | Catalog source: `POST /v1/catalog-sources` by a member → 403; by an admin with `https://git.example.com/Team/Agents.git` → 201 with `repo: "git.example.com/team/agents"`, `name: "agents"`; again with another folder → 200, `createdAt` kept; `repo: "nope"`, `folder: "../x"` and a remote whose id has a character outside the key grammar (e.g. `https://git.example.com/team/a~b.git`) → 422 with the documented texts; event `catalog.saved`; `GET /v1/catalog-sources` lists it. | World (hub API) | A wrong status, field or text, or a missing event. |
| AC-08 | Push route: token without machine → 403; unknown repo → 404; a machine whose inventory lacks the repo → 403; `agents/x/y.md`, `agents/bad name.md` and a duplicate path → 422 with the documented texts; 100 defs of 80 001 characters each (8 000 100 in total) → 422 `catalog push: texts total 8000100 characters, over 8000000`; a valid push of two defs → 200 `added: 2`, source `count: 2`, `commit`, `digest` = `catalogDigest`; a second push at another commit with one text changed and one removed → `added: 1`, `count: 1`, the removed name has no current definition but its text is still resolvable by `@hash`; event `catalog.pushed` each time. | World (hub API) | A wrong status, text, count, digest, current flag or event. |
| AC-09 | Daemon push: with a registered source and a World daemon (`me`) whose checkout of it has `agents/rev.md` committed (no `refs/remotes/origin/HEAD`), the hub stores `rev` with the committed text byte for byte and `commit` = the checkout HEAD; a rescan without changes makes no push call; an uncommitted edit of `rev.md` plus an untracked `agents/new.md` → no push on the next rescan; committing the edit → exactly one push, at the new commit, with the edited text; with `refs/remotes/origin/HEAD` pointing at a commit older than HEAD, the pushed commit and texts are the `origin/HEAD` ones. Two daemons with checkouts of the source at C1 and at its descendant C2 (C2 changes `rev`): after both rescan, in either order, the source's `commit` is C2 and the current `rev` is C2's text, and further rescans make no push from either daemon. Under `steps` no push; a hub 404 on `GET /v1/catalog-sources` does not stop the sync. | World | A push of uncommitted or untracked content, a missing, extra or different push, a source moved back to an older commit, or a broken sync. |
| AC-10 | `GET /v1/agents`: with `reviewer` in repos `alpha` (hash H1, pinned to the catalog at H1), `beta` (hash H2, pinned at H1) and the catalog (current H3): one group `reviewer` with `diverged`, `pinned`, `behind`, `modified` true; versions ordered by copies; `alpha` copy `pinned`, `behind`, not `modified`; `beta` copy `modified` and `behind`; the catalog copy first in its version with `commit` and no flags; `?name=other` → no groups; two machines reporting the same `alpha` copy → one copy with `machines: 2`; `sources` lists the source. | World (hub API) | A wrong flag, order, merge or field. |
| AC-11 | Resolve: `?key=agents/rev` → the current definition with `text`, `commit` = newest; `@<commit7>` of an older push → that definition and that commit; `@<hash prefix>` → it; no `key` and `a/b@xyz` → 400 `ROSTER_KEY_RULE`; unknown source, unknown name, two sources named `agents`, a ref matching nothing and a ref matching two hashes → the documented status and text. | World (hub API) | A wrong definition, status or text. |
| AC-12 | `mesh agents`: the AC-10 roster prints exactly the documented lines (group line with flags, version lines, copy lines with `catalog <commit7>`, `pin <commit7>`, `behind`, `modified`); `--name rev` filters; `--json` prints the `AgentsView`; an empty roster prints `No agents on the roster.`; all exit 0. | CLI (hub of a World) | Any line or exit code differs. |
| AC-13 | `mesh agent add agents/rev --repo <checkout>`: the file equals the definition text byte for byte (CRLF kept), `agentFileHash(file)` = lock `hash`; the lock equals the documented JSON (entries sorted, key order, trailing newline) with `source` = the full source repo id (e.g. `git.example.com/team/agents`, not `agents`); output line exact; a second add of another agent keeps the first entry; an existing different file → exit 1 with the documented text and no change; with `--force` replaced; `--repo /tmp/not-a-repo` → exit 2 `not in a git checkout: …`; `add rev` → exit 2 `ROSTER_KEY_RULE`; a hub 404 → exit 1 with its text. | CLI | A byte, lock entry, message or exit code differs, or a write on refusal. |
| AC-14 | `mesh agent outdated`: for entries ok, edited (`modified`), source moved on (`behind  latest <commit7>`), both (`modified,behind`), file deleted (`missing`) and name dropped from the source (`gone`) prints the documented lines and exits 1; all ok → exit 0; no lock → `No pinned agents in <root>.` exit 0; `--json` statuses and `latest`; the hub unreachable (or answering 401) → prints the error text, no status line and no `gone`, exit 1. | CLI | A wrong status, line or exit code, or `gone` for a failure other than the `no agent` 404. |
| AC-15 | `mesh agent diff rev` prints `unifiedDiff` of the installed text against the latest definition with the documented labels; identical → the documented no-difference line; unpinned name → exit 1 with the documented text. | CLI | Different output or exit code. |
| AC-16 | `mesh agent update rev`: up to date → documented line, exit 0, nothing written; behind with injected `readLine` answering `y` → diff, the exact prompt, file and lock updated to the latest, documented line, exit 0; answering `n` → `Not updated.` exit 1, nothing written; no `readLine` and stdin not a terminal → the no-terminal line, exit 1; `--yes` → updated without a prompt. | CLI | A write without confirmation, a missing prompt, wrong text or exit code. |
| AC-17 | `mesh agent source add <repo> --folder agents` prints the documented line (admin); as a member exits 1 with the hub's 403 text; `mesh agent source ls` prints the documented line per source, `No catalog sources.` when none; `mesh help` lists `agents` and `agent`. | CLI | A wrong line, exit code or help list. |
| AC-18 | Validation: a plan with a headless step `agent: "agents/rev"` (catalog has it) → 201 and the stored policy keeps the string; `agent: "nosuch/rev"` → 422 with problem `step "<id>": no catalog source matches nosuch`; `agent: "agents/rev"` without `mode: headless` → the RL-1 problem; `POST /v1/pulses` and `POST /v1/goals/from-preset` with `params.agent = "agents/nope"` → 422 with problem `step "<id>": no agent nope in catalog source <id>`. | World (hub API) | A missing, extra or differently worded problem, or a stored change. |
| AC-19 | Goal pins and offer data: approving a plan with a headless step `agent: "agents/rev"` stores `goal.agents["agents/rev"]` = `{key: "agents/rev", source: <full id>, name: "rev", hash, commit}` of the definition current at approval, and assigning the step puts that `agentDef` in the message data; after a push that changes `rev`, and after a second source named `agents` is registered, the offer still carries the approval-time `agentDef` and no `agentError`; a step with `@<older commit7>` gets the older hash; a later plan v2 approved with the same key keeps the v1 entry; approving a plan whose roster key no longer resolves (name dropped between propose and approve) → 422 with problem `step "<id>": no agent rev in catalog source <id>` and the plan stays pending; a goal with no entry for the key (entry removed through the store) → `agentError` `agents/rev is not pinned in <goal id>` and no `agentDef`; an RL-1 step `agent: "auditor"` gets neither key. | World (hub API) | A key missing, extra or different, an offer that follows a later push, or an approval that does not pin. |
| AC-20 | Roster run: the daemon accepts an AC-19 offer and starts the fake `claude` with argv as RL-1 ending in `--agents <runDir>/agents.json --agent rev`; `<runDir>/agent.md` equals the catalog text; `agents.json` = `{"rev": {description, prompt, tools: [...front matter tools, ...MESH_TOOL_RULES], model}}`; the worktree has no `.claude/agents/rev.md` before or after; run telemetry `agentKey: "agents/rev"`, `agentHash` = the definition hash; a review record submitted by the run counts undeclared rules against `mesh-rules` of `agent.md`. | World + fake claude | Any argv, file, telemetry or rule count differs, or a file written into the worktree. |
| AC-21 | Roster run not started: offer data with `agentError` → step closed `fail` with summary `headless run of <step> did not start: roster agent agents/rev was not resolved by the hub: <text>`; the hub answering 404 on resolve → `…roster agent agents/rev is not available: <text>`; a resolved text whose hash differs (test hub stub) → `…roster agent agents/rev does not match its hash`; in each case the fake `claude` is never started. | World + fake claude | A started process, a different summary or no close. |
| AC-22 | Web Roster (as `erin`, after seeding her machine's sync with agents and an admin-registered, pushed source): nav link `Roster` opens `#/roster`; groups, flags, versions, copies and sources render with the documented selectors and texts; the filter hides non-matching groups and shows `No agent matches "<text>".`; a new agent reported by a sync appears within 20 s without a reload. | Playwright | A selector or text missing, a filter error, or no refresh. |
| AC-23 | Docs: concepts, how-to, mesh skill, plan API table and events list cover the Docs table; `MESH_SKILL` names `mesh agents` and `mesh agent add` and equals `skills/mesh/SKILL.md`. No team-, company- or person-specific name is added to code or docs (examples use `example.com` hosts). | review + skill test | A missing section, row or mention, a mismatch, or a specific name. |
| AC-24 | `package.json` version `0.1.19`; `pnpm check` passes (lint, typecheck, boundaries, test, build); `pnpm test:web` passes after `pnpm build`; `schemas/hub-api.openapi.json` matches `pnpm schemas` and lists the five new routes with the documented rule, scope and tag; `HUB_API` matches the served routes. | CI | Any check fails or the document differs. |
| AC-25 | R-6 for pulses: a pulse (and a `POST /v1/goals/from-preset` goal) whose preset step uses `agent: "agents/rev"` stores `agents["agents/rev"]` with hash H1, and `PulseView.agents` = `{"agents/rev": H1}`; a machine then pushes a new `rev` (H2); the next fire's goal has `agents["agents/rev"].hash` = H1 and its offer `agentDef.hash` = H1; a pulse update of `window` only keeps H1; an update that changes `params` (or `preset`) re-resolves to H2, and the next fire offers H2. | World (hub API) | A fire that offers H2 before the update or H1 after it, or a missing pin. |

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
- 2026-11-12 **R-6 for roster agents (revised after review round 1, F1).** The first draft resolved at
  offer time and deferred pinning; that is withdrawn. Roster keys are pinned to a full `AgentDef` when a
  pulse is saved (create, or update of `preset`/`params`), when an ingest goal is made, and when a plan
  is approved; offers only copy the pin. Assumed: a later plan of the same goal keeps an existing pin of
  the same key (moving it needs another key, e.g. with `@<ref>`), so a re-approval never moves a pin
  silently.
- 2026-11-12 **R-6 for RL-1 repo agents (F1).** RL-3 promised pinning of agent definitions with S5. S5
  pins catalog agents; RL-1 repo agents (`<worktree>/.claude/agents/<name>.md`) stay unpinned, because
  the hub holds no text of them and repo copies are reported only under share `me`/`all`, so the hub
  cannot always know a hash to pin. A step that must not run a definition the subject repo can change
  uses a roster key (register the repo as a catalog source). Pinning repo agents (the hub storing a
  reported hash, the daemon refusing a mismatch) is in no slice of design §9; it needs a slice after S6
  to be added there.
- 2026-11-12 **Committed content only (F2).** Pushes read the tree of `refs/remotes/<remote>/HEAD`
  (else `HEAD`) and move a source's `commit` only forward (`merge-base --is-ancestor`). Assumed: after a
  history rewrite of the source (force push) the stored commit is no ancestor, so pushes stop and the
  source keeps its last definitions until removing a source exists (out of scope).
- 2026-11-12 **Sibling rules files (F6).** RL-2 also reads declared rules from a sibling
  `<name>.rules.yaml`. S5 carries front matter `mesh-rules` only (discovery, push, roster runs), so an
  agent that declares its rules only in a sibling file has them counted as undeclared in roster runs.
  Documented in the concepts doc; carrying the sibling file is left open.
- 2026-11-12 **Canonical key collisions.** Two sources with the same last segment share a canonical key
  in views; resolve then answers 409 and the full repo id must be used as `<source>`. Likewise a roster
  run's `agent.key` (`<catalog repo name>/<name>`) can equal an RL-1 run's key (`<subject repo
  name>/<name>`) when both repos have the same last segment (F11); telemetry, `raisedBy` and S6
  statistics then share a key and only the hash tells them apart. Kept for S5; S6 may key roster runs
  by the full source id.
- 2026-11-12 **Push trigger.** The daemon pushes when the digest of the folder at the candidate commit
  differs from the hub's (and that commit descends from the stored one), not on every new commit of the
  source; the hub knows only commits at which the content changed.
- 2026-11-12 **`outdated` exit code.** Assumed 1 when any entry is not `ok` (scriptable), 0 otherwise.
- 2026-11-12 **Calibrator.** Stored and shown on catalog sources only; acting on it is S6.
- 2026-11-12 **Caps.** The design gives 2000 per machine; assumed in addition 256 KiB per discovered
  file, 100 000 characters per pushed text, 2000 definitions per push, 8 000 000 characters of text per
  push (the design estimates 1-3 MB), 1000 characters of description.
