# Auth

The hub authenticates people through **providers**. A login gives the CLI or the browser an opaque hub token, so mesh is not tied to any identity provider.

| Kind | Use | Notes |
|---|---|---|
| `none` | Solo, or a hub on loopback for one person | Refused off loopback. `user:` names the person. |
| `token` | small teams | `mesh hub init --users alice,bob` writes the config and prints one token per person (only their sha256 is stored). |
| `oidc` | Kanidm, Keycloak, Authentik, GitLab, Google… | Auth code + PKCE in the browser, or device flow. `kanidm` is a preset; any OIDC issuer works. |

```yaml
# mesh-hub.yaml
listen: 0.0.0.0:7700
url: https://mesh.example
db: mesh-hub.db          # or postgres://user:pass@db.example.com/mesh for several replicas; MESH_HUB_DB overrides
events_retention_days: 180
auth:
  providers:
    - id: team
      kind: token
      users:
        - { name: alice, token_sha256: <sha256 of alice's token> }
    - id: kanidm
      kind: oidc
      preset: kanidm
      issuer: https://idm.example/oauth2/openid/mesh
      client_id: mesh
      groups_claim: groups
  bootstrap_admins: [team:alice]
  session: { device_max_age: 90d, web_max_age: 12h }
```

**Roles.**
- **member:** use goals and steps.
- **approver:** approve any plan.
- **admin:** everything, plus user and token administration.
- **service:** read the event feed, plus what the token's scopes allow.

Roles come from provider groups (`roles:` mappings) and `bootstrap_admins`.

**Tokens.**
- Device tokens (CLI and daemon) and web sessions expire as configured.
- `mesh hub revoke --user alice` or `--machine m-…` revokes them.
- `mesh hub token --service analytics` mints a token for `GET /v1/events` and `mesh ledger export --events`.
- `--scope` adds member routes to a service token, comma-separated. `goals:read` reads goals and steps (`GET /v1/goals`, `/v1/goals/:id` with its files and timeline, `GET /v1/steps`, `/v1/steps/:id`) and checks presets (`POST /v1/presets/check`, a read that writes nothing); `goals:write` creates goals (`POST /v1/goals`, owned by the service account); `live:read` reads `GET /v1/live`, `GET /v1/fleet` and `GET /v1/stream`; `pulses:write` creates and changes pulses (`POST /v1/pulses`, `/v1/pulses/:id/{update,pause,resume,fire,delete}`); `profiles:write` saves permission profiles (`POST /v1/profiles`). No scope approves, claims or answers. Example, for a dashboard that shows and adds goals: `mesh hub token --service mesh-ai --scope goals:read,goals:write,live:read`. A scope is fixed when the token is minted; to change it, revoke the token (`mesh hub revoke --user <service user>`) and mint another.

**A service acts for a person.** On `GET /v1/fleet`, `POST /v1/profiles`, `POST /v1/pulses` and `POST /v1/pulses/:id/{update,pause,resume,fire,delete}`, a service token with the route's scope may send `X-Mesh-On-Behalf-Of: <user id>`. The request then runs as that person, with the member role only (never their admin role): the pulse or profile is theirs, the fleet is theirs, and the events name them in `user` and the service in `payload.via`. A pulse made or changed this way must name the person's own machines in `target.machines` (by id, `<user>/<nickname>` or nickname); labels may narrow it. Refusals, each with its own `error`:

| Status | `error` | When |
|---|---|---|
| 400 | `on-behalf-of required: …` | a service writes on these routes without the header |
| 400 | `on-behalf-of is not accepted on this route` | the header on any other route |
| 400 | `target.machines required: …` | a pulse for a person with an empty or labels-only target |
| 403 | `on-behalf-of is for service tokens only` | a person's token sends the header |
| 403 | `unknown user "<id>"` | no such user, or a service account |
| 403 | `machine not yours: <name>` | a target machine the person does not own |
| 403 | `only @<owner> or an admin can change pulse <id>` | a pulse of another person |

Example, for mesh-ai: `mesh hub token --service mesh-ai --scope goals:read,goals:write,live:read,pulses:write,profiles:write`.

A daemon whose token expired keeps working locally and shows "hub login expired"; `mesh login` again.
