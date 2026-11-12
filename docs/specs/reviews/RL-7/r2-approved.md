Verdict: APPROVED | Round: 2 | Blocking-open: 0

# Review of the RL-7 spec, round 2

This is a cold review of `docs/specs/RL-7.md` at commit 9a815c1 ("spec revised for review round 1").
I read round 1 (`r1-changes-requested.md`) first. Then I checked the spec against the design
`docs/analysis/2026-11-12-pulse-relay-roster.md`, the CLI spike
`docs/analysis/2026-11-12-claude-cli-spike.md` (2c, 4c, "Other flags") and the code on
`feat/relay-design`.

## Checks

Not run:
- `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm build`, `pnpm check`,
  `pnpm test:web` and `pnpm schemas`. This round reviews a spec, and nothing is implemented yet.
- The Postgres legs of the `HubStore` contract. `MESH_TEST_PG_URL` is unset here, and CI runs them.
  AC-18 has a SQLite leg and a Postgres leg. I judged the store change on `putCatalogDefs` in
  `src/store/hub-store.ts`, which is one code path for both dialects.

I read the code but ran nothing. I read `tools.ts` (`mesh_done`, `doneOffline`), `daemon.ts`
(`callTool`, `applyEvent` bind, `observe`, `liveCount`, `start`), `runs.ts` (`load`, `runSids`,
`isRunSession`, `runningWithoutSession`, `notStarted`, `start`), `session-state.ts` (`applyTick`,
`applyObservation`), `hub-store.ts` (`putCatalogDefs`), `service.ts` (`runReport`, `pushCatalog`,
`presetChecks`, the headless pause rule), `redact.ts` and its tests, `presets.ts`, `show.ts`,
`web/src/goals.tsx` and `web/src/roster.tsx`.

## Round 1 findings

| R1 | Status | Evidence |
|---|---|---|
| B1 registered session fields / false stall | Fixed | Rule 1 sets `working`, `kind: "print"`, `repo`, and exempts run sessions from stall and presumed end. Only `idle` sessions stall (`applyTick`, `session-state.ts:438`), and `presumedEndAfterMs` (6 h) is less than the largest budget (1440 min), so the exemption is needed. AC-01 now ticks past `stallAfterMs` and checks the attention list. |
| B2 rebind after done | Fixed | "Done accepted" term. Rule 3 bullets 2 and 3 require no done accepted. Offline done is included, which is right because `doneOffline` also clears the step (`tools.ts:532`). AC-20 checks this. |
| B3 stale catalog `front` | Fixed | `putCatalogDefs` refreshes `front` for a known `(repo, name, hash)`. The Open question states why read-time parsing was not chosen (`src/store` may not import `src/core`). AC-18 has a store contract leg. |
| B4 redaction lets symbol passwords through | Fixed | Token-like is now: 6 or more characters, no `://`, and a digit or 20 or more characters. I traced every row of the examples table through the current `ASSIGNMENT` regex, and each row follows from the rule (`hunter2.` → `R.`; `P@ssw0rd1`, `S3cr3t#42` → `R`; `hardcoded` and `correcthorse` unchanged; the `ghp_` row is a whole mark). The only existing test the change breaks is `token: abcdef` (`redact.test.ts:56`), and Compatibility names it. |
| B5 reap at restart | Fixed | Rule 4 names the reap in `load()`. `Daemon.start` loads sessions before `runs.load()` (`daemon.ts:494-496`), so ending them there can work. Queued runs survive a restart (`load()` queues them again). AC-19 checks this. |
| S1–S7 | Fixed / accepted | S1: AC-04(b) uses a fresh World. S2: the Terms define "the run's sessions" and rule 4 ends all of them. S3: moved to Open questions (the 300-character cut is not driven by an AC), which I accept. S4: the prefix is added once, and this matches `presetChecks` (`service.ts:3013`). S5: Compatibility says to upgrade the hub first. S6: the predicate is named. S7: `p.requests` is the only measure. |

No finding is a REPEAT. No repair caused a regression.

## Blockers

None.

## Suggestions (not blocking, all NEW)

