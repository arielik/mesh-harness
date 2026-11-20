Verdict: APPROVED | Round: 3 | Blocking-open: 0

# RL-13 review, round 3 (spec revision 3, dd04adb)

Checked against: src/daemon/{tools,daemon,runs,hub-link,git}.ts, src/hub/{service,app}.ts.

## Earlier findings

| # | Status | Reason |
|---|--------|--------|
| B1 (r1) | RESOLVED | The check now compares the repo of the checkout actually read (`repoForCwd(root)`) with the step's repo (spec 81-86); `s.repo` is explicitly not used. AC-02 covers the moved cwd. |
| S7 (r1) | RESOLVED | AC-08 now names the schema refusal and the generated documents (spec 202-204). |
| N1 | RESOLVED | New optional `ToolHost.repoForCwd` wired to `deps.repoForCwd` (spec 83-84). The daemon already has `deps.repoForCwd` (daemon.ts:108, 174) and World stubs it, so AC-02 is testable with `git init` checkouts. The `ToolHost` literal at daemon.ts:1082-1104 is where it goes. |
| N2 | RESOLVED | On a cache miss the daemon reads the step's context from the hub (spec 86-89); AC-01 covers the autopilot-chain case. See R1 for the failure path. |
| N3 | RESOLVED | Run sessions send no commit from `mesh_done` (spec 78-80); AC-05 first sentence. Detection verified (R2). An explicit `args.commit` still goes first (rule 1) and is replaced by the report (spec 121-122), which is what N3 asked to state. |
| N4 | RESOLVED | `push()` returns the commit it pushed; no second read (spec 118-119). Minor wording mismatch, R3. |
| N5 | RESOLVED | AC-08 rewritten. |
| N6 | RESOLVED | `branch` used as given; `@{-1}` / `origin/x` end in no commit (spec 91-94). |
| N7 | RESOLVED | AC-05 reads "a run without commits (done or close-as-fail)"; spec 123-124 states the close-as-fail push case. |

## New findings (all non-blocking)

### R1. Say that any failure of the cache-miss read means no commit and `mesh_done` goes on

Spec 86-89 says to read the context "as `mesh_context` does" and covers only "offline with no cache".
`contextOf` (tools.ts:218-227) rethrows every non-503 error, and on 503 without a cache it rethrows too;
`runTool` turns a `HubRpcError` into a failed tool (tools.ts:195-203). Reusing `contextOf` as it is
would therefore make `mesh_done` fail, sending no `done`, when the context read fails but `done`
would have succeeded. One example is a 5xx from `context()` while it builds inputs (service.ts:2600).
Add: "any failure of that read (offline, an HTTP error, a timeout) means no commit; the `done` is sent
as before."

Verified as harmless otherwise:
- Hub side: `context()` is read-only (service.ts:2580-2603: a `tx` with reads only, no `emit`, no
  writes in `stepInputs`). The route (app.ts:377-382) records nothing.
- Daemon side: `contextOf` writes `step_cache` (tools.ts:221). That only adds the record that
  `doneOffline` (tools.ts:625-630) and the `isHeadlessCall` mode check use, so a later offline path
  gets more information, never different behaviour.
- Latency: an unreachable hub costs one timeout on the GET, then the link is offline
  (hub-link.ts:244-254) and the `done` POST fails at once and is queued. That is the same single
  timeout as today.
- Optional: `GET /v1/steps/:id` or `context` without `agent=1` would do, since only `step.repo` is
  needed. `agent=1` builds the full agent brief.

### R2. Run-session detection at `mesh_done` time works with existing host methods

`host.isRunSession` (daemon.ts:1102 → runs.ts:247-253) and `host.runOf` (daemon.ts:1100 →
runs.ts:431-441) both require `run.state === "running"`. That holds while the run's process calls
`mesh_done`, because the end sequence that sets `finished` runs after the process exits. A restarted
daemon re-adopts live runs as running (runs.ts:189-211). A call bound by pid to the run's session
(daemon.ts ~1110, RL-7) gets a session in `runSids`. The check must run before the POST, unlike
`isHeadlessCall` today (tools.ts:359), and both methods are available then. The spec's rule leaves
out `isHeadlessCall`'s `mode === "headless"` arm (tools.ts:94-96). That is right, because an
interactive session holding a headless-policy step has a real checkout. It could say so in one clause.

### R3. Result-commit bullet vs `push()` wording

Spec 111-112 gives the value as `git rev-parse --verify -q HEAD^{commit}`. Spec 118 says it is the head
`push()` read, which is `rev-parse HEAD` (runs.ts:931). Drop the command from the bullet, or have
`push()` use it. Also unstated, and acceptable either way: an end record written by a 0.1.31 daemon
with `pushDone` and `branch` but no saved commit (the daemon was upgraded between push and report)
falls to `baseCommit` under the rules as written.
