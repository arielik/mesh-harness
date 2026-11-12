# RL-7 implementation plan

Spec: `docs/specs/RL-7.md` (approved, review round 2). Release v0.1.21. One section per acceptance
criterion; each lists files, changes, order, blast radius and risks. Tests are not planned here (the
test side plans from the spec alone). The developer changes no test except the existing ones listed
under "Existing tests and snapshots" at the end, and only where the spec changes the asserted
behaviour.

## Build order (all criteria)

1. **Protocol** (`src/protocol/roster.ts`): `AgentFront.invalid`, `AgentGroup.invalid`. Everything
   below compiles against these.
2. **Core, pure** (`src/core/headless.ts`, `src/core/roster.ts`, `src/core/redact.ts`,
   `src/core/presets.ts`, `src/core/session-state.ts`).
3. **Claude adapter** (`src/claude/headless.ts`): `HeadlessSpec.unsetEnv`.
4. **Store** (`src/store/hub-store.ts` `putCatalogDefs`), then **hub** (`src/hub/service.ts`
   roster grouping).
5. **Daemon** (`src/daemon/runs.ts`, `src/daemon/daemon.ts`, `src/daemon/tools.ts`,
   `src/daemon/trail.ts`).
6. **CLI** (`src/cli/hub-commands.ts`, `src/cli/show.ts`, `src/cli/roster-commands.ts`).
7. **Web** (`web/src/roster.tsx`, `web/src/goals.tsx`, `web/src/styles.css`).
8. **Docs, skill, version, schemas** last: `pnpm schemas` regenerates
   `schemas/hub-api.openapi.json` after step 1; the howto preset sha after step 2.

No migration, `SCHEMA_VERSION` unchanged, no new hub route, no new `/local` route. `src/daemon`
must keep importing no `child_process` (the env change lives in `src/claude`).

---

## AC-01 Registration without hooks

**Files.** `src/core/session-state.ts`, `src/daemon/runs.ts`, `src/daemon/daemon.ts`.

**Changes.**
- `src/core/session-state.ts`: new pure reducer
  `applyRunSession(sessions, r: { claudeSessionId: string; pid: number; cwd: string; step: string; repo?: Repo }, ctx): Result`.
  - Finds the session to reuse: first a non-ended one whose `claudeSessionIds` contains
    `r.claudeSessionId`, else the newest ended one with it (same search order as `bind()`); revives
    it (`revive()`). Otherwise creates `blank(ctx.newId(), r.cwd, ctx.now, "print")` with
    `claudeSessionIds: [r.claudeSessionId]`.
  - Sets `state: "working"` (`setWorking`), `kind: "print"`, `pid`, `cwd`, `step`, `repo` (when
    given), `lastEventAt = max(lastEventAt, now)`, `nudges`/`escalated` removed; deletes `pane`,
    `tmuxSocket`, `launching`. Leaves `stateAt` unset/unchanged so a later hook is never treated as
    stale against the registration.
  - Returns `{ sessions, changed: [sid] }`.
- `src/daemon/runs.ts`:
  - `RunsDeps` gains `registerRunSession(r: { runId: string; claudeSessionId: string; pid: number; cwd: string; step: string; sid?: string }): Promise<string | undefined>`
    (returns the daemon `sid`) and `endRunSessions(sids: ReadonlySet<string>, reason: string): void`
    (AC-05).
  - `start()`: after `runner.start` succeeds and the run is saved `running` (pid known), and
    **before** `await this.reportStarted(next)`, call
    `await this.deps.registerRunSession({ runId, claudeSessionId: run.sessionId, pid: r.pid, cwd: worktree, step: run.step })`
    and record the returned sid in `meta.sids` (new private `adoptSid(run, sid)`, same write as
    `onSessionStart`). Wrapped in try/catch: a failure is logged, never fails the run.
  - New `liveRunSids(): Set<string>`: `runSids()` of every run with `state: "running"` and no
    `endedAt` (used by the tick).
