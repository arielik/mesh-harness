Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 5

# Review of the RL-7 spec, round 1

This is a cold review of `docs/specs/RL-7.md` (commit 7499e15). I checked it against the design
`docs/analysis/2026-11-12-pulse-relay-roster.md` (§5.1, §5.5, §5.6), the CLI spike
`docs/analysis/2026-11-12-claude-cli-spike.md`, and the code on `feat/relay-design`. No earlier rounds
exist (`docs/specs/reviews/RL-7/` was empty), so every finding is **NEW**. None is a REPEAT or a
REGRESSION-OF-OWN-REPAIR.

## Checks

| Check | Result |
|---|---|
| Throwaway vitest file (not committed, deleted afterwards): `parsePreset(p.name, presetText(p))` deep-equals `p` for every built-in at v0.1.20 | 4 of 4 passed. AC-15's round-trip claim holds today. |

Not run:
- `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm build`, `pnpm check`,
  `pnpm test:web` and `pnpm schemas`. This round reviews a spec, and nothing has been implemented.
- The Postgres legs of the `HubStore` contract. `MESH_TEST_PG_URL` is unset here, and CI runs them.
  B3 below concerns `src/store/hub-store.ts`, which is the same code on both dialects. I judged it on
  that shared code.

## Blockers

### B1 (NEW): the state, kind and repo of the session the daemon registers are not specified, and the default leads to a false "stalled" alert
Rule 1 and AC-01 require only that the session is "not `ended`". A session made the way the code makes
one today (`blank()` in `src/core/session-state.ts:55`) has `state: "idle"`, `kind: "unknown"` and no
`repo`. A hookless run sends no `UserPromptSubmit`, so nothing moves the session to `working`. Five
minutes after start (`stallAfterMs`), `applyTick` turns the idle session, which holds a step, into
`stalled` (`session-state.ts:438`). Then:
- `observe()` sends `session.stalled` to the hub (`daemon.ts:581`);
- the hub raises an attention item, `<step> stalled in <user>'s session` (`service.ts:2842`), for
  every hookless run longer than 5 minutes.

Both the `observe()` event payload (`repo: s.repo?.name`) and `mesh_context` (`s.repo`) also need
`repo`. With these fields left open, the most likely implementation is wrong, and AC-01 cannot catch
it. This is a decision the spec must make (blocker rules 2 and 3).
**Fix:** state the fields of the registered session: `kind: "print"`, a state that does not stall
while the run is alive (for example `working`, or run sessions exempt from the stall rule), and
`repo` = the repo of the worktree, as a hook would set it. Add to AC-01 or a new AC: with no hooks,
after `stallAfterMs + 1` and a tick, the session is not `stalled` and the hub's attention list has no
`stalled` item for the step.

### B2 (NEW): rule 3 binds the run's session to its step again after an accepted `mesh_done`
An accepted `mesh_done` clears the session's step (`host.update(s.sid, { clearStep: true })`,
`src/daemon/tools.ts:299`). The run is still `running` with no `endedAt` until the process exits. Any
later tool call from the run (agents often call `mesh_context` or `mesh_note` after `mesh_done`)
matches the second bullet of rule 3: a live session with the run's pid that holds no step. The daemon
then binds the closed step again, both locally and with a hub claim. `mesh_context` would serve a
`done` step as the current work, and a second `mesh_done` would reach the hub for a closed step.
AC-02 ("the step … closed twice") would not see this, because it calls no tool after `mesh_done`.
**Fix:** bind on a tool call only while the run has no accepted `mesh_done`. For example, bind only
when the session never held the run's step, or record "done accepted" in the run's meta. Add an AC:
after an accepted `mesh_done`, `w.tool(p, <fake pid>, "mesh_context")` answers with the no-step
text, the session holds no step, and the hub saw no further claim for the step.

### B3 (NEW): the claim "a catalog push sets `invalid` from then on" is false for definitions already stored
`putCatalogDefs` (`src/store/hub-store.ts`, around line 1256) updates only `path`, `commits` and
`pushedAt` for a known `(repo, name, hash)`. It keeps the `front` it stored the first time. The
smoke test's broken definition was pushed under v0.1.20 with `front: {}`. Pushing the same text again
does not change the hash, so `invalid` never appears for it in `GET /v1/agents` or
`GET /v1/agents/resolve`. Compatibility says "A machine scan or catalog push sets `invalid` from then
on", and Scope says there is no store change. Both are wrong for this case. The roster would hide
the very definition the fix is about (blocker rule 2). Machine reports are not affected, because
`replaceMachineAgents` rewrites every row.
**Fix:** pick one of these:
- compute the front matter fields from the stored `body` when reading (`listCatalogDefs` already
  reads `body`). This needs no schema change, and `hub-store.ts` serves both SQLite and Postgres;
- or refresh `front` when a known definition is pushed again.

Then add an AC: a catalog definition stored with a v0.1.20-style `front: {}` (or pushed before the
change) shows `invalid` after the change (with the read-time fix) or after a re-push (with the
refresh fix). Run that AC on the store contract (SQLite leg here, Postgres in CI).

