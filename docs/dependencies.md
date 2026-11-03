# Dependencies

Each runtime dependency needs one line of justification here (plan §1.7). Dev dependencies are listed for completeness.

## Runtime

None yet. Planned: `zod`, `hono`, `@hono/node-server`, `openid-client`, `@modelcontextprotocol/sdk`, `yaml` (each added with the task that first needs it).

## Development

| Package | Why |
|---|---|
| `typescript` | Type checking (`tsc --noEmit`) |
| `tsdown` | Bundles `src/main.ts` into `dist/main.mjs` |
| `vitest` | Tests |
| `eslint`, `@eslint/js`, `typescript-eslint`, `globals` | Lint |
| `dependency-cruiser` | Enforces module boundaries (plan §2.1) |
| `@types/node` | Node typings |

The Node toolchain is pinned to 24 through `devEngines.runtime` in `package.json`; pnpm downloads it on demand.
