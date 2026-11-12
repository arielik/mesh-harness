Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 7

# Review of spec RL-1, round 1

I reviewed `docs/specs/RL-1.md` (revision 1) cold, as of commit f76cc55. I checked it against
`docs/analysis/2026-11-12-pulse-relay-roster.md` (§2, §4, §5.1, §5.2, §5.9, §6, §7, §9 S1, §10), against
`docs/analysis/2026-11-12-claude-cli-spike.md` (which wins where they differ), and against the code
on `feat/relay-design`:
- `src/protocol/{goal,hub,hub-api,tools}.ts`
- `src/core/{presets,policy,claims}.ts`
- `src/hub/{app,service,config}.ts`
- `src/store/hub-store.ts`
- `src/daemon/{daemon,hub-link,tools}.ts`, `src/mcp/shim.ts`
- `test/helpers/world.ts`

There is no earlier RL-1 round, so every finding is NEW. None is a REPEAT or a
REGRESSION-OF-OWN-REPAIR.

## Checks

This is a spec review, so there is no code to build. I did not run any of these: `pnpm lint`,
`pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm build` (together `pnpm check`), or
`pnpm schemas`. I used only `git`, `grep`, `sed`, `cat` and file reads. I did not run the `claude`
binary.

## What already matches the code

- **Spike precedence.** The argv follows spike §4: `--verbose`, `--session-id`, `--setting-sources user`,
  `--strict-mcp-config` with mesh only, `--permission-mode default`, and `--max-turns` set to
  turns + 1. Repo agents go through `--agents <file> --agent` (6b), and mesh tools are added to an
  agent's `tools` (6c). Profiles list the mesh tools one by one and never use `mcp__mesh` (5b).
  Telemetry counts turns by distinct `message.id` (1c), treats exit 1 with a `result` as ended
  (2a), and kills the whole process group (2c). `--bg` and `--model` are left out.
- **Hub accept without a session.** `acceptStep(actor, id, undefined)` → `claimInTx` → `claim()`
  records `holderMachine` and no `holderSid`. The run session's SessionStart hook then rebinds the
  hold (`applyEvent` → `POST /claim {sid}`, key `bind:<sid>:<step>`), and `claim()` lets the same
  holder do that. So the hub-side flow works with today's code.
- **Tick.** `tick()` pauses on `ended || offline` and reads `holderMachine`. The exemption fits in
  there.
- **Stores.** Migration 8 is listed for both `HUB_MIGRATIONS` and `HUB_MIGRATIONS_PG`.
  `SCHEMA_VERSION = HUB_MIGRATIONS.length`. `machine.extra` already holds `accept`/`labels` under a
  row lock, so `headless` fits there. AC-08 runs the contract test on both dialects.
- **Route table.** All seven routes go in `HUB_API` with a rule and a scope. AC-34 holds them to
  `test/schemas.test.ts` and `pnpm schemas`. `member` with no scope refuses service tokens, which is
  what AC-06 needs.
- **Offer idempotency.** The headless offer path reuses `Idempotency-Key: offer-<message id>` and the
  `offersHandled` bookkeeping.
- **Privacy of content.** No event payload and no ledger export carries artifact content (AC-11).
  Redaction runs on the machine with the daemon key and the hub token as literals. That covers spike
  §2's note about hook commands that embed the key.

## Blockers

### B1 (NEW): preset placeholders in `agent` and `profile` are rejected before `instantiate` runs
`parsePreset` (src/core/presets.ts) validates a repo preset with `PlanInput.parse`. With the new
fields, `agent: "{agent}"` fails the agent regex `^[A-Za-z0-9]…` and `profile: "{profile}"` fails
`ProfileName`. So a repo preset that uses those placeholders throws a ZodError in `findPreset`,
before `--params` ever applies. AC-04 (`mesh goal plan … --preset p --params agent=auditor` sends
`agent: "auditor"`) cannot pass as specified, and AC-03 only works on a hand-built `Preset` object.
This is a contract gap: the spec needs a decision here, and as written it is wrong.
**Fix:** say how presets are validated. Two options:
- `parsePreset` checks the raw steps with a relaxed schema (string fields may contain
  `{param}`), and `instantiate` does the full `PlanInput.parse` after substitution, as it already
  does today;
- or validation of `agent`/`profile` waits until after substitution.

Then add the case to AC-03/AC-04: a YAML preset text with `agent: "{agent}"` parses, and it
instantiates to `auditor`.

### B2 (NEW): `run.started` takes `profile`/`profileHash` from a snapshot the hub never stores
The `POST /v1/steps/:id/run` row says the `run.started` payload takes `profile` and `profileHash`
"from the step's offer snapshot". `StepOffer` (src/protocol/goal.ts) has no profile field, and no
Types row adds one. The snapshot lives only in the inbox message `data`. As written, the payload
has no defined source, and AC-31 asserts it.
**Fix:** pick one of these:
- `RunReport` gains `profile`/`profileHash` for `started` (from the run file);
- or `StepOffer` gains `profile: {name, sha256}`, stored when the offer is made. That also gives
  R-6 a hub-side record of what the run was allowed to do.

