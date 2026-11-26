# Operations

## Running the hub

```bash
mesh hub init --users alice,bob --listen 0.0.0.0:7700   # once
mesh hub --config mesh-hub.yaml                          # serves the API and the web dashboard
```

Put it behind TLS (any reverse proxy) when it leaves loopback, and set `url:` to the public address. The proxy must not buffer responses: daemons and the dashboard hold a Server-Sent Events stream open, with a ping every 25 s.

There are two ways to run it:

| | One replica on SQLite (the default) | Several replicas on Postgres |
|---|---|---|
| `db:` | a file, `mesh-hub.db` | `postgres://user:pass@db.example.com/mesh` |
| Replicas | exactly one process per file | any number, behind a load balancer, no sticky sessions |
| Restarts and upgrades | a short gap | rolling, with no gap |
| Backup | `mesh hub backup` | the database's own tools |
| Good for | Solo, a team on one machine or VM | a hub run as shared infrastructure |

Don't start two hubs on one SQLite file. On Postgres, every replica migrates the schema at startup under a lock (the first one does the work), hints reach SSE subscribers on every replica (`LISTEN/NOTIFY`), and the periodic work (retention, pausing abandoned claims) runs on one replica at a time. Each replica uses up to 12 database connections.

### Configuration from the environment

Every setting is in `mesh-hub.yaml`; these variables override it (useful in containers):

| Variable | Overrides |
|---|---|
| `MESH_HUB_CONFIG` | the path of `mesh-hub.yaml` (instead of `--config`) |
| `MESH_HUB_DB` | `db:`: a SQLite file or a `postgres://` URL |
| `MESH_HUB_URL` | `url:`, the public address |
| `MESH_HUB_LISTEN` | `listen:`, `host:port` |
| the name in `client_secret_env` | an OIDC provider's client secret |

The startup line prints the database with its password hidden.

### Probes

Both answer without a login.

- `GET /healthz`: liveness. 200 while the process answers, with `{"ok":true,"version":"0.1.40","schema":N,"features":[…]}` (from 0.1.30): the hub's version, the schema this release migrates to (from the code, not the database) and the names of the features it has (`agent-compare`, `changes`, `commits`, `debrief-sla`, `efficiency`, `findings-rollup`, `fleet-pause`, `health`, `overlap-policy`, `preset-check`, `profile-fit`, `pulse-runs`, `runs`, `spot-checks`, `step-assign-for`, `trial` in 0.1.40; a release adds names and never removes one). A client checks `features` instead of guessing from a 404. From RL-24 it also carries `paused`: `null`, or the fleet pause `{since, by, via?, reason}` (see [Pause the fleet](#pause-the-fleet)); an older hub has no `paused`, which a client reads as "unknown". It does not touch the database, so a database outage does not get the hub restarted. `GET /health` answers the same (not to be confused with `GET /v1/health`, the pulse scorecard, which needs a login; see [concepts](concepts.md#pulse-health)).
- `GET /readyz`: readiness. 200 with `{"ok":true,"schema":N,"version":"…"}` when the database answers within 3 s and has this release's schema or a newer one (a rolling upgrade has begun); 503 with an `error` (and the `version`) otherwise, and while the hub shuts down.

The hub listens only once its migrations are done.

### Container image and Kubernetes

The repository's `Dockerfile` builds the hub image (Node 24, runs as uid 1000, listens on `0.0.0.0:7700`, reads `/etc/mesh/mesh-hub.yaml`):

```bash
docker build -t mesh-hub .
# one replica on SQLite, with the file in a volume:
docker run -d -p 7700:7700 -v ./mesh-hub.yaml:/etc/mesh/mesh-hub.yaml:ro \
  -v mesh-data:/data -e MESH_HUB_DB=/data/mesh-hub.db mesh-hub
# or on Postgres (run as many as you like):
docker run -d -p 7700:7700 -v ./mesh-hub.yaml:/etc/mesh/mesh-hub.yaml:ro \
  -e MESH_HUB_DB='postgres://mesh:…@db.example.com/mesh' mesh-hub
```

