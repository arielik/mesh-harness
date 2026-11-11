Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 3

# Review of spec MM-4, round 1

I reviewed `docs/specs/MM-4.md` cold, as of commit 3c725c8. I checked it against
`docs/analysis/2026-11-11-my-mesh-and-assign.md` (MM-4, Safety and privacy, Not in scope) and against
the code on `feat/my-mesh-assign`:
- `src/hub/{app,service}.ts`
- `src/core/{offers,visibility,repo-id,fleet,roles,session-state}.ts`
- `src/protocol/{hub,hub-api,config}.ts`
- `src/daemon/daemon.ts`
- `src/cli/{offer-commands,mesh-commands,hub-client,client}.ts`
- `web/src/{goals.tsx,api.ts}`
- `test/schemas.test.ts`, `test/helpers/world.ts`, `test/e2e-web/*`

There are no earlier MM-4 rounds, so every finding is NEW.

## Checks

This is a spec review, so there is no code to build. I did not run any of these: `pnpm lint`,
`pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm build` (together `pnpm check`),
`pnpm schemas`, `pnpm test:web`. I used only `git`, `grep`, `sed`, `cat` and file reads.

## What already matches the code

- **Target resolution and `to`.** `resolveTarget`/`findMachine` (service.ts) try a machine id
  first, then the caller's own nickname, then `<user>/<nickname>`. With two parts, the first part
  is tried as a machine before the `<user>/<nickname>` reading. So the `to` rule is right: use
  `<user>/<nickname>` only when the caller has no machine nicknamed `<user>`. `findSessionOn`
  already limits matches to visible, non-ended sessions and returns the 404/409 texts the
  messages row quotes. A one-part `to` gives a machine with no session, so the 400
  `say needs a session` case can be reached.
- **`auto`.** `acceptMatches(policy, {byUser, byMachine}, {userId})` has the signature the spec
  uses. `autoFor` uses the same inputs for an assign with no session. A cookie has no
  `machineId`, so `byMachine` is absent, as the spec says.
- **Online, age, visibility.** `ONLINE_MS = 2 * 60_000`, `age()` in `core/fleet.ts`, and
  `sessionVisible(viewerId, {userId, step}, share)` all exist as named.
- **No store change.** `listMachines()` with no filter (needed for `team=1`) and
  `listSessions({live: true})` already exist on the shared store. Nothing needs a migration on
  SQLite or Postgres.
- **Rule and scope.** `member` with no scope means `allowed()` refuses a service token (403). The
  route-table tests (`test_AC20_HUB_API_matches_app` and the scope variant) compare
  method/path/rule/scope, so AC-17 can fail. Hono matches `/v1/steps/:id/suggest` exactly, so it
  does not clash with `/v1/steps/:id`.
- **CLI compatibility.** MM-3 usage tests only check the first line of the usage text with
  `startsWith`, so the two-line usage keeps them green. No test asserts the old
  `toSid or toStep is required` text.
- **Daemon hook.** `handleOffer` calls `deps.launchStep` only under `assignments: "launch"` with no
  picked session, and falls back to `listed()`. That is the single place the `maxSessions` gate
  goes. `World.restart` already passes a fake `launchStep`.
- **Scope.** The added goal route, hub-side `to` resolution and `--json` are each recorded under
  Open questions with a reason. They follow from the design row and are not scope creep. The Out
  list (no MCP tool, no migration, no new events) fits the row.

## Blockers

### B1 (NEW): AC-02 cannot catch a wrong rank order
AC-02 builds "pairs of machines that differ in exactly one key (both otherwise equal)". That
checks the direction of each key, not its position in the order. Two examples:
- An implementation that swaps `sessionLabels` and `machineLabels` passes every pair.
- An implementation that leaves out the `online` key passes too. `online` comes from `lastSeen`,
  so a pair that differs only in `online` cannot be built. The online machine always also has the
  newer `lastSeen`, and the `lastSeen` key alone puts it first.

The criterion cannot fail for the one property it is meant to prove (rule 3).

**Fix.** For each key k, use a pair where the expected winner is better on k, equal on every
earlier key, and **worse on every later key it can be worse on**. Example for `online`: online with
0 idle sessions against offline with 2 idle sessions, and the online machine wins. State that rule
in AC-02.

### B2 (NEW): AC-13 "may launch again" cannot fail
"After 120 s (daemon clock) without the launched session appearing, a new offer **may** launch
again." With "may", the AC passes whether or not `launchStep` is called. That breaks rule 3 for
the expiry of a counted launch.