### B3 (NEW): close-as-fail ignores a `mesh_done` the daemon queued while the hub was offline
`mesh_done` with the hub offline is queued locally (`doneOffline`, src/daemon/tools.ts), and the
agent is told it was recorded. The `-p` process then exits. End of a run, step 2, is "retried on
later reconcile ticks". When the hub comes back, the retry's `GET /v1/steps/:id` can run before the
queue flush. It still sees `claimed`, uploads a transcript and posts `done {outcome: "fail"}`. The
queued `mesh_done` then replays and gets 409 (`… is failed; claim it first`). A run that did finish
is recorded as failed, and its real round is lost.
**Fix:** before step 2, flush the local call queue, or skip close-as-fail when the queue holds a
`mesh_done` for this step from the run's session. Add an AC: hub offline during the run's
`mesh_done`, back before the end-of-run handling → the step ends `done` with one round and no
transcript.

### B4 (NEW): adopting by `alive(pid)` alone can kill an unrelated process group after a reboot
On restart, a `running` run file with `alive(pid)` true is adopted. If its budget has passed, it is
"killed now" with `kill(-pid)`, then SIGKILL. After a machine reboot, or after a long downtime, the
stored pid can belong to an unrelated process-group leader. A shell, an editor or a service is
likely, because pids restart low. The daemon would then SIGTERM/SIGKILL that group. The `exit` file
does not protect against this either: after a reboot the waiter never wrote it.
**Fix:** record an identity next to the pid (for example the process start time, from
`ps -o lstart= -p <pid>`, or the boot id plus start time), and define `alive(pid, startedAt)` as
"exists and has that start time". Also define "`<runDir>/exit` exists ⇒ ended", whatever `alive`
says. Add an AC: a `running` run file whose pid is a live unrelated process → reaped as crashed,
and that process survives.

### B5 (NEW): retried end-of-run and run-report calls carry no idempotency key
The spec makes the daemon retry steps 2–4 (transcript upload, done, push note,
`run finished`) and the `run started` report, but it names no `Idempotency-Key`. With
`hub-link.rpc`, a lost reply after the hub committed looks like "offline". The next tick's
`GET` can still show the step held (upload committed, `done` not yet sent), so a second
transcript is stored, or the `perRound` cap is used up. A repeated `run.started`/`run.finished`
doubles the events that S6's stats will count. `mesh_artifact` has the same gap: the spec does not
say the daemon forwards the shim's per-call `key`, which the other tools do.
**Fix:** name the keys. For example `run-<runId>-started`, `run-<runId>-transcript`,
`run-<runId>-done`, `run-<runId>-note`, `run-<runId>-finished`, plus the shim key on
`/v1/steps/:id/artifacts` from `mesh_artifact`. Add an AC: replaying the end-of-run calls with the
same keys stores one transcript, one failing round and one `run.finished`.

### B6 (NEW): `inputs` ignores the `blind` and `reads` rules
The context row serves, for a local id `x`, "every artifact of the last round of step
`<goal>.<x>`", and for `artifacts`, the artifacts of every dependency. Today `agentContext`
(src/core/policy.ts) hides a blind partner's and an unread dependency's summary from the agent on
purpose. With this spec:
- a step with `blind: ["develop"]` and `inputs: ["develop"]` is served develop's reports;
- a step with `reads: ["a"]` and `inputs: ["artifacts"]` is served the artifacts of every
  dependency.

That breaks an existing privacy rule of the harness.
**Fix:**
- `validatePolicies` rejects `inputs` naming a blind partner (`step "<id>": inputs names "<x>",
  which it is blind to`);
- the context route leaves out artifacts of blind partners and, under `reads`, of unread
  dependencies, for both the local-id and the `artifacts` forms;
- extend AC-02/AC-32 with both cases.

### B7 (NEW): close-as-fail does not check that the run still holds the step, and retries 4xx forever
Step 2 closes the step whenever it is "still `claimed` or `paused`". The spec also keeps interactive
claims of a headless step allowed (Open questions). Here is how that goes wrong:
1. The laptop sleeps, and `tick()` pauses the step as machine-offline.
2. The same person re-claims it from a session on another machine (`claim()` lets the holder
   rebind).
3. The laptop wakes, and the dead run is reaped. The daemon uploads a transcript into the person's
   round and fails the step under them.

If another user took the step over, the calls return 403. Steps 2–4 are "retried … until they
succeed", so the run stays `running` with `endedAt` set, forever.
**Fix:**
- close-as-fail only when `holderMachine` is this machine and `holderSid` is absent or is the
  run's session;
- otherwise skip steps 2 and 3, report `finished` without a round, and end the run;
- retry only on offline errors or 5xx, and treat any other 4xx as final, with a log line;
- add an AC for the re-claimed case.

## Suggestions

