# mesh hub on Kubernetes (example)

A generic starting point for running several `mesh hub` replicas on one Postgres. It is an example, not a chart: copy it into your own repository and change the placeholders there. Domains, the identity provider, storage and GitOps wiring belong in your repository, not here.

| File | What |
|---|---|
| `deployment.yaml` | 2 replicas, rolling updates with no gap (`maxUnavailable: 0`), probes, non-root and read-only root filesystem |
| `service.yaml` | ClusterIP on port 80 |
| `pdb.yaml` | keeps at least one replica up during node drains |
| `ingress.yaml` | TLS for `mesh.example.com` |
| `configmap.yaml` | `mesh-hub.yaml` (an OIDC provider with placeholder issuer) |
| `secret.example.yaml` | the Secret's keys (`db-url`, `oidc-client-secret`); not applied by `kustomization.yaml` |

No database is included. Bring a Postgres (tested with 17) from wherever you run databases: a managed service, an operator, or a VM.

## Placeholders to change

- `registry.example.com/mesh-hub:0.0.0`: build the image from the repository's `Dockerfile` and push it to your registry.
- `mesh.example.com` (`url:` in the ConfigMap, and the Ingress host and TLS secret).
- `https://idp.example.com`, `client_id` and the group names in `roles` (your OIDC provider; see [docs/guide/auth.md](../../docs/guide/auth.md)).
- `bootstrap_admins`, for example `["sso:alice"]`.

## Install

```bash
kubectl create secret generic mesh-hub \
  --from-literal=db-url='postgres://mesh:…@postgres.example.internal:5432/mesh?sslmode=require' \
  --from-literal=oidc-client-secret='…'
kubectl apply -k deploy/kubernetes
kubectl rollout status deploy/mesh-hub
```

The database user needs to create tables in its database (the first replica to start migrates the schema; the others wait for it). Each replica keeps up to 10 pooled connections plus 2 of its own (hints and tick leadership), so plan for about 12 per replica.

## How the pieces fit

- **Probes.** `/healthz` (liveness) answers as long as the process does; it never touches the database, so a database outage does not restart the pods. `/readyz` (readiness) answers 200 when Postgres replies within 3 seconds and has this release's schema or a newer one, and 503 otherwise, so traffic only reaches replicas that can serve it. The hub starts listening only after its migrations, which is why the startup probe allows two minutes.
- **No sticky sessions.** Any request can go to any replica: device logins, idempotency keys and SSE hints work across them. Hints travel over Postgres `LISTEN/NOTIFY`.
- **Periodic work** (retention, pausing abandoned claims) runs on one replica at a time, chosen by an advisory lock. If that replica goes away, another takes over at its next 30-second interval once Postgres has seen the old connection close (at once for a pod that stops cleanly).
- **Rolling upgrades.** mesh's rule is that a release only adds to the schema (tables, nullable columns), so old and new replicas run side by side during the rollout. The `preStop` sleep lets the Service drop a pod before it stops.
- **Server-Sent Events.** Daemons and the dashboard keep a stream open with a ping every 25 seconds. Your ingress must not buffer responses, and its read timeout must be longer than 25 seconds (most defaults are 60).
- **Database at startup.** A replica that cannot reach Postgres when it starts exits, and Kubernetes restarts it.

## Moving from a SQLite hub

Stop the old hub, then copy it into the empty database once:

```bash
MESH_HUB_DB='postgres://mesh:…@postgres.example.internal:5432/mesh?sslmode=require' \
  mesh hub migrate --from /var/lib/mesh/mesh-hub.db
```

It checks every table's row count and refuses a database that already holds a hub (`--force` replaces it). Then apply this example. Keep the SQLite file as a backup.

## Backup

`mesh hub backup` is for SQLite only. On Postgres, back up with the database's own tools: `pg_dump`, your operator's backups, or managed snapshots. The ledger in git (goal, plan and step records) does not depend on the hub and stays the record for analysis.