`deploy/kubernetes/` is a generic example with two replicas, probes, a PodDisruptionBudget and a Secret for the database URL and the OIDC client secret. It brings no database. See its [README](../../deploy/kubernetes/README.md).

### Moving from SQLite to Postgres

```bash
# stop the hub first
MESH_HUB_DB='postgres://mesh:…@db.example.com/mesh' mesh hub migrate --from mesh-hub.db
# or: mesh hub migrate --from mesh-hub.db --to postgres://…
```

A one-off, offline copy: every row with its ids, event sequence numbers and times. It runs as one transaction and checks each table's row count before it commits. It refuses a database that already holds a hub; `--force` replaces that hub. Then set `db:` (or `MESH_HUB_DB`) to the URL and start the hub. Keep the SQLite file as a backup. Passing the URL through `MESH_HUB_DB` keeps its password out of your shell history and the process list.

## Backup and restore

On SQLite:

```bash
mesh hub backup /backups/mesh-$(date +%F).db --config mesh-hub.yaml   # safe while the hub runs (VACUUM INTO)
```

To restore: stop the hub, copy the backup over the `db:` file, start the hub.

On Postgres, `mesh hub backup` refuses. Use the database's own tools: `pg_dump` (and `pg_restore` into an empty database), your operator's backups, or managed snapshots.

What is lost without a backup:
- **Kept anyway:** the ledger in git (goal, plan and step records). Every analysis can be rebuilt from it with `mesh ledger export`.
- **Lost:** live state (claims, messages, questions) and the event log.

## Upgrading the hub

On SQLite: stop the hub, install the new version, start it. Migrations run at startup; back up first.

On Postgres: roll the replicas one at a time. A release only adds to the schema (new tables, nullable columns) and removes things one release later, so old and new replicas run side by side during the rollout: once the first new replica migrates, the old ones stay ready on the newer schema.

A hub never opens a database migrated by a newer one: it stops with `database … has schema version <n>, newer than this mesh (<m>)`. Going back to an older hub means restoring the backup taken before the upgrade.

## Upgrading to 0.1.40