**Fix.** Write "a new auto offer **calls** `launchStep` (one more call)". Also state the
counterpart: before 120 s a new offer does not launch, and is acked `listed`.

### B3 (NEW): the Compatibility line about a v0.1.11 hub is wrong
The spec says: "A v0.1.11 hub answers 404 to the suggest routes; the CLI prints the hub's text and
exits 1." It does not. `createApp` ends with `app.get("*")`, which answers **200** for any GET it
does not match:
- with the web build: `index.html`;
- without it: the text `mesh hub is running…`.

`hubFetch` then turns the non-JSON body into `{}` (`res.json().catch(() => ({}))`), and
`mesh assign --suggest` reads `view.suggestions` from `{}`. The stated behaviour cannot happen
without a contract change, so the decision as written is wrong (rule 2).

**Fix.** Pick one of these:
- Add to the CLI row: a 200 reply without a `suggestions` array → stderr
  `the hub does not offer suggestions (it needs v0.1.12 or later)`, exit 1. Add that case to AC-09.
- Make the hub answer 404 JSON for unknown `/v1/*` paths. That is a wider change, so record it as
  an open question if you choose it.

Whichever you pick, correct the Compatibility line.

## Suggestions (not blocking)

- **S1 (NEW): AC-15 does not say who is signed in.** "bob's machine (inventory `alpha`,
  nickname)" must appear with `Team machines` off. That holds only if bob is the signed-in user.
  The existing `mine.spec.ts` signs in as bob, but AC-15 should say so. Then "a teammate's
  machine" (e.g. alice's) is the one that `Team machines` adds. The e2e hub is shared across spec
  files: `mine.spec.ts` already gives bob a machine with an `alpha` session. Tell the test to find
  rows only by `data-machine` (as the Surfaces line says) and not to count rows.
- **S2 (NEW): `session` can name a session the daemon will not pick.** Suggest scores the best
  session by labels in `W` = topics ∪ repo names. On accept, the daemon's `pickSession`
  (`core/offers.ts`) scores by `want.topics` only. If a session is labelled with the repo name,
  suggest can name session X while the daemon gives the step to Y. Either say in the type row and
  in concepts that `session` is a hint, or score `session` by topics only and keep repo names for
  `sessionLabels`/the rank.
- **S3 (NEW): `MessageResult.to` may not resolve back.** Session name = `name`, else repo name,
  else sid[0..8]. `findSessionOn` matches `session.name` exactly or a sid prefix of at least 4
  characters, never the repo name. A reply `m2/alpha` for an unnamed session cannot be passed to
  `mesh say` again. Either say the reply is for display only, or build it from the name, else the
  sid prefix.
- **S4 (NEW): some CLI argument combinations are not specified.** The usage row does not cover:
  - `mesh assign <G>` with neither `--to` nor `--suggest`: is the stderr the old one-line usage or
    the new two-line usage?
  - `--json` without `--suggest`.

  Name both, so a blind test does not have to guess.
- **S5 (NEW): a goal with no offerable step gets a hint that fails.** In that case suggest ranks
  by `primaryRepo` and still prints `Assign with: mesh assign <G> --to <to>`. That command then
  gets 409 `<G> has no ready step to offer` unless `--stick` is given. Print
  `… --to <to> --stick` in that case, or a line that says no step is ready now.
- **S6 (NEW): `team=1` exposes others' machines; say so in the docs.** With `team=1` any member
  learns whether a teammate's machine has a given repo, since any repo string can be put on a
  goal and suggested. They also learn its matching machine labels. The design accepts this
  ("with `--team`, everyone's … repo present"). The Docs row for concepts should still say it, next
  to the existing visibility rules. Only the yes/no is exposed, never the inventory list.
- **S7 (NEW): AC-13 leaves two behaviours untested.**
  - The launched session, once seen holding the step, replaces its pending place. It must not be
    counted twice. Add a case: launch with `maxSessions: 2` and one live session. The launched
    session appears holding the step. A new offer then does not launch, and is listed because 2
    are live, not 3.
  - "the person gets the MM-3 notification" holds only when notifications are on
    (`notifyChannels(config).any`). Say so in the AC.
- **S8 (NEW): name the source of the session list.** For the "visible session" definition, name
  the session source the resolver uses: `listSessions({live: true})` plus `state !== "ended"`.
  Suggest, `say` and assign then agree on which records exist.

## Summary

The spec is close. It is precise about texts, rank, privacy filtering and routes, and it matches
the MM-3 code it reuses. Three blockers remain: two acceptance criteria cannot fail (AC-02 rank
position, AC-13 "may launch"), and one compatibility statement contradicts the hub's catch-all
route.