- `src/daemon/daemon.ts`:
  - New private `async bindRunSession(r, existingSid?)`, passed as `registerRunSession` in the
    `HeadlessRuns` constructor:
    1. Without `existingSid`: `this.commit(applyRunSession(this.sessions, { ..., repo: this.deps.repoForCwd(cwd) }, this.ctx()))`.
       With `existingSid` (AC-04 case 2): `this.update(sid, { step, nudges: 0, escalated: false, claudeSessionIds: [...ids, claudeSessionId] })`
       (id appended only when missing).
    2. `commit()` already gives a new record its checkout labels and fires `observe()` (provenance
       event, so the hub sees the session and its state).
    3. Hub bind once per `(sid, step)`: when `!this.boundSteps.has(`${sid}:${step}`)`, add the key
       first, then `await this.link?.rpc("POST", /v1/steps/<step>/claim, { sid }, `bind:${sid}:${step}`)`
       inside try/catch (offline or refused → logged; the session keeps the step locally). Same
       request and key as `applyEvent` sends today.
    4. `void this.link?.flush()`; return the sid.
  - `tick()`: pass `this.runs?.liveRunSids()` into `applyTick` (see below).
- `src/core/session-state.ts` `applyTick(sessions, ctx, keep?: ReadonlySet<string>)`: for a sid in
  `keep`, skip the `idle → stalled` rule and the `presumed ended` rule (quiet flag unchanged). Only
  the daemon passes `keep`; every other caller is unchanged.

**Order.** Reducer and `applyTick` first, then `runs.ts` deps, then `daemon.ts` wiring.

**Blast radius.** Every headless run now has a session from its start: `GET /local/sessions`, the
TUI, and `liveCount()` (the session replaces the `runningWithoutSession()` count; the total is the
same). `observe()` now sends `session.provenance` for runs without hooks (it did with hooks).

**Risks.**
- The hub claim is awaited before `run started` is reported; a slow hub delays `reportStarted` by
  one RPC timeout at most. Accepted (rule 1 orders registration before `run started`).
- `applyObservation` may see a `claude -p` process in `claude agents --json`; it then matches by
  pid (registered) and keeps one session. If a later observation lacks the pid the session ends as
  `process exited`, which is also correct.

## AC-02 Tools work without hooks

**Files.** None beyond AC-01 (and AC-20 for done tracking).

**Changes.** With the AC-01 session live and holding the step, `callTool` finds it by pid as
today; `mesh_context`, `mesh_artifact` (`runs.artifactStored` via `runSids` which includes the
registered sid through `claudeSessionIds`), `mesh_done` work unchanged. `finish()` decides
`own-round` from the round's `sid` (in `runSids`), so no transcript is stored and no second done is
sent.

**Order.** After AC-01.

**Risks.** `finish()` picks `sid` for a fail-close among `runSids` excluding `run.sessionId`; the
registered sid qualifies. No change needed.

## AC-03 Hooks stay idempotent

**Files.** `src/daemon/daemon.ts` (verification only), `src/core/session-state.ts` (none).

**Changes.**
- `applyHook`'s `bind()` finds the registered session by `claudeSessionIds` (live), so no second
  session. `SessionStart` keeps `working` (it only sets idle when not working). `UserPromptSubmit`
  keeps working, `Stop` may set idle (allowed by the spec).
- `applyEvent`: the existing `boundSteps` check (`s.step !== hint || !boundSteps.has(key)`) skips
  the second bind claim, because AC-01 added `${sid}:${step}` before claiming and set `step`. No
  code change, but the key format must be identical (`${sid}:${step}`).
- `runs.onSessionStart` keeps adding the sid to meta (already there from AC-01; no duplicate).
- `Stop` reply stays `{}` through `quiet()` → `isRunSession`.

**Risks.** `boundSteps` is in memory only; after a daemon restart a hook's `X-Mesh-Step` sends the
claim again with the same idempotency key (the hub dedupes). Same as v0.1.20.

## AC-04 Bind on first tool call

**Files.** `src/daemon/daemon.ts` (`callTool`), `src/daemon/runs.ts`.

**Changes.**
- `src/daemon/runs.ts`: new `runForPid(pid: number): { runId: string; sessionId: string; step: string; worktree: string } | undefined`:
  a run with `state: "running"`, no `endedAt`, `pid === run.pid`, `worktree` set, and
  `meta.doneAccepted !== true` (AC-20). Public `adoptSid(runId, sid)` wrapper for the daemon.
