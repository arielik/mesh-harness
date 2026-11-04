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
db: mesh-hub.db
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
- **service:** read the event feed only.

Roles come from provider groups (`roles:` mappings) and `bootstrap_admins`.

**Tokens.**
- Device tokens (CLI and daemon) and web sessions expire as configured.
- `mesh hub revoke --user alice` or `--machine m-…` revokes them.
- `mesh hub token --service analytics` mints a token for `GET /v1/events` and `mesh ledger export --events`.

A daemon whose token expired keeps working locally and shows "hub login expired"; `mesh login` again.
