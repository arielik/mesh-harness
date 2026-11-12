Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 2

# Review of the RL-5 diff, round 1

This is a cold review of `git diff feat/relay-design...comb/RL-5` (comb/RL-5 at 6d62a58) against
`docs/specs/RL-5.md` as it stands on comb/RL-5. Earlier rounds in `docs/specs/reviews/RL-5/` are
the spec reviews `r1-changes-requested.md` and `r2-approved.md`. No `diff-r*.md` existed before
this round, so every finding below is NEW. None is a REPEAT or a REGRESSION-OF-OWN-REPAIR.

## Checks

I exported comb/RL-5 and test/RL-5 with `git archive` into separate scratch folders and ran
`pnpm install --frozen-lockfile --prefer-offline` in each. Nothing was checked out in the
integration worktree.

| Check | Tree | Result |
|---|---|---|
| `pnpm lint` | comb/RL-5 | pass |
| `pnpm typecheck` | comb/RL-5 | pass |
| `pnpm boundaries` | comb/RL-5 | pass |
| `pnpm test` | comb/RL-5 | pass: 92 files, 2046 tests passed, 99 skipped |
| `pnpm build` | comb/RL-5 | pass |
| `pnpm schemas` | comb/RL-5 | the regenerated `schemas/hub-api.openapi.json` is byte-identical to the committed one |
| `pnpm test:web` | comb/RL-5, after `pnpm build` | pass: 42 tests, the 4 AC-22 roster tests included |
| RL-5 test files (vitest) | test/RL-5, which is base plus the tests and has no implementation | red as expected: every AC-01..AC-25 test fails (the core/protocol/daemon units and the roster-hub/cli/daemon suites fail outright; contract AC-03 and the version/count assertions fail; schemas AC-23/AC-24 fail) |

Not run:
- `pnpm check` as one command. I ran its five parts separately.
- The Postgres legs of the store contract and of m46 (`MESH_TEST_PG_URL` is unset). They were not
  run here; CI runs them. I judged AC-03 on its SQLite leg.
- The real `claude` binary. The tests use the fake executable.

## Test discipline

- **Every criterion has a test that failed first.** AC-01..AC-21 and AC-23..AC-25 have
  `test_ACnn_*` vitest tests. AC-22 has `test/e2e-web/roster.spec.ts`. All of them fail on
  test/RL-5, which is the tests without the implementation.
- **No assertion on source text.** The AC-23 checks read docs and `skills/mesh/SKILL.md`, which is
  the surface the AC names. No test reads a `.ts` file as text.
- **The test-writer changed no product code.** Commits 379e3e6, a3626b9 and 7891c8c touch only
  tests, `test/helpers/roster-kit.ts` and `test/e2e-web/hub.yaml`.
- **The developer added no new tests, but did edit existing ones.** See S1.
- After the combine, every test file on comb/RL-5 is identical to test/RL-5 (`git diff test/RL-5
  comb/RL-5 -- '*.test.ts' test/` is empty).

## What matches the spec

These parts match the spec:
- **Protocol.** The zod types, `parseRosterKey`, `ROSTER_KEY_RULE`, and the `StepPolicy.agent`
  union with the RL-1 message kept.
- **Core.** `catalogDigest`, `unifiedDiff` and `canonicalKey`.
- **Store.** Migration 11 has the same columns on both dialects, with `BIGINT` time columns on
  Postgres. `TABLES` is exported and extended.
- **Hub logic.** The resolve order and error texts, the grouping and flags, and the visibility rule.
  A machine whose stored share is `steps` or absent shows its copies to nobody.
- **Pins (R-6).** Pins are set on approve, on pulse create and on a preset/params update, on
  from-preset and on fire. An offer only copies the pin and never re-resolves.
- **Daemon.** Committed-only pushes read `ls-tree` and `cat-file` at `refs/remotes/<R>/HEAD`, else
  `HEAD`, with the forward-only `merge-base --is-ancestor` check. A roster run fetches the text by
  full hash, refuses a mismatch, writes `agent.md` and `agents.json` into the run dir and leaves the
  worktree untouched.
- **CLI.** The commands print the texts and use the exit codes the spec gives.
- **Web.** The page uses the documented selectors.
- **Docs.** The concepts, how-to, skill, plan table and events entries are present. Examples use
  `example.com`.