- `src/daemon/daemon.ts` `callTool`, the Claude (no `agentSessionId`) branch only:
  ```
  let s = live non-opencode session with pid;
  if ((!s || !s.step) && this.runs) {
    const r = this.runs.runForPid(call.pid);
    if (r) { await this.bindRunSession({ ...r, pid: call.pid, cwd: r.worktree }, s?.sid); s = live session by pid; }
  }
  ```
  Case 2 (live session, no step) → `existingSid = s.sid`; case 3 (no live session) → no
  `existingSid`, so `applyRunSession` reuses and revives the session of the run's Claude id (same
  `sid`). The sid is recorded via `runs.adoptSid`. Otherwise the existing texts are returned
  unchanged.
- OpenCode (`agentSessionId`) path untouched.

**Order.** After AC-01 and AC-20's `doneAccepted` flag.

**Blast radius.** Only calls from a pid that is a live run's started pid; all other tool calls keep
their current path and texts (AC-04 c).

**Risks.** A session revived by a tool call after `SessionEnd`: `boundSteps` already holds the key,
so no second claim (matches "once per (sid, step)"). Pid matching is exact (spec Open question).

## AC-05 Session ends with the run

**Files.** `src/core/session-state.ts`, `src/daemon/runs.ts`, `src/daemon/daemon.ts`.

**Changes.**
- `src/core/session-state.ts`: new pure `endSessions(sessions, sids: ReadonlySet<string>, reason: string, ctx): Result`
  using the existing `end()` for every non-ended session in `sids`; ended ones untouched.
- `src/daemon/runs.ts` `markEnded(run)`: after `save`, call
  `this.deps.endRunSessions(this.runSids(run), "headless run ended")`. Also call it in
  `notStarted()` (it sets `endedAt` too; normally no session exists). Both run before `finish()`,
  i.e. before the end-of-run hub calls.
- `src/daemon/daemon.ts`: `endRunSessions` = `this.commit(endSessions(this.sessions, sids, reason, this.ctx()))`
  then `void this.link?.flush()`. `observe()` sends `session.ended`.
- `liveCount()` needs no change: ended sessions are not counted and `runningWithoutSession()`
  skips runs with `endedAt`. The `reconcile()` → `queuePass()` after an `ended` run then starts the
  queued run.

**Order.** After AC-01.

**Risks.** `finish()` picks a fail-close `sid` among sessions still listed (ended ones remain in
`this.sessions` for 24 h), so the summary `sid` is unchanged.

## AC-19 Session ends when a run is reaped at restart

**Files.** `src/daemon/runs.ts`, `src/daemon/daemon.ts` (order check only).

**Changes.** `load()` reaps through `markEnded()`, which now ends the run's sessions (AC-05).
`Daemon.start()` already loads sessions from the store (`this.sessions = this.store.loadSessions()`)
**before** `this.runs?.load()`, so the sessions to end are present; keep that order. `commit()` from
inside `load()` saves the ended sessions; `link` may not be streaming yet, `observe()` only spools.

**Risks.** `deps.endRunSessions` is called during the constructor-to-start window only via
`load()`; it must not touch the HTTP server. It does not.

## AC-20 No rebind after done

**Files.** `src/daemon/tools.ts`, `src/daemon/runs.ts`, `src/daemon/daemon.ts`.

**Changes.**
- `src/daemon/runs.ts` `RunMeta` gains `doneAccepted?: boolean`. New
  `doneAccepted(sid: string, step: string): void`: for the running run whose `runSids` has `sid` and
  whose `step === step`, `saveMeta({ ...m, doneAccepted: true })` (persisted in `meta.json`, so it
  survives a restart). `runForPid` returns undefined once it is set (AC-04).
- `src/daemon/tools.ts`: `ToolHost` gains `doneAccepted?(sid: string, step: string): void`. In
  `mesh_done`, call it after the hub accepted (`r` defined and `!r.rejected`, right where
  `clearStep` happens) and in `doneOffline` (queued offline counts as accepted).
- `src/daemon/daemon.ts` `toolHost()`: `doneAccepted: (sid, step) => this.runs?.doneAccepted(sid, step)`.

**Result.** After the done, the session holds no step; a tool call from the run's pid finds the
live session without step, `runForPid` returns undefined, and the RL-1 texts apply
(`This session holds no mesh step…`, `this session holds no step`). No claim is sent.

