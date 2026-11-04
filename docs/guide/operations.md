# Operations

## Running the hub

```bash
mesh hub init --users alice,bob --listen 0.0.0.0:7700   # once
mesh hub --config mesh-hub.yaml                          # serves the API and the web dashboard
```

One process with one SQLite file. Put it behind TLS (any reverse proxy) when it leaves loopback, and set `url:` to the public address.

## Backup and restore

```bash
mesh hub backup /backups/mesh-$(date +%F).db --config mesh-hub.yaml   # safe while the hub runs (VACUUM INTO)
```

To restore: stop the hub, copy the backup over the `db:` file, start the hub.

What is lost without a backup:
- **Kept anyway:** the ledger in git (goal, plan and step records). Every analysis can be rebuilt from it with `mesh ledger export`.
- **Lost:** live state (claims, messages, questions) and the event log.

## Retention

`events_retention_days` (default 180; 0 keeps events forever). The hub deletes older events every few hours and logs a `hub.events_pruned` event. Exact timings older than that are gone; the summaries in git stay.

## When the hub is down

People keep working:
- Each daemon works on its local copy of the steps it holds, writes records locally, and queues events and calls.
- `mesh status` shows `hub offline since …, working locally (n waiting)`.
- When the hub is back, each daemon's probe (backing off from 5 s up to 60 s) finds it and sends everything once.
- Refused results are kept as notes.

## The ledger feed for mesh-ai

```bash
mesh hub token --service mesh-ai --config mesh-hub.yaml
mesh ledger export --repo ~/src/frr-dplane-ovs --repo ~/src/vpc-node-agent \
  --ref origin/HEAD --events --hub https://mesh.example --token "$MESH_AI_TOKEN" --out ledger.jsonl
```

Each line is a validated `mesh.ledger.v1` record or a hub event (`schemas/ledger-line.json`). Invalid records are reported on stderr and make the exit code 1.

## Upgrading Claude Code

Run `pnpm test:claude`. It checks the hooks mesh uses, `claude agents --json`, and the workflow files mesh reads (journal, agent meta, run json). If a check fails, mesh's capture of that piece may be wrong until mesh is updated; sessions and the process itself are not affected.

## Privacy switches

- `MESH_BACKFILL=off` (environment of `mesh up`): don't import past workflow runs from Claude Code's files. Only runs seen live through the subagent hooks are recorded.
- `mesh up --no-solo`: no local hub; without a team hub, only the session list works.

## Logs

- The daemon logs to stderr; `mesh up --install` writes them to `~/.local/state/mesh/daemon.log`.
- The hub logs to stderr.