- **S1 (NEW): "done accepted" also covers a rejected answer.** The Terms say "the hub answered it".
  The hub can answer `mesh_done` with `rejected` (`tools.ts:298`). The session then still holds the
  step, so the wording does no harm in the normal case. But suppose a `SessionEnd` hook then ends
  the session and the agent calls a tool. Read literally, "answered" forbids the rebind, and the run
  can no longer finish. Write instead: "the hub answered it without `rejected`, or it was queued
  offline".
- **S2 (NEW): where "done accepted" is kept.** The Open question leaves this to the implementation.
  If the daemon keeps it only in memory, it is lost when the daemon restarts between `mesh_done` and
  the run's exit. The run is then adopted, a later tool call matches rule 3 bullet 2 again, and the
  daemon binds the closed step locally. Rule 1 says "holds the step locally whatever the hub answers".
  Say that it is kept in the run's meta file, which `runs.ts` already persists (`meta(run).sids`).
- **S3 (NEW): the World leg of AC-18 cannot catch the refresh.** With the new code, the first push
  already stores `invalid`, so "after the second push … returns `invalid`" passes even if
  `putCatalogDefs` never refreshes `front`. The store contract leg is the real check, and it can
  fail, so the AC as a whole still has teeth. Either drop the World leg (AC-08 already covers
  `resolve` returning `invalid`) or label it a smoke check.
- **S4 (NEW): two sessions can carry the run's Claude session id.** Rule 3 bullet 2 adds it to a
  second session, as in AC-04(b). Rule 1's lookup ("If a session for that Claude session id already
  exists") and hook matching by `session_id` (`bind()`) can then find either session. Say which one
  wins: the live one, and among live sessions the one that holds the run's step.
- **S5 (NEW): AC-12 does not name the content of `broken.yaml`.** "invalid: <first line>" depends on
  how the file is broken. A zod failure from `parsePreset` gives a multi-line JSON message whose first
  line is `[`, while a YAML syntax error gives a readable line. Name the content (for example a YAML
  syntax error) or the exact expected line, so a blind test-writer does not have to guess.
- **S6 (NEW): commit hints outside `mesh_done`.** `mesh_propose_plan` also appends `commitHint`
  (`tools.ts:408`). Problem 7 and the section cover only `mesh_done`, so this is not scope creep. But
  the sentence "the reply to a headless call never contains `git add` or `commit`" reads as general.
  Write "the `mesh_done` reply to a headless call …", or list `mesh_propose_plan` under Out.

## Checked and fine

- Rule 1's hub bind matches today's hook path: the key `bind:<sid>:<step>` (`daemon.ts:1247`), and
  the in-memory `boundSteps` gives "once per `(sid, step)`". A headless step is already `claimed` at
  accept, so a `sid` claim before or after `run {state: "started"}` is valid (`runReport`,
  `service.ts:806`).
- A revived run session after `SessionEnd` (AC-04(a)) needs no new claim. The hub does not pause a
  headless step whose holder session ended (`service.ts:4168`), so `holderSid` stays.
- `liveCount()` counts live sessions plus `runningWithoutSession()`. A registered session therefore
  replaces the "not seen yet" count rather than adding to it, and ending it under rule 4 frees the
  slot (AC-05, AC-19).
- The environment contract fits the waiter (`env: { ...process.env, ...spec.env }`,
  `src/claude/headless.ts:54`). Applying `unsetEnv` last makes "spec.env cannot re-add" testable
  (AC-06).
- The not-started texts reuse the RL-1 path (`notStarted`, `runs.ts:432`, summary at `runs.ts:674`).
  The roster-agent check sits before `agents.json` is written, as the spec requires.
- The preset budget ranges match `StepBudget` (turns 1–500, minutes 1–1440). Merging defaults as
  `{...p.params, ...opts.params, repo, goal}` keeps today's `repo`/`goal` precedence.
- The progress text change touches only `renderGoal` (`show.ts:24`) and the goal header
  (`goals.tsx:731`), as listed.
- No new hub route, so the OpenAPI route table is unchanged. AC-17 covers the regenerated
  `AgentReport` schema. There is no migration and `SCHEMA_VERSION` is unchanged.
- Privacy: `invalid` uses only the first line of the parser message, capped at 300 characters, and
  travels only in agent reports that are already sent under `shareSessions` `me`/`all`.
- Scope: everything in the spec traces to the eight defects of the smoke test or to design F16
  (`{param}`), which round 1 accepted.
- No team-, company- or person-specific names.