**Risks.** A `Not accepted:` reply (`r.rejected`) must not set the flag; keep the call after that
check.

## AC-06 Environment

**Files.** `src/core/headless.ts`, `src/core/index.ts` (already re-exports `headless.ts`),
`src/claude/headless.ts`, `src/daemon/runs.ts`.

**Changes.**
- `src/core/headless.ts`: `export const HEADLESS_ENV_UNSET = ["TMUX", "TMUX_PANE", "MESH_AUTOPILOT", "CLAUDE_PID"] as const;`
- `src/claude/headless.ts`: `HeadlessSpec.unsetEnv?: readonly string[]`. `processRunner.start`
  passes `unsetEnv` in the waiter's JSON spec. In `WAITER`:
  `const env = { ...process.env, ...spec.env }; for (const k of spec.unsetEnv || []) delete env[k];`
  and spawn with `env`. Order (waiter env, then `spec.env`, then removal) makes `spec.env` unable to
  re-add a removed name.
- `src/daemon/runs.ts` `start()`: `runner.start({ argv, cwd: worktree, env: { MESH_STEP, MESH_RUN }, unsetEnv: HEADLESS_ENV_UNSET, runDir })`.
  `src/claude` must not import `src/core` if boundaries forbid it; the constant is passed in from
  the daemon, so it does not.

**Blast radius.** Only the child of headless runs. `reapGroup` still finds members by `MESH_RUN`.

**Risks.** Other `HeadlessRunner` implementations (test fakes) ignore `unsetEnv`; the field is
optional, so they keep compiling.

## AC-07 Front matter parsing

**Files.** `src/core/headless.ts`, `src/core/roster.ts`, `src/protocol/roster.ts`.

**Changes.**
- `src/core/headless.ts`:
  - `splitFrontMatter` returns `{ fm, body, found, invalid?: string }`. On a thrown parse error:
    `invalid = "front matter is not valid YAML: " + firstLine(e.message).replace(/:$/, "")` (one
    trailing colon). `yaml.parse` is given only the block text, so its line numbers already count
    from the first line after `---`. A parsed value that is `null`/`undefined` → `{}` (valid). Any
    other non-mapping (array, scalar) → `invalid = "front matter is not a YAML mapping"`. Cut to 300
    characters.
  - `AgentFile.invalid?: string`. `parseAgentFile`: when `invalid` is set return `{ invalid, body }`
    only (no name/description/tools/model/rules).
  - `frontMatter(text)` unchanged (`{}` for invalid).
- `src/protocol/roster.ts`: `AgentFront` gains `invalid: z.string().max(300).optional()` (flows into
  `AgentReport`, `CatalogDefView`, `AgentVersion` and the OpenAPI document).
- `src/core/roster.ts` `agentFront(text)`: `if (f.invalid !== undefined) return { invalid: f.invalid };`
  first, else unchanged.

**Order.** Protocol first, then core.

**Blast radius.** Every caller of `parseAgentFile`: `agentsJsonEntry` (runs.ts; never reached for
an invalid file after AC-10), review rule checks (`rules` absent → no declared rules, as v0.1.20
behaved for `{}`), `scanAgents` and the hub catalog push (via `agentFront`).

**Risks.** The exact `yaml` message for `description: Validates: findings` must contain `line 2`;
the parser includes "at line N, column M" in its first line with `prettyErrors` (default). Verify by
running the AC-07 input once in a REPL while implementing.

## AC-08 Roster

**Files.** `src/hub/service.ts`, `src/protocol/roster.ts`, `src/cli/roster-commands.ts`
(`src/daemon/roster.ts` needs no change).

**Changes.**
- `src/daemon/roster.ts` `scanAgents` already spreads `agentFront(text)` and never skips on front
  matter; the report now carries `invalid`.
- `src/protocol/roster.ts`: `AgentGroup.invalid: boolean`.
- `src/hub/service.ts` (agents view, ~lines 4040–4105): the two `front` literals that copy
  `description/model/tools/rules` field by field also copy `invalid` when defined (repo rows and
  current catalog defs). Group: `invalid: versions.some((v) => v.invalid !== undefined)`.
  `pushCatalog` already stores `agentFront(d.text)`; `resolveAgent` returns `CatalogDefView` with
  `...v.front`, so `invalid` reaches `GET /v1/agents/resolve`.
