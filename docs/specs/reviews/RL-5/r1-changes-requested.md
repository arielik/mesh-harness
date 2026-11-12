Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 2

# Review of spec RL-5, round 1

I reviewed `docs/specs/RL-5.md` (commit 14d9cc6) cold. I checked it against
`docs/analysis/2026-11-12-pulse-relay-roster.md` (REQ-11, REQ-12, R-4, R-6, §3, §5.1, §5.10, §6, §7,
§9 S5) and `docs/analysis/2026-11-12-claude-cli-spike.md` (6a, 6b, 6c). I also checked it against
`docs/specs/RL-1.md`, `RL-2.md` and `RL-3.md`, and against this code on `feat/relay-design`:
- `src/core/{headless,repo-id,presets,policy,visibility}.ts`
- `src/protocol/{goal,hub,hub-api,tools,json-schema}.ts`
- `src/store/hub-store.ts` (`SCHEMA_VERSION`) and `src/store/hub-copy.ts` (`TABLES`)
- `src/hub/service.ts` (`offerStep`, `proposePlan`, `presetChecks`, `goalFromPreset`, `snapshotProfiles`,
  sync facts, `deciderOf`) and `src/hub/app.ts` (the idempotency middleware)
- `src/daemon/{runs,tools,repos,git,hub-link}.ts`
- `src/cli/context.ts` (`readLine`), `web/src/main.tsx`, `test/helpers/world.ts`,
  `test/e2e-web/hub.yaml`, `docs/events.md`, `docs/plan/implementation-plan.md` §5.6

`docs/specs/reviews/RL-5/` did not exist before this round, so every finding is NEW. None is a REPEAT
or a REGRESSION-OF-OWN-REPAIR.

## Checks

This is a spec review, so there is no code to build. I did not run `pnpm lint`, `pnpm typecheck`,
`pnpm boundaries`, `pnpm test`, `pnpm build` (together `pnpm check`), `pnpm schemas` or
`pnpm test:web`. The Postgres legs of the store contract were not run either. I used only `git`,
`grep`, `sed`, `cat` and file reads. I did not run the `claude` binary.

## What already matches the code

- **The referenced helpers exist with the stated signatures.** `agentFileHash` and `parseAgentFile` are
  in `src/core/headless.ts`. A `tools` map gives `undefined` through `listField`, so "no `tools` for
  `doc`" in AC-04 holds. `repoFromRemote` and `repoMatches` are in `src/core/repo-id.ts`, and
  `repoMatches` matches a bare name, which is what makes the 409 for two sources named `agents`
  reachable. Also present: `headCommit` (sync) in `src/daemon/git.ts`, `findCheckouts` and
  `REPO_SCAN_MS` in `src/daemon/repos.ts`, `MESH_TOOL_RULES` in `src/protocol/tools.ts`, and the
  RL-1 agent-name regex and message in `src/protocol/goal.ts`.
- **Store.** `SCHEMA_VERSION` is `HUB_MIGRATIONS.length`, currently 10, and the contract tests assert
  10, so they will need the update the Compatibility section names. `TABLES` ends with `pulse_slot`.
  `mesh hub migrate` copies tables generically.
- **Sync.** `machine` is a nested object that requires `share`, so `SyncRequest.machine.agents` fits
  beside `repos`. The daemon's "send when the JSON differs from the last accepted list" rule is the
  same as `sentRepos` in `hub-link.ts`. World defaults to `shareSessions: "steps"`.
- **Visibility.** The rule matches `sessionVisible`: the owner sees a `me` machine's copies, and
  everyone sees an `all` machine's copies.
- **Routes.** `admin`, `member`, `goals:read` and the tags `admin`/`goals`/`daemon` all exist. A 201 or
  200 status on save follows `POST /v1/profiles`. The generic `Idempotency-Key` middleware covers the
  two new POST routes, so nothing extra is needed.
- **Runs.** `runs.ts` already writes `agents.json` keyed by the agent name, appends
  `MESH_TOOL_RULES` to a `tools` list, records `agent {name,key,hash}` for telemetry and the decider,
  and closes not-started runs with `headless run of <step> did not start: <reason>`. The roster path
  fits there, and spike 6a/6b confirms that `--agents <file> --agent <name>` works without touching
  the worktree.