### B4 (NEW): the "token-like" character set stops redacting ordinary passwords
`V'` must match `^[A-Za-z0-9_+/=.~-]{6,}$`. Many real passwords contain `@ # $ % ^ & * ! ?` and
similar characters. Examples:
- `password: P@ssw0rd1` is redacted by RL-1. Under RL-7 it is unchanged, because `@` is outside the set.
- `secret: S3cr3t#42` is likewise unchanged.

Problem 4 only asks that prose stop being rewritten. This change also weakens a privacy rule for
values that are clearly secrets (they contain a digit), and the trade-off in Open questions does not
mention it. That makes it a wrong decision (blocker rule 2).
**Fix:** define "token-like" so that it keeps secrets with symbols and still leaves prose and URLs
alone. One option: any run of non-space characters outside quotes, after stripping trailing
punctuation, that does not contain `://` and has a digit or is at least 20 characters long. Add rows
to the examples table: `password: P@ssw0rd1` → `password: R` (count 1), `secret: S3cr3t#42` →
`secret: R`, and keep the URL row.

### B5 (NEW): rule 4 does not cover a run reaped when the daemon restarts, so the session it registered stays live and keeps holding capacity
Rule 4 ends the run's session only in "the reconcile pass that sets `endedAt`". `HeadlessRuns.load()`
also sets `endedAt` (`markEnded` for a run that ended while the daemon was down, `runs.ts:185`). In
that case the session the daemon registered is never ended:
- it gets no hook;
- the session reconciler never saw it (`seenByReconciler: false`), so a dead pid does not end it;
- only "presumed ended" ends it, after 6 hours.

Until then it counts in `liveCount()`, so with `maxSessions: 1` it blocks queued runs. That is the
defect AC-05 exists to prevent. Before RL-7 the daemon never created such sessions, so RL-7 must
also end them (blocker rule 2).
**Fix:** end the run's session wherever `endedAt` is set, including the reap in `load()`. Add to
AC-05 or a new AC: the fake exits while the daemon is stopped; after a restart, the run's session is
`ended` and a queued run starts.

## Suggestions (not blocking)

- **S1 (NEW), AC-04(b) depends on the order of its steps.** If (b) runs after (a), (a)'s tool call
  has already revived the run's session with the step and the fake pid. In (b), `callTool` then finds
  that session first (`daemon.ts:1050`), so "that session now holds the step" fails even when the
  implementation is correct. Say that (b) starts from the AC-01 state plus a `SessionEnd`, without
  (a)'s tool call (a fresh World).
- **S2 (NEW), "the run's session" can name two sessions.** After the second bullet of rule 3 adds the
  run's session id to another session, two sessions contain it. Rule 4 should end every live session
  of the run (the `runSids` set), and the Terms should say so.
- **S3 (NEW), AC-07's "400-character parser message is cut to 300" has no stated input.** No natural
  front matter makes the `yaml` package produce a 400-character first line. Name how the test gets
  one (a mocked parser, or a test of the cut helper itself). Otherwise a blind test-writer has to
  guess.
- **S4 (NEW), the 422 text for a bad `params:` block is not stated.** `presetChecks` adds
  `preset <name>: ` before `parsePreset` errors (`service.ts:3011`). A bad `params:` block would
  therefore read `preset X: preset X: params must …`. State the 422 text, or drop the inner prefix.
- **S5 (NEW), scope and version skew of preset params.** Problem 8 is a missing feature, not a defect
  the smoke test found. It is small and fits design F16 (`{param}`), so I accept it in this row.
  However, a v0.1.21 CLI snapshot with `params:` and a string budget fails `parsePreset` on a
  v0.1.20 hub (422). Say so in Compatibility, since the hub must be upgraded first.
- **S6 (NEW), the definition of a "headless call" points at the wrong rule.** Rule 3 describes
  binding. Name the predicate instead: the session is a running run's session, the same test
  `isRunSession` / `runForSid` apply.
- **S7 (NEW), AC-03 mentions "the bind log", which does not exist.** Today only failed binds are
  logged (`daemon.ts:1249`). Make the World request log (`p.requests` with key
  `bind:<sid>:<step>`) the only measure.

## Checked and fine

- The `--session-id` binding agrees with the spike ("Other flags"). Pid matching through
  `process.ppid` (`main.ts:226`) and the exec-based launchers is consistent.
- After `CLAUDE_PID` is removed, the hooks' `${CLAUDE_PID:-$PPID}` still yields the pid of `claude`.
  The list of removed variables matches what mesh reads (`installer.ts`, `opencode/plugin.ts`).
- Matching hooks to sessions (`bind()` in `session-state.ts`: same Claude id, or same pid and cwd)
  supports rule 2 and the new session in AC-04(b).
- The YAML error text and line numbers in AC-07 match the `yaml` package (checked: `Nested mappings
  are not allowed in compact mappings at line 2, column 14:`).
- Every row of the redaction examples table follows from the stated rule (the defect is B4, not the
  examples).
- The `mesh preset ls` walk matches `findPresetSource`. The padding in AC-12 matches `padEnd(14)`.
- The `mesh_done` texts match `tools.ts:304` and `tools.ts:566` with the hint removed.
- No new hub route and no migration. AC-17 covers the OpenAPI change of `AgentReport`.
- No team-, company- or person-specific names in the spec.