- `src/cli/roster-commands.ts`: `FLAGS` becomes `["diverged", "pinned", "behind", "modified", "invalid"]`.
  Version line: `v.invalid !== undefined ? `  ${hash12}  invalid: ${v.invalid}` : `  ${hash12}  ${v.description ?? "-"}``.

**Order.** After AC-07.

**Risks.** `replaceAgentReports` compares stored vs next JSON; the new field makes the first report
after upgrade rewrite the rows (intended, Compatibility).

## AC-09 Web Roster

**Files.** `web/src/roster.tsx`, `web/src/styles.css`.

**Changes.**
- `roster.tsx`: `FLAGS` gains `"invalid"` (the group header renders a `.roster-flag` per true flag,
  text = flag name). `Version`: when `v.invalid !== undefined` render
  `<span className="roster-invalid">invalid: {v.invalid}</span>` in place of the description.
- `styles.css`: `.roster .roster-invalid` (warning colour from the existing tokens).

**Order.** After AC-08 (types).

## AC-10 Fail fast

**Files.** `src/daemon/runs.ts`.

**Changes.** In `start()`, after the agent text is read and before `agents.json` is written:
- roster key branch: after the hash check, `const bad = parseAgentFile(text).invalid; if (bad) return this.notStarted(next, `roster agent ${def.key} has invalid front matter: ${bad}`);`
  Also move `writeFileAtomic(agent.md)` after the check, or keep it (spec only forbids
  `agents.json`); keep `agent.md` after the check for tidiness.
- repo agent branch: after `readFileSync`, `if (bad) return this.notStarted(next, `agent ${meta.agent} has invalid front matter: ${bad}`);`
- `finish()` already builds `headless run of <step> did not start: <reason>` from
  `meta.notStarted`, closes the step `fail`, removes the worktree and ends the run `finished`.

**Order.** After AC-07.

**Risks.** `notStarted` sets `endedAt` → `endRunSessions` (AC-05) is a no-op here.

## AC-11 redactSecrets

**Files.** `src/core/redact.ts`.

**Changes.** Only the assignment replacer:
1. Mark checks first (unchanged): value exactly a mark → return `m`; contains a mark → whole value
   redacted, not counted.
2. `if (sep.includes("=") || q !== "")` → RL-1 behaviour (redact, count).
3. Unquoted `:` form: `const tail = /[.,;:!?)\]}]+$/.exec(value)?.[0] ?? ""; const core = value.slice(0, value.length - tail.length);`
   token-like = `core.length >= 6 && !core.includes("://") && (/\d/.test(core) || core.length >= 20)`.
   Token-like → `count++`, return `${key}${sep}[REDACTED]${tail}`; else return `m`.
Update the doc comment.

**Risks.** The global regex resumes after an unchanged match, so a key inside a skipped value is not
re-scanned (same as RL-1 for redacted values).

## AC-12 mesh preset ls

**Files.** `src/cli/hub-commands.ts`.

**Changes.**
- New `repoPresetFiles(cwd): { name: string; file: string }[]`: walk from `resolve(cwd)` upward with
  the same stop rule as `findPresetSource` (stop after the first dir with `.git`, or at the root);
  in each dir list `<dir>/.mesh/presets/*.yaml` (files only, `readdirSync` in try/catch); first
  occurrence of a name wins (nearer dir). Sort by name with code-unit comparison.
- `presetCommand` `ls`: built-in lines unchanged; if no repo template, the existing hint line;
  else per template: `parsePreset(name, text)` in try/catch →
  `${name.padEnd(14)} ${p.description || "-"}  [${rel}]${builtin ? "  (replaces the built-in)" : ""}`
  or `${name.padEnd(14)} invalid: ${firstLine(errorMessage)}  [${rel}]` (the "replaces" suffix is
  not specified for an invalid file; omit it). `rel = relative(c.cwd, file).split(sep).join("/")`.
- Optionally refactor `findPresetSource` to share the walk helper; behaviour unchanged.

**Risks.** `parsePreset` now also validates `params` (AC-15); an invalid `params` shows as an
`invalid:` line, which is the documented rule.

## AC-13 Progress