0.1.15 to 0.1.22 add headless steps, review records, pulses, debriefs, the roster and calibration ([scheduled reviews](scheduled-reviews.md)); 0.1.23 makes `--help` print help for every command instead of running it (`mesh setup --help` used to run setup); 0.1.24 fixes review paths in a checkout reached through a symlink and a run killed for its budget being reported as crashed. 0.1.25 lets a pulse fire while its last goal waits only on its owner (a debrief), fails a step whose headless run ended without `mesh_done` even when it submitted a record, ends a run that lingers after its `mesh_done`, maps review rules with the agent definition the run started with, pages long item lists instead of cutting them, gives consuming steps the evidence and proposal of each item, adds `env` to profiles (checks up to 1000 characters), allows grep, rg and find in the built-in profiles, keeps seen hub messages per hub, and makes `--help` exit 0 everywhere. Upgrade the hub first: a 0.1.25 daemon's close-as-fail needs a 0.1.25 hub (an older hub closes such a step as done, as before). 0.1.26 lets a profile's `env` set another tool's `MESH_*` variable (only the names mesh itself reads stay refused; the hub checks a profile when it is registered, so upgrade it before registering one) and adds a pulses panel to the terminal UI (`p`). 0.1.27 adds clean-audit goals: a relay stage with `sink` turns its filed items into steps of one standing goal per repo and topic, with `requires` between fixes, `mesh items sink` for items filed earlier, and `mesh goal drop` for any goal; upgrade the hub first (an older hub refuses a preset with `sink`). 0.1.28 lets a review item name the repo it is about (`repo`): the finding's clean-audit goal and step follow that repo, the open steps of an item whose repo changed are moved, and `mesh items retarget` sets the repo of items no audit raises again; upgrade the hub first, then the daemons of the machines that run auditors, then let the auditors add `repo` (an older hub, or an older daemon's `mesh_review`, refuses an item with `repo`). 0.1.29 adds the service scopes `pulses:write` (the pulse write routes) and `profiles:write` (`POST /v1/profiles`), lets a service token act for a person with `X-Mesh-On-Behalf-Of` on those routes and on `GET /v1/fleet` (only the person's own machines may be a pulse's target), and adds `owner` to each machine of `GET /v1/fleet`; no migration (schema 11). Grant the scopes by minting a new service token ([auth](auth.md)); a service token without them can no longer reach the pulse write routes or `POST /v1/profiles` (it could not before either). 0.1.30 adds `GET /v1/runs` (headless runs with their telemetry, item states and raw waste parts), trial fires (`mesh pulse fire --trial`: left out of statistics, calibration and runs, never blocking a slot), `toolsUsed` and `denied` in run telemetry, the machine of a round, `running` on slots skipped for overlap, and the version, schema and features in the probes; no migration (schema 11). Upgrade the hub first, then the daemons of runner machines (an older daemon sends no `toolsUsed` or `denied`; an older hub drops them). A 0.1.30 `mesh pulse fire --trial` against an older hub exits 1 and says so: the older hub ignored the flag and fired a normal goal, which the message tells you to drop. 0.1.31 adds pulse run cards (`GET /v1/pulses/:id/runs`) and a health scorecard (`GET /v1/health`), both read-only with scope `goals:read`, and the features `health` and `pulse-runs` in `/healthz`; no migration (schema 11), no daemon change. 0.1.32 records the commit of each step round (`commit` on rounds, run rows, run card stages, the `step.done`, `step.failed` and `run.finished` events and step records) and adds the feature `commits`; no migration (schema 11). Upgrade the hub, then every daemon: the daemon reads the commit, so rounds closed through an older daemon have none (an older hub drops the commit a newer daemon sends). 0.1.33 (RL-16) adds profile fitting, `GET /v1/profiles/:name/fit` and `mesh profile fit <name>`, which propose allow and deny rules from a profile's denied commands and unused tools without saving anything, and the `/healthz` feature `profile-fit`; it needs no migration. 0.1.34 (RL-17) adds a change timeline (`GET /v1/changes`: when each agent, profile and preset hash first appeared, with the hash before it and the event that introduced it) and a before/after view of two hashes of an agent (`GET /v1/agents/:key/compare`), both read-only with scope `goals:read`, the features `agent-compare` and `changes`, and `agents` (pins) on `pulse.created` and `preset`, `sha256` and `agents` on a `pulse.updated` that re-snapshots; no migration (schema 11), no daemon change. 0.1.35 (RL-18) adds spot checks of deciding agents (hub config `spot_checks`, off by default: a sample of validator and filer decisions goes to a person's spot-check step, and a disagreement counts toward calibration like a dismissal), `POST /v1/steps/:id/spot-checks` and the MCP tool `mesh_spot_check`, `decisions`, `humanDecisionShare` and `spotChecks` in `GET /v1/health`, the events `spot-check.opened` and `spot-check.decided`, and the feature `spot-checks`; no migration (schema 11). Upgrade the hub, then the daemons of the people who run spot checks (an older daemon has no `mesh_spot_check`). 0.1.36 (RL-14) adds time per session state, an efficiency card per goal and step (`GET /v1/goals/:id/efficiency`), figures over a window (`GET /v1/efficiency`) and a stuck signal (`GET /v1/stuck`), all read-only with scope `goals:read`, and the feature `efficiency`; it migrates the hub to schema 12 (a `step_time` table and an index on event times), so back up first. Upgrade the hub, then every daemon: only an upgraded daemon sends state time, and a step held through an older daemon shows none (absent, not zero). 0.1.37 (RL-15) adds the overlap policies `queue` and `supersede` (`--overlap`), a debrief SLA with optional auto-accept of agent-confirmed S3/S4 items (`debrief: {sla, auto_accept}` in a preset, or `sla` and `auto_accept` on a debrief step), the attention kind `debrief_overdue`, the events `pulse.queued`, `pulse.superseded`, `debrief.overdue` and `debrief.auto_accepted`, and the features `debrief-sla` and `overlap-policy`; no migration (schema 12, from 0.1.36): upgrade the hub first (an older hub refuses `queue` and `supersede` and ignores the SLA fields), and do not downgrade it once a slot was queued or an item auto-accepted (an older hub cannot read the `queued` slot state or the `auto-accept` via). 0.1.38 (RL-19) adds a findings roll-up per preset and repo (`GET /v1/findings/rollup`: open and accepted items by severity, the newest report, the pulse and the preset's kind), read-only with scope `goals:read`, an optional top-level `kind` in a preset, and the feature `findings-rollup`; no migration (schema 12), no daemon change. A CLI older than 0.1.38 drops a preset's `kind` when it sends the preset, so upgrade the CLI of whoever adds or updates pulses. 0.1.39 (RL-20) adds a read-only preset check (`POST /v1/presets/check`: the preset checks of `POST /v1/pulses` on a preset and params, answering `ok`, `problems` with create's texts, `warnings`, and when ok the instantiated `steps` and the roster pins `agents`; scope `goals:read`, no on-behalf, writes nothing), `steps` in `GET /v1/pulses/:id`, and the feature `preset-check`; no migration (schema 12), no daemon change. 0.1.40 (RL-21) lets a service token with the new scope `steps:assign` assign a ready step and rank machines for it acting for a person (`X-Mesh-On-Behalf-Of` on `POST /v1/steps/:id/assign` and `GET /v1/steps/:id/suggest`, the person's own machines and sessions only, the offer and `step.offered` naming the service as `via`), accepts `mode: "headless"` and `profile` in the step assign body (the caller's own machines only), refuses to accept a headless offer into a session (`offer-headless`), adds a stable `code` beside `error` on these refusals and `message` to the assign reply, and adds the feature `step-assign-for`; no migration (schema 12), no daemon change. Grant the scope by minting a new service token ([auth](auth.md)). RL-24 (fleet pause, 0.1.42 or later) adds `POST /v1/fleet/pause` and `POST /v1/fleet/resume`, the service scope `fleet:pause` (act-for keeps the person's admin role on these two routes only), `paused` on `/healthz`, `/health` and the sync reply, the slot reason `fleet_paused`, the events `fleet.paused` and `fleet.resumed`, `mesh fleet pause` and `mesh fleet resume`, and the feature `fleet-pause`; it migrates the hub to schema 13 (a `hub_state` table), so back up first. Upgrade every replica before pausing (an older replica does not check the pause), then the daemons (an older daemon still starts a run it already queued). Mint the client's service token again with `fleet:pause`. 0.1.23 has no release package. From 0.1.14 or earlier, in this order:

1. **Back up the hub** (`mesh hub backup …` on SQLite, `pg_dump` on Postgres).
2. **Upgrade the hub first**, every replica. At start it migrates the schema from 7 (0.1.10 to 0.1.14) to 12, the current `SCHEMA_VERSION`:

   | Schema | Release | Adds |
   |---|---|---|
   | 8 | 0.1.15 | hub-stored artifacts, registered permission profiles |
   | 9 | 0.1.16 | review records, items and their history |
   | 10 | 0.1.17 | pulses and their slots |
   | 11 | 0.1.19 | the roster (agent definitions, catalog sources) |
   | 12 | 0.1.36 | time per session state (`step_time`), an index on event times |

   0.1.18 and 0.1.20 to 0.1.22 add no migration. `GET /readyz` answers `{"ok":true,"schema":11}` once it is done. On Postgres, finish the rollout before you create pulses. Optional new blocks in `mesh-hub.yaml`: `artifacts` (size limits, retention) and `calibration` (`threshold`), see [install](install.md#headless-runs).
3. **Then the daemons and CLIs**, on every machine: run the installer again (for an existing setup it runs `mesh setup` and restarts a systemd user service), or install and run **`mesh setup`** yourself, then restart the daemon. `mesh setup` refreshes the hooks, the MCP server and the mesh skill, and installs the `mesh-debrief` skill that `mesh debrief` needs. `mesh doctor` checks both skills.
4. On machines that should run scheduled work, set up the runner fields ([Runner machines](#runner-machines)).

Why the hub first: a newer CLI sends what an older hub refuses. A 0.1.21 or later CLI sends preset snapshots with `params:` and `{turns}`-style budget placeholders (`mesh pulse add --preset audit-relay`), which a 0.1.20 hub answers with 422; hubs before 0.1.18 refuse `mode: debrief`, and older ones drop the new step fields.

**Older daemons against a 0.1.22 hub.** They keep working for interactive sessions and steps. For the new features:

| Daemon | What happens |
|---|---|
| 0.1.14 and earlier | It never tells the hub it can run headless steps, so it is never offered one and is never a pulse's candidate (with no other machine the slot is `missed` with `no_machine`). Its sessions have none of the new MCP tools, so they cannot finish a step with `output: review-record` or run a debrief. Its repos' agents are not on the roster. |
| 0.1.15 | Runs headless steps, but has no `mesh_review`: a review stage cannot finish. |
| 0.1.15 to 0.1.20 | A run binds to its step only through the user's hooks; without them (or with hooks of another daemon) every mesh call of the run fails and the step ends `headless run ended without mesh_done`. The run inherits the daemon's `TMUX`/`TMUX_PANE`. An agent with invalid front matter runs anyway, with the default model, all tools and no declared rules. |
| before 0.1.18 | No `mesh_dispose`: debriefs cannot record decisions. |
| before 0.1.19 | Sends no roster reports and cannot run a step whose `agent` is a roster key. |
| 0.1.21 | A run can be started twice; the step then fails with `could not make a worktree: Preparing worktree …`. A run that never started leaves a transcript and a session shown `working` long after. A 0.1.22 daemon ends such leftover sessions at start. |

Upgrade every runner to 0.1.25 before you schedule work on it.

## Pause the fleet

An admin stops new unattended work at once, for example during a bad agent release, a broken shared branch or a leaked credential:

```bash
mesh fleet pause "bad agent release"
mesh fleet resume
```

While the fleet is paused:
- **Stops:** no pulse slot fires (a due or queued slot is recorded `skipped`, reason `fleet_paused`; a pending slot whose window ends is `missed`, reason `fleet_paused`); no headless offer is made by any path (pulses, a goal's stick, `mesh assign`); the pause withdraws every open headless offer (`step.offer_withdrawn`, reason `fleet paused`; the offerer gets no message); a manual `mesh pulse fire`, a headless step assign and the accept of a headless offer answer `409 fleet-paused`; a daemon of this release starts no run it has queued.
- **Goes on:** running headless runs, claimed steps, interactive sessions and interactive offers. Per-pulse pause is separate: a fleet resume never enables a pulse its owner paused.
- **On resume:** the steps the pause held back are offered again to their goal's stick target; a pending pulse slot is offered again by the next tick; a headless offer withdrawn from a goal with no stick (for example one made by `POST /v1/steps/:id/assign`) is not offered again: its offerer assigns it again. Nothing missed is fired.

`GET /healthz` shows the pause (`paused`) to anyone who can reach it, like the version: **do not put secrets in the reason**. Each replica keeps its own copy and re-reads it every 5 s, so on several replicas `/healthz` may lag by up to 5 s; enforcement always reads the database. A daemon older than this release ignores the pause in the sync reply: it never gets a headless offer while paused, but it does start a run it already queued when a session frees up. Every daemon of this release notifies once when the fleet is paused and once when it is resumed, and `mesh status` prints the pause.

## Runner machines

A runner is any machine whose daemon runs headless steps: it needs `workspaceRoots` with checkouts of the repos (each with a git remote), `shareSessions` `me` or `all`, an `accept` policy that takes the pulse owners' offers, and a Claude Code login. Setup step by step: [scheduled reviews](scheduled-reviews.md#set-up-a-runner-machine). To keep one healthy:

- **Keep its checkouts current.** A run works on a worktree of the checkout's `HEAD`, and a repo agent is read from it. mesh never fetches or pulls; do it yourself (a `git pull --ff-only` in each checkout from cron or a timer), and keep local changes out of runner checkouts.
- **Run the daemon as a service** (`mesh up --install`) so runs and pulses survive logouts and reboots. A restarted daemon adopts runs that are still alive and closes those that ended meanwhile. A machine that sleeps through a pulse's window misses the slot.
- **Disk.** Every run leaves a folder in `<stateDir>/runs/` (Linux: `~/.local/state/mesh/runs/`) with its stream log; mesh never deletes them. Remove old ones by hand or from a timer. The worktree inside is removed when the run ends.
- **Capacity.** `maxSessions` caps runs and sessions together; queued runs start oldest first and are released at their deadline (note `capacity: no free session on <host> before the run deadline`).
- **Permissions.** Runs load your user settings: keep `permissions.allow` in `~/.claude/settings.json` small on a runner, since it adds to every profile. `MESH_CLAUDE_BIN` in the service's environment selects the `claude` executable.
- **Logs.** The daemon log has one line per run start and finish (`run <id>: started <step> (pid …)`, `finished (<exit>)`, `… did not start: <reason>`).

## Retention

`events_retention_days` (default 180; 0 keeps events forever). The hub deletes older events every few hours and logs a `hub.events_pruned` event. Exact timings older than that are gone; the summaries in git stay.

## When the hub is down

People keep working:
- Each daemon works on its local copy of the steps it holds, writes records locally, and queues events and calls.
- `mesh status` shows `hub offline since …, working locally (n waiting)`.
- When the hub is back, each daemon's probe (backing off from 5 s up to 60 s) finds it and sends everything once.
- Refused results are kept as notes.

## The ledger feed for analysis tools

```bash
mesh hub token --service analytics --config mesh-hub.yaml
mesh ledger export --repo ~/src/payments-api --repo ~/src/payments-web \
  --ref origin/HEAD --events --hub https://mesh.example --token "$ANALYTICS_TOKEN" --out ledger.jsonl
```

Each line is a validated `mesh.ledger.v1` record or a hub event (`schemas/ledger-line.json`). Invalid records are reported on stderr and make the exit code 1.

## Releasing mesh

Push a tag `vX.Y.Z` that matches `package.json`'s version. The `release` workflow runs the checks, then publishes:
- a GitHub release with `mesh-harness.tgz` (the npm package) and `install.sh`, which is what `releases/latest/download/install.sh` serves;
- the hub image `ghcr.io/<owner>/<repo>-hub:vX.Y.Z` and `:latest`;
- the npm package, only when the repository has an `NPM_TOKEN` secret.

## The hub API

[`schemas/hub-api.openapi.json`](../../schemas/hub-api.openapi.json) describes every hub route as OpenAPI 3.1: who may call it, its request body and query, and the event log's response. `pnpm schemas` writes it from `src/protocol/hub-api.ts`, and a test checks it lists exactly the routes the hub serves.

## Upgrading Claude Code

Run `pnpm test:claude`. It checks the hooks mesh uses, `claude agents --json`, and the workflow files mesh reads (journal, agent meta, run json). If a check fails, mesh's capture of that piece may be wrong until mesh is updated; sessions and the process itself are not affected.

## Privacy switches

- `MESH_BACKFILL=off` (environment of `mesh up`): don't import past workflow runs from Claude Code's files. Only runs seen live through the subagent hooks are recorded.
- `mesh up --no-solo`: no local hub; without a team hub, only the session list works.

## Files mesh writes

Config, credentials, the Claude settings file, `CLAUDE.md`, the skill, service units and records are written atomically (a temporary file in the same folder, flushed, then renamed), so a crash or power cut leaves the old file or the new one, never a broken one. `mesh setup` keeps the previous `daemon.json` as `daemon.json.prev`: its key is also in every installed hook.

## Logs

- The daemon logs to stderr; `mesh up --install` writes them to `~/.local/state/mesh/daemon.log`.
- The hub logs to stderr (in a container, its log).
