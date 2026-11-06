# Hub scale-out: several replicas on Postgres

Status: proposed (2026-11-06). Replaces "one process with one SQLite file" as the *only* hub deployment. SQLite stays the default.

## Why

Today the hub is one process with one SQLite file (plan ADR 2). That is right for Solo and small teams. On a container platform it means:
- one replica;
- a ReadWriteOnce volume;
- a gap in service on every restart and upgrade;
- no way to spread SSE connections or dashboard load.

A team that runs the hub as shared infrastructure wants N interchangeable replicas behind a load balancer and rolling upgrades.

## Goals and non-goals

Goals:
- N stateless hub replicas, any request on any replica, no sticky sessions;
- rolling upgrades with no downtime;
- the same CLI, API, events and ledger as now;
- `mesh hub` with SQLite unchanged for everyone who doesn't opt in.

Non-goals:
- multi-region;
- sharding;
- high availability for SQLite;
- running more than one database.

## What holds state today

| State | Where | Change |
|---|---|---|
| Users, tokens, machines, sessions, goals, plans, steps, notes, questions, messages, events, idempotency keys | SQLite tables (`src/store/hub-store.ts`), mostly `value` JSON columns | Same tables on Postgres |
| OIDC device-flow attempts | in memory (`OidcProvider.devices`) | Move to a table (`login_attempt` already exists for the browser flow) |
| SSE hint fan-out | in process (`src/hub/bus.ts`) | `HintBus` interface: in process, or Postgres `LISTEN/NOTIFY` |
| Periodic work (`svc.tick()`: retention, timeouts) | a timer in every process | One leader at a time (advisory lock), and `tick` made idempotent |

Nothing else is held per process, which is why this change is small.

## Design

**1. Storage driver.**
- `db:` in `mesh-hub.yaml` takes a path (SQLite, as now) or a `postgres://` URL. The `MESH_HUB_DB` environment variable overrides it.
- `Db` becomes an async interface with two drivers: `node:sqlite`, and `pg` loaded lazily so Solo users never load it. `HubStore` and `HubService` become async; this is most of the work, about 140 store calls in `service.ts`.
- The schema is kept as it is: JSON stays `text`, and `AUTOINCREMENT` becomes `GENERATED ALWAYS AS IDENTITY`. A small dialect table covers `INSERT OR IGNORE` and `ON CONFLICT`. Migrations stay plain SQL, one file per dialect.

**2. Correctness under concurrency.**
- *Claims* are the contended write. They already are, or become, a conditional update (`UPDATE step … WHERE id=? AND state='ready'`) with a row-count check. That gives exactly one winner on both drivers, with no reliance on `BEGIN IMMEDIATE` serialising everything.
- *Event order.* `GET /v1/events?after=<seq>` and the SSE `changed` hint need gap-free, commit-ordered sequence numbers. Plain sequences can commit out of order. Each write transaction that appends events takes `pg_advisory_xact_lock(EVENTS)` first. Event writes are low volume, so serialising them costs nothing noticeable and keeps the cursor contract exact.
- *Idempotency* is already a table keyed by `(key, user)`, so it works across replicas as it is.

**3. Hints across replicas.**
- `HintBus` has two implementations. The in-process one is today's `Bus`. The Postgres one is `NOTIFY mesh_hint, '<json>'` after commit, and each replica `LISTEN`s and fans out to its local SSE subscribers.
- Hints are already lossy by contract: daemons pull their inbox and dashboards refetch. NOTIFY's at-most-once delivery is enough, and a replica that reconnects simply refetches.

**4. Periodic work.**
- `tick()` runs only on the replica holding `pg_try_advisory_lock(TICK)` on a dedicated connection. If that replica dies, the lock is released and another one takes over at its next interval.
- `tick` must also be safe to run twice (it already updates through conditional writes). A short overlap during failover is then harmless.

**5. Startup and upgrades.**
- Migrations run at startup under `pg_advisory_lock(MIGRATE)`. The first replica migrates and the others wait.
- Rule for rolling upgrades: a release only *adds* (new tables, nullable columns). Removing something happens one release later. This is checked by a test that runs release N−1's queries against release N's schema.

**6. Operations.**
- `GET /healthz` reports liveness (the process is up). `GET /readyz` reports readiness (database reachable and migrations done).
- `mesh hub backup` stays SQLite only. On Postgres, use the database's own tools (`pg_dump`, an operator, managed snapshots).
- `mesh hub migrate --from <sqlite file> --to postgres://…` copies a hub across, one-off and offline. This lets a team that started on SQLite move.
- The ledger in git is unchanged and stays the recovery path for analysis.

**7. Packaging (generic).**
- A published OCI image of `mesh hub`. All configuration comes from `mesh-hub.yaml` or environment variables (`MESH_HUB_DB`, `MESH_HUB_URL`, `MESH_HUB_LISTEN`, OIDC issuer, client id and secret).
- An example under `deploy/kubernetes/`: Deployment (replicas: 2), Service, a PodDisruptionBudget, probes, and a Secret reference. Hostnames, issuers and storage classes are placeholders. The example ships no database; it expects a `postgres://` URL.
- Any environment-specific values (domains, identity realm, GitOps wiring) belong in the deployer's own repository, not here.

## Tests

- **Store contract suite** runs against both drivers. Postgres is enabled by `MESH_TEST_PG_URL`; CI starts a Postgres service container.
- **Two-replica end to end** (`pnpm spike e2e-scale`): two hubs on one Postgres behind a round-robin proxy. It checks:
  - a claim race (exactly one winner);
  - an SSE hint published on replica A and seen by a daemon connected to B;
  - a device-flow login started on A and finished on B;
  - killing the tick leader, after which the other replica takes over within one interval;
  - a gap-free `/v1/events` cursor under concurrent writes.
- The **existing e2e suites** run unchanged on SQLite.

## Cost and order

1. `Db` async interface and the SQLite driver behind it. No behaviour change; the existing tests pass.
2. Postgres driver, dialect and migrations, with the contract suite on both.
3. OIDC device state in the database, `HintBus` with NOTIFY, tick leadership, event-sequence lock.
4. `/healthz` and `/readyz`, image, `deploy/kubernetes/` example, `mesh hub migrate`, docs (operations and install).
5. `e2e-scale`.

Step 1 is the bulk of the diff. Steps 2–5 are each small.