**Files.** `src/cli/show.ts`, `web/src/goals.tsx`.

**Changes.**
- `show.ts` `renderGoal`: `done = visible.filter((s) => s.state === "done" || s.state === "skipped").length`.
- `goals.tsx` line ~731: same predicate in the header count.
- `LiveView` and trail/ledger counts untouched (spec Out).

**Risks.** The existing `show.test.ts` snapshot has no skipped step, so it stays unchanged.

## AC-14 mesh_done reply

**Files.** `src/daemon/tools.ts`, `src/daemon/daemon.ts`, `src/daemon/trail.ts` (comment only).

**Changes.**
- `ToolHost` gains `isRunSession?(sid: string): boolean`; `daemon.ts` maps it to
  `this.runs?.isRunSession(sid) ?? false`.
- `mesh_done` online: compute
  `const headless = host.isRunSession?.(s.sid) === true || host.runOf?.(s.sid) !== undefined || r.step.policy?.mode === "headless";`
  (before `clearStep`). When headless: written → `mesh wrote the step record <paths>.` /
  `mesh wrote the step record and goal file <paths>.` (no `commitHint`); not written → omit the
  `Step record (save as …)` block.
- `doneOffline`: `headless = isRunSession || runOf || cached?.ctx.step.policy?.mode === "headless"`;
  when headless, the text is
  `The hub is offline: mesh recorded <id> as <state> locally and wrote the step record <path>. The hub gets it when it is back (facts from other people's sessions are added then).`
  (no hint). The no-cache branch already has no commit hint.
- `trail.ts`: `commitHint` unchanged; the file header comment notes headless runs get no hint.
- Trail files are still written.

**Risks.** The `mesh_plan` reply (also uses `commitHint`) is out of scope and unchanged.

## AC-15 Preset params

**Files.** `src/core/presets.ts`, `src/hub/service.ts` (no logic change expected).

**Changes.**
- `Preset.params?: Record<string, string>`.
- `PresetStep`: override `budget` with
  `z.object({ turns: z.union([int 1..500, placeholder]).optional(), minutes: z.union([int 1..1440, placeholder]).optional(), usd: … }).strict()`
  where placeholder = `z.string().regex(/^\{[a-z][a-z0-9_]*\}$/)`. The `s()` helper takes and
  returns `PresetStep` so the built-in can hold string budgets.
- `parsePreset`: read `doc.params`; when present it must be a plain object whose keys match
  `^[a-z][a-z0-9_]{0,39}$` and whose values are strings or finite numbers (numbers → `String(n)`);
  otherwise `throw new Error("params must map names (a-z, 0-9, _) to values")`. Result includes
  `params` only when present. The hub's `presetChecks` already prefixes `preset <name>: ` once.
- `presetText`: `stringify({ preset, description, ...(params && keys ? { params } : {}), steps })`.
- `instantiate`: `vars = { ...p.params, ...opts.params, repo, goal }`. After `fill`, for each step
  with `budget`, for `turns` (max 500) and `minutes` (max 1440): if a string still matching
  `\{x\}` → `preset <name>: unknown parameter {x} in step <id>`; else string must match `^\d+$`
  and be in range → `Number`; else
  `preset <name>: budget.<field> in step <id> must be a whole number from 1 to <max>, got "<value>"`.
  Runs before `PlanInput.parse`.
- `AUDIT_RELAY`: `params: { turns: "80", minutes: "60" }`; `audit` budget
  `{ turns: "{turns}", minutes: "{minutes}" }`.
- Hub `pulse add` path (`presetChecks` → `instantiate`) and `fire` (`instantiate(parsePreset(...))`)
  need no change; the `params` they pass override the defaults.

**Order.** Before AC-12 (`preset ls` parses templates) and before regenerating the howto sha.

**Blast radius.** `audit-relay` text and sha256 change; old pulse snapshots keep their numeric
budget. A v0.1.20 hub rejects the new snapshot (Compatibility note).

**Risks.** `yaml.stringify` quotes `"{turns}"` and `"80"`, so the round trip keeps strings; confirm
`parsePreset(p.name, presetText(p))` deep-equals `p` for every built-in (no `params` key on the
others).

## AC-16 Docs

