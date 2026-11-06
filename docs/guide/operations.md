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
- `GET /readyz`: readiness. 200 with `{"ok":true,"schema":N}` when the database answers within 3 s and has this release's schema; 503 with an `error` otherwise, and while the hub shuts down.

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

On Postgres: roll the replicas one at a time. A release only adds to the schema (new tables, nullable columns) and removes things one release later, so old and new replicas run side by side during the rollout.

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

## Upgrading Claude Code

Run `pnpm test:claude`. It checks the hooks mesh uses, `claude agents --json`, and the workflow files mesh reads (journal, agent meta, run json). If a check fails, mesh's capture of that piece may be wrong until mesh is updated; sessions and the process itself are not affected.

## Privacy switches

- `MESH_BACKFILL=off` (environment of `mesh up`): don't import past workflow runs from Claude Code's files. Only runs seen live through the subagent hooks are recorded.
- `mesh up --no-solo`: no local hub; without a team hub, only the session list works.

## Logs

- The daemon logs to stderr; `mesh up --install` writes them to `~/.local/state/mesh/daemon.log`.
- The hub logs to stderr (in a container, its log).
