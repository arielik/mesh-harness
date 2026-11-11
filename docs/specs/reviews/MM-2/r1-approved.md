Verdict: APPROVED | Round: 1 | Blocking-open: 0

# Review of spec MM-2, round 1

Reviewed cold: `docs/specs/MM-2.md` (commit 4dbcce4, revision 1), against
`docs/analysis/2026-11-11-my-mesh-and-assign.md` (sections MM-2, Safety and privacy) and the code on
`feat/my-mesh-assign`: `src/protocol/{session,hub,hub-api,goal}.ts`, `src/store/hub-store.ts`
(`HUB_MIGRATIONS`, `machine.extra`, `machineFrom`, `touchMachine`, `setMachineNickname`,
`serialize`, `upsertSession`, `getSession`), `src/store/hub-copy.ts`, `src/store/daemon-store.ts`
(`kv`), `src/hub/{app,service}.ts` (`body`, the ZodError handler, idempotency, `renameMachine`,
`sync`, `liveSession`, `describe`, `listTopics`), `src/core/{roles,fleet,session-state}.ts`
(`allowed`, `renderFleet`, `findSession`, `sessionLabel`), `src/daemon/{daemon,hub-link}.ts`
(`/local/*` routes, `update` → `flush`, `sessionMetadata`, `syncedSessions`),
`src/cli/{context,machine-commands,mesh-commands}.ts` (`parseArgs`, `mesh machine`, `mesh run`),
`src/cli/tui/tui.ts` (keys), `web/src/mine.tsx` (15 s poll), `test/my-mesh.test.ts` (Postgres leg).
No earlier rounds exist for MM-2; the MM-1 rounds were read for precedent.

There is no CLAUDE.md in the worktree; the hard rules applied are the task's (generic names, no
team or person names). The spec uses only generic placeholders (`alice`, `bob`, `m2`, `perf`, `gpu`).

## What holds

- No migration is needed and none is claimed: MM-1 added the JSON column `machine.extra`
  (`MachineExtra`), `touchMachine` spreads the old `extra` when it replaces `repos`, and
  `hub-copy.ts` copies the whole `machine` table. `SCHEMA_VERSION` stays 6.
- `Label` reuses the exact `TopicName` regex; `all` being listed by `GET /v1/topics` (service
  `listTopics`) makes the "no warning for `all`" claim true.
- `Session` is a plain `z.object` (strip), so a v0.1.9 hub drops `labels` silently, as stated.
  `upsertSession` replaces `value` wholesale, so clearing labels on the daemon clears them on the hub.
- `Daemon.update` deletes `undefined` keys and calls `link.flush()`, so "empty list: key removed"
  and "next sync carries it" are implementable; the web Mine tab polls every 15 s, so AC-19's 20 s
  bound holds without an SSE hint (same reasoning as MM-1 AC-23).
- Authorization matches MM-1 `renameMachine` (403 for admins on another user's machine; a route
  without `scope` refuses service tokens through `allowed`). Idempotency is generic for every
  authenticated POST (`app.ts` line ~321), so nothing route-specific is missing.
- `z.toJSONSchema` handles the `MachineLabels` union, so `pnpm schemas` can describe it.
- Privacy: `sessionMetadata` still blanks `cwd` and leaves out `pid`, `pane`, `transcriptPath`,
  `lastMessage` (AC-02 checks it); remembered labels are keyed by local paths and stay in the daemon
  store; visibility of labelled sessions follows the MM-1 rule unchanged.
- The deviations from the design (replace, not union; per checkout; machine labels hub-only, not
  sent with sync) are recorded in Open questions with the alternative, and the third follows the
  approved MM-1 precedent for the nickname. They are defensible readings, not wrong decisions.
- No scope creep beyond the row: `filterFleet`, `POST /local/labels {cwd}` (needed by
  `mesh run --label`), `unknown` (needed by the design's warning) and `machine.labelled` (as
  `machine.named` in MM-1) all serve a design line; MCP setters, `mesh ls`/`show` and the web
  Live page are explicitly out.

Every acceptance criterion names a surface and a failing state. No blocker.

## Findings