**Files.** `docs/guide/concepts.md`, `docs/guide/howto.md`, `src/protocol/skill.ts`,
`skills/mesh/SKILL.md`, `docs/plan/implementation-plan.md`, `docs/specs/RL-1.md`.

**Changes.** Exactly the Docs table:
- concepts: Headless step (daemon-side registration by `--session-id` and pid, hooks optional and
  harmless, bind on first tool call, session ends with the run, the four removed variables, invalid
  front matter fails at start with the summary text); Redaction (`:` rule); Built-in `audit-relay`
  params; Roster `invalid`; Presets `params:` and budget placeholders.
- howto: a `mesh preset ls` sample with a repo template line; the `audit-relay` pulse example with
  `turns=…,minutes=…`; the shown preset sha (`4c43bb0f30b3` today) replaced by the first 12 hex of
  sha256 of the new `presetText(audit-relay)` (compute after AC-15).
- `MESH_SKILL` "Headless runs" section: the step record mesh writes is not committed in a headless
  run (the worktree is discarded). Then regenerate/copy into `skills/mesh/SKILL.md` so both are
  byte-equal.
- implementation-plan API table row `GET /v1/agents?name=`: append
  `(v0.1.21: versions carry \`invalid\` when the front matter is not valid YAML)`.
- RL-1 `redactSecrets` paragraph: the new assignment rule with `(changed in RL-7)`.
- No team-, company- or person-specific names.

## AC-18 Catalog re-push refreshes front matter

**Files.** `src/store/hub-store.ts`.

**Changes.** `putCatalogDefs`, the existing-row branch:
`const value: CatalogDefValue = { ...v, path: d.path, commits, pushedAt: now, front: d.front };`.
Same SQL for SQLite and Postgres (JSON value column), so the contract holds on both legs.

**Risks.** The daemon pushes a source only when the commit advanced and the digest differs; a
re-push of an identical text happens when other files changed. The store change is what the
criterion tests. No schema change.

## AC-17 Version, checks, schemas

**Files.** `package.json`, `schemas/hub-api.openapi.json`.

**Changes.** Version `0.1.21`. Run `pnpm schemas` after AC-07 so the agent report schema has
`invalid`. Run `pnpm check` (lint, typecheck, boundaries, test, build) and `pnpm test:web` after
`pnpm build`. Postgres legs of the store contract run only with `MESH_TEST_PG_URL` (CI).

---

## Existing tests and snapshots the developer may adjust

Only where the spec changes the asserted behaviour:

| File | Assertion | Why |
|---|---|---|
| `src/core/redact.test.ts:56` | `redact("token: abcdef").count` is 1 | Now unchanged, count 0 (AC-11 table). |
| `test/schemas.test.ts:685` | `package.json` version `0.1.20` | Now `0.1.21` (AC-17). |
| `schemas/hub-api.openapi.json` | generated document | Regenerated with `pnpm schemas` (`invalid` in `AgentFront`-derived schemas). |
| `test/pulse-cli.test.ts` (AC-19 / RL-6 AC-03 `preset ls`) | built-in lines | Only if the test checkout holds `.mesh/presets/*.yaml` (then the hint line is replaced by template lines). Expected: no change. |

Expected to stay green without change: `src/cli/__snapshots__/show.test.ts.snap` (no skipped
steps), `src/core/presets.test.ts:123` and `test/programme.test.ts` (budget still `{80, 60}` as
numbers), `src/core/policy.test.ts:167` (round trip), `test/helpers/pulse-kit.ts` `RELAY_TEXT`
(computed). RL-1 World tests that register a run's session through a hook keep passing by rule 2;
if one asserts the session list or `liveCount` before any hook (none found in
`test/relay-daemon.test.ts`, `test/relay-hub.test.ts`, `test/pulse-daemon.test.ts`), it may be
adjusted to rule 1 and the change named in the developer's report.

## Open points for the developer (no spec change)

- `endedReason` text for a run's session ended by rule 4 is not specified; use
  `"headless run ended"`.
- A front matter block whose YAML is `~`/`null` is treated like an empty block (valid, `{}`), the
  conservative reading of the spec's "null from an empty block is not invalid".
- An invalid repo template that shares a built-in name: the spec gives the `invalid:` line format
  without the `(replaces the built-in)` suffix; print it without.