`approvePlan` saves `goal.agents` before `applyApproved`, and that function re-reads the goal
(`fresh`), so the new pins are not overwritten.

## Findings

### B1 (blocker, NEW, impl): a refused catalog push is retried on every sync flush, not on the next rescan

`src/daemon/daemon.ts`, `catalogPassOnce`. On any push error the code sets `this.pushedSeq = 0`,
with the comment "tried again at the next sync". `HubLink.flush` calls `afterSync` on every flush.
The daemon flushes on every reconcile, which is `reconcileMs` 5 000 by default, and on every
session change. The next flush therefore finds `scan.seq !== this.pushedSeq` and does the whole
pass again: it lists the sources again and POSTs the full push again. Each push can be up to 2000
texts.

The spec ("Daemon catalog push") says: "A refusal is logged as `catalog push of <repo> refused:
<message>` and tried again on the next rescan". A rescan happens every `REPO_SCAN_MS`.

A deterministic refusal therefore turns into a resend every few seconds that never ends, with the
log line repeated each time. Examples of such refusals:
- 422 `texts total … over 8000000`. The daemon caps each text and the count, but not the sum, so
  2000 texts of 100 000 characters each trigger it.
- 403 inventory.
- 422 path.

The Open questions do not record this deviation.

Expected: leave `pushedSeq` at the scan's `seq` after a refusal (an `HubRpcError` with a 4xx
status), so the next attempt comes with the next rescan as the spec says. Retrying sooner after a
transport failure or a 503 is acceptable, but record that choice in Open questions. A daemon test
should prove that a refused push is not sent again before the next rescan (see T1).

### B2 (blocker, NEW, impl): `pushCatalog` reads, then writes, without `store.serialize()`, so on Postgres two concurrent pushes can leave two current definitions

`src/hub/service.ts`, `pushCatalog`, together with `src/store/hub-store.ts`, `putCatalogDefs`. The
push runs in a plain `store.tx`. It reads the source and the existing `agent_def` rows and then
writes from what it read: `current = 0` for the repo, `current = 1` for the pushed ids, and the
source's `commit`, `digest` and `count`.

`src/store/pg.ts` and `HubStore.serialize` lay down the store rule: a transaction that reads and
then writes from what it read must serialize first ("writes that must not race say so in SQL").
Postgres runs at READ COMMITTED. Two daemons pushing the same source at once is exactly the AC-09
two-checkout setup. If push A commits new rows while push B's `UPDATE … SET current = 0 WHERE
repo = ?` statement is already running, those rows are not in B's snapshot. A's `rev@H1` and B's
`rev@H2` then both stay `current = 1`. That breaks the spec's "Current catalog definition … (at
most one)". After that, which definition resolve returns depends on the row order, and the source
row keeps whichever `commit`/`digest` committed last.

SQLite serialises write transactions, so the SQLite leg cannot show this race. This is a parity
bug of the Postgres leg.

Expected: call `await this.store.serialize()` at the start of the `pushCatalog` transaction. Do
the same in `saveCatalogSource`, which reads the existing source to keep `createdAt` and pushed
data. Alternatively, lock the `catalog_source` row with `forUpdate` before reading the definitions.

### S1 (suggestion, NEW, process): the developer edited existing tests on the implementation branch

Commit 0edbdba changed `src/store/hub-store.contract.test.ts` (10 -> 11 and `agents: {}`) and
`test/m46-ops.test.ts`. Commit dacae3a deleted RL-4's `test_AC24_version` in
`test/schemas.test.ts`. The spec's Compatibility section says these existing tests "are updated by
the test-writer", and the reviewer checklist says the developer changes no test.

The combine took the test-writer's versions, and comb/RL-5's tests equal test/RL-5's, so the final
tree is unaffected. That is why this finding does not block.

Expected: the developer leaves every `*.test.ts` and `test/**` file to the test side and names the
needed test updates in the commit message or the spec instead.

### S2 (suggestion, NEW, impl): stray `0` on the Roster page

`web/src/roster.tsx`, `Version` component: `{(v.model || v.tools?.length || v.rules?.length) &&
(...)}`. Take a version with no `model`, no `tools` and `rules: []` (front matter `mesh-rules: []`,
which `agentFront` keeps as `[]`). The expression then evaluates to `0`, and React renders a
literal `0`.

Expected: test with booleans, for example `(v.model || (v.tools?.length ?? 0) > 0 || (v.rules?.length
?? 0) > 0)`, or `!!(…)`.

### S3 (suggestion, NEW, spec/impl): a long source id makes a roster run fail at start

`src/daemon/runs.ts` resolves `<agentDef.source>/<agentDef.name>@<64-hex hash>`, and
`parseRosterKey` rejects keys over 200 characters. `CatalogSourceSave.repo` allows ids up to 300
characters, and `AgentPin.source` allows 200. Two examples hit the limit:
- A source id of 80 characters plus a 60-character name plus `@` and 64 hex characters is 206
  characters.
- So is a source id of 135 characters with a 5-character name.

Either way the pin is created fine through a short key such as `agents/rev`, and every run then
ends "not available: agent key must be …".

Expected: either cap repo ids at registration so that the full-id key always fits, for example
`id.length + 1 + 64 + 1 + 64 <= 200`, with a 422 otherwise, or allow a longer key or a hash-only
lookup on the resolve route for the daemon. Record the choice in Open questions.

### S4 (suggestion, NEW, spec): plan validation rejects a v2 plan whose key is already pinned

`proposePlan` calls `pinAgents(input.steps)` without the goal's `agents`. Suppose a v2 plan repeats
`agents/rev`, which is already pinned on the goal, after `rev` was dropped from the source. That
plan is refused with 422, although approval would keep the existing pin, as AC-19 says ("a later
plan v2 … keeps the v1 entry"). The current reading follows the letter of "Plan validation", but it
makes an existing pin unusable once the source drops the name.

Expected: decide this in Open questions. One option is to skip resolving keys the goal already has
pinned (pass `goal.agents` as `existing` in `proposePlan`).

### S5 (suggestion, NEW, impl/spec): re-registering a source with a new folder clears its calibrator

`saveCatalogSource` drops the stored `calibrator` when the body has none. As a result,
`mesh agent source add <repo> --folder other` silently removes a calibrator that was set before.

The spec says "200 when it replaced the folder/calibrator" and does not say what an absent field
means.

Expected: keep the stored calibrator when the body has none, or document the clearing in Open
questions and in the how-to.

### S6 (suggestion, NEW, spec): when a source's catalog does not move forward

Neither of the following cases is recorded in Open questions:
- **The folder changes but the commit does not.** After an admin changes a source's folder, the
  daemon still skips the push while `C === S`. The new folder's definitions arrive only after the
  next commit on the default branch.
- **The folder is emptied.** When every agent file is deleted, the daemon finds no entries and
  never pushes, so the hub keeps the old definitions current forever.
- **Concurrent pushes.** The hub does not enforce forward-only. Two daemons that both read `S`
  before either one pushes can briefly move the source back to the older commit; the newer daemon
  re-pushes on its next rescan. A pin taken in that window gets the older text.

Expected: an Open-questions entry for each case, or hub-side handling, such as clearing `commit`
when the folder changes, and an `expectedCommit` compare-and-set on push.

## Test findings

- **T1 (with B1).** `test/roster-daemon.test.ts` has no test showing that a refused push is retried
  only at the next rescan. Expected: after a push the hub refuses (for example a stub answering 422),
  further `flush()` calls before `REPO_SCAN_MS` has passed make no POST to
  `/v1/catalog-sources/push`, and the first flush after the clock passes the next rescan pushes again.
- **T2 (with B2, suggestion).** `src/store/hub-store.contract.test.ts` has no concurrent-push check.
  Expected: a Postgres-leg test where two `pushCatalog` calls for the same source run concurrently,
  for example two hub services on one database, each pushing `rev` with a different hash. Afterwards
  exactly one current definition of `rev` exists, and the source's `commit`/`digest` belong to the
  push whose definitions are current. (SQLite cannot show this race.)
- **T3 (with S2, suggestion).** `test/e2e-web/roster.spec.ts` does not cover a version with
  `rules: []` and no model or tools. Expected: such a version renders no text node `0`.
