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

- `GET /healthz`: liveness. 200 while the process answers. It does not touch the database, so a database outage does not get the hub restarted.
- `GET /readyz`: readiness. 200 with `{"ok":true,"schema":N}` when the database answers within 3 s and has this release's schema or a newer one (a rolling upgrade has begun); 503 with an `error` otherwise, and while the hub shuts down.

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

## Upgrading to 0.1.22

0.1.15 to 0.1.22 add headless steps, review records, pulses, debriefs, the roster and calibration ([scheduled reviews](scheduled-reviews.md)). From 0.1.14 or earlier, in this order:

1. **Back up the hub** (`mesh hub backup …` on SQLite, `pg_dump` on Postgres).
2. **Upgrade the hub first**, every replica. At start it migrates the schema from 7 (0.1.10 to 0.1.14) to 11, the current `SCHEMA_VERSION`:

   | Schema | Release | Adds |
   |---|---|---|
   | 8 | 0.1.15 | hub-stored artifacts, registered permission profiles |
   | 9 | 0.1.16 | review records, items and their history |
   | 10 | 0.1.17 | pulses and their slots |
   | 11 | 0.1.19 | the roster (agent definitions, catalog sources) |

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

Upgrade every runner to 0.1.22 before you schedule work on it.

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
