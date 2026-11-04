# Dependencies

Each runtime dependency needs one line of justification here (plan §1.7). Dev dependencies are listed for completeness.

## Runtime

| Package | Why |
|---|---|
| `zod` | Schemas for hook input, `agents --json`, config, local and hub APIs (plan §5) |
| `hono`, `@hono/node-server` | Hub HTTP server: routing, cookies, SSE |
| `openid-client` | Generic OIDC provider (Kanidm, Keycloak, …): discovery, code + PKCE, device flow |
| `@modelcontextprotocol/sdk` | The `mesh mcp` stdio server |
| `yaml` | `mesh-hub.yaml`, plan files for `mesh goal plan` |

SQLite is Node's built-in `node:sqlite`.

## Development

| Package | Why |
|---|---|
| `typescript` | Type checking (`tsc --noEmit`) |
| `tsdown` | Bundles `src/main.ts` into `dist/main.mjs` |
| `vitest` | Tests |
| `eslint`, `@eslint/js`, `typescript-eslint`, `globals` | Lint |
| `dependency-cruiser` | Enforces module boundaries (plan §2.1) |
| `@types/node` | Node typings |
| `vite`, `@vitejs/plugin-react`, `react`, `react-dom`, `@types/react*` | The hub's web dashboard (built into `dist/web`; not runtime dependencies of the CLI) |
| `@playwright/test` | Web smoke tests (`pnpm test:web`) |

The Node toolchain is pinned to 24 through `devEngines.runtime` in `package.json`; pnpm downloads it on demand.
