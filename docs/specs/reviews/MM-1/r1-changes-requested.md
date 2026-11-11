Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 2

# Review of spec MM-1, round 1

Reviewed cold: `docs/specs/MM-1.md` (commit 94b0cdb), checked against
`docs/analysis/2026-11-11-my-mesh-and-assign.md` (section MM-1, Safety) and the code on
`feat/my-mesh-assign`: `src/protocol/{config,hub,hub-api,session}.ts`, `src/hub/{app,service}.ts`,
`src/store/{hub-store,hub-copy}.ts`, `src/daemon/{hub-link,daemon,git}.ts`, `src/core/{roles,repo-id}.ts`,
`src/cli/{mesh-commands,context}.ts`, `src/cli/tui/{render,tui}.ts`, `.dependency-cruiser.cjs`,
`test/{schemas,share-sessions,m46-ops}.test.ts`, `test/helpers/world.ts`. No earlier rounds.

Scope: no creep found. Every interface in the spec traces to the design's MM-1 section or is
needed to deliver it (`GET /local/fleet` and `DaemonClient.fleet()` feed the TUI; `current` and
`reposAt` are small read-only fields). Labels, accept policy and offers stay out. Names are generic.

What already matches the code: `HubStore.SCHEMA_VERSION` is `HUB_MIGRATIONS.length` (5 today, so 6 is
right); `hub-copy.ts` copies columns by `PRAGMA table_info`, so new machine columns need no change
there as long as SQLite and Postgres use the same column names; the route rule `member` + scope
`live:read` and `member` without scope match `allowed()` in `src/core/roles.ts`; POST idempotency is
generic in `src/hub/app.ts` (only 2xx JSON replies are stored), so a replayed name request is safe;
`m-` + 8 hex matches `service.ts:226`; the 409 text of `/local/fleet` matches `/local/goals`;
`machine.named` through `emit` publishes the SSE `changed` hint; key `m` is free in the TUI;
`renderFleet`/`sessionVisible` in `src/core` respect the boundaries (core may import only protocol,
so the TUI's `age()` in `src/cli/tui/render.ts` cannot be imported; reimplement or move it).

## Blockers

### B1 (NEW) A `me` daemon talking to an older hub shows private sessions to the whole team

Rule broken: the design's Safety section and the spec's own rule ("a session without a step is
shown only to its owner"). Decision wrong.

`SyncRequest` is a plain `z.object` (strip mode): a v0.1.8 hub, or a v0.1.8 replica during a rolling
upgrade on Postgres, silently drops `machine`, stores the metadata-only sessions the daemon sends
under `me`, and its `/v1/live` (`service.ts` `live()`, no filter today) lists them to every member and
every `live:read` service token. With `me` the default for new setups, a person who installs v0.1.9
against a hub not yet upgraded gets exactly the `all` behaviour they did not choose. The spec only
discusses the other direction (old daemon, new hub).

Fix in the contract: the hub confirms that it applies the visibility rule, and the daemon sends
no-step records under `me` only after that confirmation. For example `POST /v1/sync` answers
`{ accepted, share: <stored level> }`; `syncedSessions` gets the level the hub last confirmed
(`steps` until a reply carries `share`), so a hub without the field gets only step holders, and the
daemon logs once `the hub does not support share level me; sending step holders only`. Add an
acceptance criterion on the daemon (fake fetch answering `{accepted: 0}` without `share`: no no-step
session is ever sent) and a line in the install guide: upgrade every hub replica before daemons.

### B2 (NEW) The inventory is never re-sent to a new hub or machine within one daemon process

Decision wrong. "`machine.repos` is carried on the first successful sync of the daemon process and
afterwards only when the inventory differs from the last one the hub accepted." `HubLink.credentials()`
re-reads `credentials.json` and switches hubs at run time (`mesh logout` / `mesh login` to another hub,
Solo to team). After such a switch the new hub's machine row has `repos: []` and no `reposAt` until a
checkout appears or disappears or the daemon restarts; AC-16 as written would lock that in.

Fix: "the last accepted inventory" is remembered per credentials (hub URL + machine id); a change of
either forgets it, so the next successful sync carries `repos`. Add the case to AC-16 (switch
credentials in the test, next sync carries `repos`).

## Suggestions (not blocking)

### S1 (NEW) Fleet shows stale sessions as current

The hub never deletes `hsession` rows. A session the daemon stops reporting (dropped past the 200 cap,
lost in a daemon reinstall, or on a `steps` machine a session that released its step and is no longer
sent) keeps its last state forever, and `/v1/fleet` lists all non-ended sessions "whatever the share
level", so "what each session is doing" can show a `working` session with a step from days ago.
`sync` writes `machine.last_seen` and every reported session's `updated_at` with the same `now` in one
transaction, so the hub can tell which sessions the latest sync carried: list in fleet only those (or
mark sessions absent from a sync as gone). If kept as is, say so in Open questions and in AC-11.

### S2 (NEW) `POST /v1/messages` reaches a `me` session of another user

`svc.say` accepts any `toSid` from any member and answers 201 or 404 (`session … is not live on any
machine`). Before this row a no-step session reached the hub only with `all`; with `me` as the
default every session is there. Sids are random, so this is mainly an existence oracle and a way to
type into someone's private session if a sid leaks. Suggest: `say` to a session that
`sessionVisible(caller, …)` hides answers the same 404 as an unknown sid, plus one World test.

### S3 (NEW) Name the World helper changes the criteria need

`World.person(name, repo, opts)` logs in with hostname `<name>-laptop` and no install id, so a second
`person("alice", …)` gets the same machine id, and `workspaceRoots` is fixed to `[]`. AC-11 (two
machines of one user), AC-15 (`workspaceRoots` on a temp tree) and AC-19 (two machines sharing a
hostname, which needs two install ids) cannot be written without new options (`hostname`, `install`,
`workspaceRoots`, several Persons per user). State them so the test-writer owns the helper change.

### S4 (NEW) AC-05 must use a strict comparison

The existing contract test compares machine rows with `toEqual`, which treats `share: undefined` as
absent. AC-05's FAIL state ("extra keys such as `share: undefined`") is only caught by `toStrictEqual`;
say so.

### S5 (NEW) Make nickname uniqueness atomic

With several hub replicas two concurrent `POST /v1/machines/:id/name` calls can both pass a
check-then-set. A unique index on `(user_id, nickname)` in the new migration (NULLs allowed many times
on both engines), with `setMachineNickname` returning `false` on the constraint error, makes the
contract hold. Also state what `setMachineNickname` returns for an unknown id.

### S6 (NEW) Tie-breaks for the fleet order

Two machines both online with the same `lastSeen`, or two sessions with the same `lastEventAt`, have
no defined order; blind tests on an injected clock will hit this. Add tie-breaks (machine `id`,
session `sid`).

### S7 (NEW) AC-23 timing: a metadata-only sync sends no SSE hint

`sync` publishes `changed` only for appended events, and the daemon spools no events for sessions
without a step (`daemon.ts` `observe`). So a new `me` session reaches the Mine tab only through the
15 s poll, not "live via the existing SSE hints" as the design says. Either have `sync` publish one
`changed` hint when it upserts a session whose state changed or is new, or state the bound in AC-23
("appears within 20 s without reload").

### S8 (NEW) `renderMachines` details

`renderGoals` puts the status line after the footer; the spec puts it above. Pick one on purpose.
"At most `width` characters" should say visible characters (the session list paints ANSI codes).
Say what `g` does in the machines panel (switch to goals, as `m` does from goals?).

### S9 (NEW) Activity text for `machine.named`

`/v1/live` `activity` runs every event through `describe()` in `service.ts`; give the text (e.g.
`named machine <hostname> <nickname>` / `cleared the name of machine <hostname>`) so it is testable
and not a raw type.

### S10 (NEW) Open question 2 has a lossless alternative

A v0.1.7/v0.1.8 daemon sends a session without a step only when set to `all`, and a session that
dropped its step under `steps` is no longer sent (its hub row keeps the old step). So a no-step row
from a machine with no reported share can only come from `all`. Treating "share absent" as `all` for
such rows keeps v0.1.7 behaviour without exposing anything new. The conservative reading is
acceptable; record the alternative in Open questions.

### S11 (NEW) AC-24: the route-table test ignores scopes

`test/schemas.test.ts` compares `method path rule` only, so the FAIL state "rule/scope mismatch" can
not be produced today. Say the test also compares `scope`.

### S12 (NEW) `mesh machine name` with a bad nickname prints "invalid request"

A body failing `MachineName` is a `ZodError`, which `app.ts` maps to `{error: "invalid request",
details}`. "Its `error` text on stderr" then says only `invalid request`. Validate with `NICKNAME_RE`
in the CLI first and give the message (e.g. `nickname must match [a-z0-9][a-z0-9-]{0,31} and not look
like a machine id`, exit 2), and add it to AC-19.

### S13 (NEW) `mesh machines` without a login

Not specified: give the stderr text and exit code (the `/local/fleet` 409 text is a good fit).

## Checks

This is a spec review; no code changed. Not run: `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`,
`pnpm test`, `pnpm build`, `pnpm schemas` (not needed for a document-only review). Every claim above
was checked by reading the code named at the top.