- **Plan problems.** The `step "<id>": …` form and the 422 wrapper match the `unknown profile` paths
  in `proposePlan` and `presetChecks`. `instantiate` throws on an unfilled `{param}` in `agent`.
- **Web.** The nav already has `Mine` and the `changed` hint (`main.tsx:225-271`).
  `test/e2e-web/hub.yaml` follows the one-user-per-spec pattern used for `dave`.
- **Generic.** All examples use `example.com` and generic user names.

## Findings

### F1 (blocker, NEW): R-6 for agent definitions is deferred again, past the slice it was promised to

Design R-6: "What a slot runs (preset text, profile, **agent definition**) is pinned by hash when the
pulse is created or updated, never read from the subject repo at run time." RL-3 already deferred this
in its Open questions: "Agent definitions are not pinned in S3 … Pinning by hash comes with the roster
(S5)." RL-5 is S5, but it moves pinning out of scope again ("Pinning roster agents in a pulse
snapshot", Open questions "R-6 for roster agents") to "a later slice" that design §9 does not contain
(S6 is calibration and stats).

With the spec as written, a pulse step `agent: "agents/rev"` runs whatever the catalog's current
definition is at each fire. Any member with a checkout of the source can change it by pushing (see
F2), and the pulse owner does nothing to approve the change. This is the trust boundary R-6 exists
for, and design §7 says third-party agents are "pinned by commit; updates need a confirmed diff". The
decision is wrong for this row.

Fix:
- On pulse create, and on an update that changes `preset`/`params` (the same point profiles are
  snapshotted, `snapshotProfiles`), resolve every roster key without `@ref`. Do the same in
  `goalFromPreset` and on plan approval. Store `{<policy string> → hash}` with the snapshot (for
  example `goal.agents`, beside `goal.profiles`).
- At offer time, resolve `<source>/<name>@<pinned hash>`, so `agentDef` is the pinned definition.
- Add an AC in the style of RL-3 AC-07: push a new text after the pulse is created, and the next fire
  still offers the old hash. Updating the pulse picks up the new hash.
- RL-3 also promised pinning for repo agents (the RL-1 `<worktree>/.claude/agents/<name>.md` path).
  Either pin their hash too (the hub can store the hash a machine reported, and the daemon refuses a
  mismatch), or record explicitly in Open questions why repo agents stay unpinned, and name the slice
  that will pin them.

### F2 (blocker, NEW): catalog pushes take working-tree content from any member's checkout, so `commit` can be false and "current" can oscillate

"Daemon catalog push" reads `<checkout>/<folder>/*.md` from the working tree. It labels that content
`commit: headCommit(checkout)` and pushes whenever the digest differs from the hub's. AC-09 makes this
behaviour required ("editing the file → one push on the next rescan"). That causes three problems:
1. **The pin can be false.** An uncommitted edit or an untracked file is pushed under a HEAD commit
   that does not contain it. `mesh agent add` then writes a lock entry whose `commit` does not hold
   `hash`. That breaks REQ-12 ("records the pin (source, commit, hash)") and R-4.
2. **Any branch becomes current.** A member whose checkout of the source sits on a feature branch, or
   is behind origin, replaces the catalog's current definitions. Under F1's design, that changes what
   every unpinned roster step runs.
3. **Current oscillates.** Two machines at different commits each see the other's digest, so each
   pushes on every rescan (every 5 min). Each push flips `current`, emits `catalog.pushed`, toggles
   `behind` on every pinned copy, and changes what offers resolve to.

Fix (the conservative reading of "a machine that has the source checked out pushes its
definitions"):
- Push committed content only. Use the commit of the remote's default branch (for example
  `refs/remotes/origin/HEAD`, else HEAD), and read the files from that commit's tree (`git ls-tree` /
  `git show <commit>:<path>`), not from the working tree.
- Push only when the source has no stored `commit`, or when the stored commit is a strict ancestor of
  the candidate (`git merge-base --is-ancestor`). Otherwise skip, and log why.
- Replace the AC-09 "editing the file" case with three cases: an uncommitted edit causes no push; a
  new commit causes one push; two daemons at different commits converge on the newer commit, and the
  older one never overwrites it.

### F3 (suggestion, NEW): the value of the lock entry's `source` is not stated

