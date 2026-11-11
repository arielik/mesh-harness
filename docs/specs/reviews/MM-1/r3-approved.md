Verdict: APPROVED | Round: 3 | Blocking-open: 0

# Review of spec MM-1, round 3

Reviewed cold: `docs/specs/MM-1.md` (commit d5a5553, revision 3), against
`docs/analysis/2026-11-11-my-mesh-and-assign.md` (MM-1, Safety) and the code on `feat/my-mesh-assign`:
`src/store/{hub-store,pg,db,dialect}.ts` (`tx`, `serialize`, `lock`, `touchMachine`, `MachineRow`,
`BEGIN IMMEDIATE`, Postgres transaction retry), `src/store/hub-store.contract.test.ts`,
`src/hub/service.ts` (`sync`, `live`, `describe`), `src/protocol/hub-api.ts` (`scope`, `tag`),
`src/cli/tui/render.ts` (`age`). Read first: `r1-changes-requested.md`, `r2-changes-requested.md`.

## Round 2 follow-up

| r2 | State |
|---|---|
| B1 inventory under `steps` leaks private repos | Fixed. Under `steps` the inventory is always empty (no scan, no session repos), sent under the same rule as any inventory, so an inventory stored under an earlier level is cleared. AC-30 proves it on the daemon with a fake fetch; the install-guide and concepts rows say what each level sends. No regression: AC-15 runs under `me`, AC-16 has no level dependence. |
| B2 constraint error aborts the Postgres transaction | Fixed. `setMachineNickname` takes `serialize()` (the `events` advisory lock; a no-op on SQLite where `db.ts` opens `BEGIN IMMEDIATE`), checks for a clash, then writes; it runs in the caller's transaction or its own (`PgDb.transaction` reuses an open one), so the xact lock is held to commit. The unique index is a backstop only. AC-07 (store, both engines) and AC-13 (HTTP, Postgres when set) cover the concurrent pair. No regression: `serialize` respects the fixed lock order (`events` first). |
| S1 activity text needs a hostname | Not addressed (REPEAT, below). |
| S2 owner of the rescan throttle | Not addressed (REPEAT, below). |
| S3 AC-05 and `installId` | Not addressed (REPEAT, below). |
| S4 offline answers | Partly: MCP offline is in AC-20; `/local/fleet` and `mesh machines` offline are not (REPEAT, below). |
| S5 age rounding | Not addressed (REPEAT, below). |

Scope: no creep. Nothing beyond the design's MM-1 row and its Safety section; labels, accept and
offers stay out. Names are generic (`example.org/team/alpha`, `m2`, `alice`, `bob`).

## Blockers

None.

## Suggestions (not blocking)

### S1 (REPEAT of r2 S1) `machine.named` activity text needs the hostname

`describe(type, subject, payload)` (`src/hub/service.ts:1270`) sees only the payload, which the spec
fixes as `{ machine, nickname }`, yet the text is `named machine <hostname> <nickname>`. The
implementer must either add `hostname` to the payload or look it up in `live()`. Pick one in the
`POST /v1/machines/:id/name` row (and `docs/events.md`), so a test asserting the payload strictly and
a test asserting the text cannot force different implementations.

### S2 (REPEAT of r2 S2) Name where the rescan throttle sits

AC-16 asks to prove "within `REPO_SCAN_MS` the folders are not rescanned" with an injected clock, but
`HubLinkDeps.machineRepos` is a plain `() => Repo[]` and no interface says which unit holds the
throttle or how a test injects the clock and observes a scan. A test-writer can fall back on
`vi.mock("./repos.js")`; naming e.g. `repoInventory({ roots, sessions, now, scan? })` in
`src/daemon/repos.ts` would make the test independent of module mocking.

### S3 (REPEAT of r2 S3) AC-05 and machines with an install id

`MachineRow.installId` is set for every v0.1.5+ login. "Compares equal to `{ id, userId, hostname,
lastSeen, counts }`" with `toStrictEqual` holds only for a row upserted without an install id (as the
contract test does today, line 238). Add "(plus `installId` when one was given)" to the `MachineRow`
row and AC-05.

### S4 (REPEAT of r2 S4) Offline answers for `/local/fleet` and `mesh machines`

Only the no-credentials case is specified for these two. State the offline answer (`/local/fleet`:
the status and text `rpc()` gives other `/local` hub calls today; `mesh machines`: that text on
stderr, exit 1) and add it to AC-19/AC-21, as AC-20 does for MCP.

### S5 (REPEAT of r2 S5) Age rounding

"Seconds under 60 s, minutes under 60 m, hours under 48 h" reads as truncation; `age()` in
`src/cli/tui/render.ts:22` rounds at each unit (59.6 s prints `1m`, 59.6 min prints `1h`). Say
"same results as `age()`" so AC-17 fixtures at unit boundaries match the implementation.

### S6 (NEW) Naming a machine with its current nickname

The row records `machine.named` "on a change", and AC-13 checks an event "on each change". Say what
setting the same nickname again answers (200, no event, is the natural reading) so a blind test does
not expect an event there.

### S7 (NEW) Record the r2 suggestions in the Status line

Revision 3 lists only the r2 blockers. Note which r2 suggestions were taken or left, as revision 2
did for r1.

## Checks

Spec review, no code changed. Not run: `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`,
`pnpm test`, `pnpm build`, `pnpm check`, `pnpm schemas` (not needed for a document-only review).
Every claim above was checked by reading the code named at the top.