### S1 (NEW, suggestion, recommended before implementation) Label write vs. concurrent sync can lose `repos` or `labels`

`setMachineLabels` rewrites `machine.extra`. `touchMachine` (from `POST /v1/sync`) reads and
rewrites the same column under a row lock (`SELECT … FOR UPDATE` on Postgres), but takes the
`events` lock only when the sync carries events. If `setMachineLabels` reads `extra` without the row
lock and writes it back, a sync that replaces the inventory between its read and its write is
overwritten (repos lost, and the daemon will not resend an unchanged inventory), or the reverse
loses the labels. The spec only orders label changes among themselves ("applied one after
another") and AC-08/AC-10 are sequential.
Fix: state that `setMachineLabels` (or the service's read-compute-write) reads `extra` under the
same row lock as `touchMachine` (`${dialect.forUpdate}`) inside one transaction, and extend AC-10
(Postgres leg when `MESH_TEST_PG_URL` is set): a label change concurrent with a sync that replaces
`repos` keeps both.

### S2 (NEW, suggestion) AC-09 Postgres leg must be conditional

AC-09 says the concurrent adds land "(SQLite and Postgres)" on surface "World / hub test". The
World runs on SQLite; MM-1 used `PgFixture` with `describe.skipIf(!PG_URL)` and a printed SKIPPED
line. Say "Postgres when `MESH_TEST_PG_URL` is set" as MM-1 AC-13 does, so the criterion does not
read as failing in an environment without Postgres.

### S3 (NEW, suggestion) `<who>` is a third session-naming rule

`<who>` = name, else repo name, else 8 characters of the sid. The code already has two:
`sessionLabel` (name, repo, folder name, sid) used by TUI/daemon messages, and `renderFleet`'s
`name || sid.slice(0, 8)`. Prefer `sessionLabel(s)` for the CLI and TUI `L` messages (it is what
`/local/next` and the TUI already print), and update AC-14/AC-18 wording accordingly.

### S4 (NEW, suggestion) Checkout key and symlinked paths

The checkout key is "the checkout top … as absolute paths". `mesh run` passes `resolveRepo`'s
directory (built from workspace roots, possibly through a symlink) while a hook reports the agent's
cwd, which may be the resolved path. Then `mesh run --label` remembers under one key and the
session looks up another, and AC-15 fails on such machines. Say both sides use `realpath` of the
checkout top (and that `POST /local/labels {cwd}` requires an absolute path; 400 otherwise).

### S5 (NEW, suggestion) Small gaps a blind test could hit

- `MachineLabels`: a body with both `labels` and `add`/`remove` is not specified (a non-strict zod
  union silently takes the first branch). Say 400, or which wins.
- `mesh machines --label x --json` with no match: the "No machine or session … labelled" text or the
  filtered `FleetView` with `machines: []`? Pin one in AC-13.
- `mesh label <s> perf, gpu` (labels split over two positionals) and `mesh label <s> ""`: usage
  (exit 2) or accepted? Same for `mesh machine label a, b`.
- `parseLabels` with both an invalid item and more than 10 labels: which error wins (invalid item
  first is the natural reading; say so).
- `mesh label` / `mesh run --label` when the daemon is not running: message and exit code
  (reuse the existing daemon-not-running text).
- `mesh machine label` against a v0.1.9 hub (route missing → 404 `not found`): say what the CLI
  prints, e.g. that the hub is older than v0.1.10.

### S6 (NEW, suggestion) AC-22 location clauses are not proven by `pnpm check`

"`parseLabels`/`Label` live in `src/protocol`, `filterFleet` in `src/core`, the YAML read in
`src/daemon`" cannot fail under `pnpm check` (boundaries only forbid wrong imports). Add "review"
to the surface, as AC-21 does. Same pattern was accepted in MM-1 AC-26, so this is not a blocker.

## Counts

Findings: 6 (all NEW: S1–S6). Blockers: 0. REPEAT: 0. REGRESSION-OF-OWN-REPAIR: 0.

## Checks

Spec review only; no code changed. Not run: `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`,
`pnpm test`, `pnpm build`, `pnpm check`, `pnpm schemas` (nothing to check against yet).