AgentPin documents `source` as a repo id, but `mesh agent add` only says it "sets the lock entry
`{name, source, commit, hash}`". The CLI could write the key's source as typed (`agents`) or the
definition's full repo id. AC-13 compares the lock to "the documented JSON", so a blind test cannot
choose. Pinned behaviour also depends on the choice: `behind` in grouping matches `pin.source` against
catalog sources. State that `source` is `CatalogDefView.source` (the full repo id).

### F4 (suggestion, NEW): `mesh agent outdated` reports `gone` for any resolve failure

`gone` is defined as "latest not resolved", so a hub that is offline, a 401, or a 409 ambiguity marks
every entry `gone`. Use `gone` only for the 404 `no agent <name> in catalog source <id>`. Any other
failure should print its text and exit 1, as other hub refusals do. Add that case to AC-14.

### F5 (suggestion, NEW): two sync rules have no AC

No AC covers "the hub drops reports whose `repo` is not in the machine's inventory". Add a World or
hub-API case: a report for a repo outside `repos` is not stored.

The visibility rule also reads the stored share level, but rows survive when a machine's stored share
becomes `steps` and no `agents` key arrives (an older daemon). Consider hiding repo copies of machines
whose stored share is `steps` or absent, and test it.

### F6 (suggestion, NEW): sibling `<name>.rules.yaml` files are ignored

RL-2 defines declared rules as front matter `mesh-rules` **or** a sibling `<name>.rules.yaml`. Three
paths here ignore the sibling file: discovery (`rules` from `mesh-rules` only), the catalog push (only
`*.md`), and roster runs ("no sibling rules file"). A catalog agent that declares its rules in a
sibling file will therefore have every rule counted as undeclared (`other:<slug>`) in roster runs, and
the same agent run as a repo agent will not.

Either carry the sibling file (push it with the definition and merge its rules), or record the
limitation in Open questions and in the concepts doc.

### F7 (suggestion, NEW): catalog source ids that `parseRosterKey` cannot express can be registered

`POST /v1/catalog-sources` accepts any `repoFromRemote(...).id`, and those ids can contain
characters such as `~`, `+` or `%`. `parseRosterKey` allows only `[A-Za-z0-9._-]` in path segments.
A source with such an id can be registered and pushed, but its full id can never be used in a key,
and the daemon's run-time resolve `<agentDef.source>/<name>@<hash>` would fail with 400. Reject such
ids at registration with a documented 422, or widen the key grammar.

### F8 (suggestion, NEW): a catalog push has no total size cap

`CatalogPush` allows 2000 texts of 100 000 characters each, which is about 200 MB in one request, and
no hub body limit exists (`src/hub/app.ts`). The design estimates 1–3 MB. Add a cap on the summed
text length (for example 8 MB) with a documented 422, and test it in AC-01 or AC-08.

### F9 (suggestion, NEW): two parts of the `unifiedDiff` format are not pinned down

- The header is written as always `@@ -s,n +s,n @@`, but "as `diff -u`" implies the `diff -u` form,
  which omits `,1`. Say which form is meant (always `,n` is simpler).
- An LCS diff is not unique. State the tie-break: within a change block, all `-` lines come before
  the `+` lines. Otherwise the CLI and web tests in AC-15 and AC-16 may compare against a different
  but valid diff.

### F10 (suggestion, NEW): AC-05 says "no agent file is read", which a test cannot observe

The World test can observe what was sent, not which files were read. Phrase the criterion as "no
`machine.agents` key other than `[]`/absent is sent". Alternatively, inject the file reader into
`scanAgents`' caller so a test can assert that it was never called.

### F11 (suggestion, NEW): a canonical key can equal an RL-1 repo-agent key

A roster run's key is `<catalog repo name>/<name>`, and an RL-1 run's key is
`<subject repo name>/<name>`. If a subject repo has the same last segment as a catalog repo (for
example both named `agents`), telemetry, `raisedBy` and the S6 statistics would merge the two under
one key. Only the hash keeps them apart. Note this in Open questions next to "Canonical key
collisions", or use the full source id in `agent.key` for roster runs.

## Scope

The spec stays inside S5. `mesh agent source add|ls` is not in the design's CLI list, but admins need
it to use `POST /v1/catalog-sources`. Stats, the Roster metrics and TUI views are correctly left to
S6 or out of scope.

## Summary

There are 2 blockers (F1, F2) and 9 suggestions (F3 to F11). All 11 findings are NEW.