### S1 (NEW): name `policyOf` in the contract
`policyOf` (src/core/policy.ts) copies policy fields into `step.policy` through a hard-coded key
list. The Types row says `PlanStep` gains the fields "through `StepPolicy.shape`". If `policyOf`
is not extended, `mode`, `agent`, `profile`, `budget` and `inputs` are dropped from stored steps.
Add `policyOf` to the Core contract, so the developer does not learn it from AC-20 failures.

### S2 (NEW): `inputs` keywords collide with valid step ids
`previous`, `dispositions` and `artifacts` all match `localId`, so a plan step called `artifacts`
can never be named in `inputs`, and the parse is ambiguous. Either reserve the three words as step
ids (a `validatePolicies` error), or state that the keyword always wins.

### S3 (NEW): say how the budget and end checks are driven
The spec says "`budget.minutes` after `startedAt`, `headless.kill(pid)`" and "the budget timer
re-armed". World runs the daemon with `reconcileMs: 0` and a fake clock, and AC-27 is
"World (clock)". A real `setTimeout` never fires there. State that the budget check runs in
`reconcile()` against `deps.now()` (kill within one reconcile after the deadline), the same way
end-of-run detection works.

Also state that `Daemon.stop()` never kills runs. AC-29(a) depends on it.

### S4 (NEW): say whether messages reach a headless run's session
The user-level Stop hook delivers pending messages with `stopReply` (src/daemon/daemon.ts). In
`-p` that makes the unattended agent continue with a teammate's text (`mesh say`, a replan notice)
as input. That is an instruction channel that bypasses `mesh_context` fencing (design §7), and it
can also extend a run. The conservative reading: never deliver inbox messages to a session bound to
a running headless run, and no nudges or escalation for it. Add this to the Daemon section and to
Open questions.

### S5 (NEW): part of AC-30 cannot fail
`doneStep` already accepts a done on a `paused` step from its `holderUser`, for every step. So "a
late `mesh_done` … → 200" passes today, and the `POST /v1/steps/:id/done` row describes no change.
Mark that part as a regression guard, or drop it. The rest of AC-30 can fail.

### S6 (NEW): record what goes beyond the S1 row and design §6
The S1 row and §6 do not list these:
- `inputs` served through `mesh_context`, with fenced brief rendering (AC-32);
- `mesh artifact ls`;
- the route `POST /v1/steps/:id/run`;
- `GET /local/runs`.

Each has a good reason: telemetry has to reach the hub somehow, and tests need to find runs.
Write those reasons into Open questions with the date, so the next reader does not take them for
scope creep. `budget.usd` already cites spike 2b, which is enough.

### S7 (NEW): `processRunner` exit file under a group kill
`kill(pid)` signals the whole group and SIGKILLs it after 5 s. Even so, `<runDir>/exit` must hold
143 or 137, and must also be written after the daemon has exited (AC-18). So the waiter that writes
it cannot be in the killed group. Name the mechanism: for example, a small detached waiter outside
the group that starts `claude` with `setsid` and writes the code when it ends. Otherwise an
implementer can pass AC-18's normal-exit case and fail its kill case without knowing why.

### S8 (NEW): document that user-level allows widen every profile
Spike 3b: `--settings` rules merge with the user's own `permissions.allow`. A profile cannot
narrow a user allow except with an explicit deny. The Docs row for `concepts.md` covers "cannot stop
reads" but not this. Add it, with the `--tools` remedy the spike names.

### S9 (NEW): limits on registered profiles
Any member may register a profile with `allow: ["Bash"]`, `Bash(*)` or `Bash(git push *)`. Through
an auto-accepting machine, it then runs unattended under another member's credentials. Design
§5.1 says `propose-via-branch` has no push rule, and that only the daemon pushes. Consider:
- `parseProfile` rejecting bare `Bash`, `Bash(*)` and any `git push` allow;
- and/or a daemon-side list of profiles (or bases) the machine runs.

At least record the risk in Open questions.

### S10 (NEW): stricter `{param}` handling changes existing repo presets
Today an unknown `{word}` in a repo preset's brief is left as text. Under the new rule it throws. A
brief that shows `{name}` or a JSON example (`{a}`) stops working. Say so under Compatibility, or
only treat `{x}` as a placeholder when `x` is `repo`, `goal` or a declared parameter.

### S11 (NEW): the run route leaves some cases unspecified
For `POST /v1/steps/:id/run`:
- `started` on a step that is not `claimed`/`paused` has no status (409?);
- `finished` without `round` is allowed by the schema, but the row does not say what it stores
  (only the event?).

B7's fix needs the second case defined.

## Summary

| Class | Blockers | Suggestions |
|---|---|---|
| NEW | 7 (B1–B7) | 11 (S1–S11) |
| REPEAT | 0 | 0 |
| REGRESSION-OF-OWN-REPAIR | 0 | 0 |

No hard repo rule is broken. No team-, company- or person-specific name appears in the spec. The
verdict is CHANGES REQUESTED, not BLOCKED.
