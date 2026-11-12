Verdict: APPROVED | Round: 2 | Blocking-open: 0

# Review of spec RL-5, round 2

I reviewed `docs/specs/RL-5.md` at f6170e3 (revision 1) cold. I read round 1
(`r1-changes-requested.md`) first. I checked the spec against
`docs/analysis/2026-11-12-pulse-relay-roster.md` (REQ-11, REQ-12, R-4, R-6, §3, §5.1, §5.10, §6, §7) and
against this code on `feat/relay-design`:
- `src/hub/service.ts`: `proposePlan`, `approvePlan`, `applyApproved`, `replan`, `createGoal`,
  `snapshotProfiles`, `createPulse`, `updatePulse`, `pulseView`, `goalFromPreset`, `createWithPlan`,
  `fireSlot`, and the event text switch
- `src/protocol/pulse.ts` (`Pulse`, `PulseView`), `src/protocol/goal.ts` (`Goal.profiles`,
  `StepPolicy.agent`, `HEADLESS_DEFAULTS`), `src/protocol/hub-api.ts` (rules, scopes, tags)
- `src/store/hub-store.ts` (stored `share`, pulse and goal `value` JSON parsed with zod)
- `src/core/repo-id.ts`, `src/core/visibility.ts`
- `src/daemon/git.ts` (`repoForCwd`, `parseRemotes`), `src/daemon/repos.ts` (`findCheckouts`,
  `repoInventory`, `REPO_INVENTORY_MAX`), `src/daemon/daemon.ts` (`machineRepos`, rescan), and
  `test/helpers/world.ts` (it makes real git checkouts)

## Checks

This is a spec review, so there is no code to build. I did not run `pnpm lint`, `pnpm typecheck`,
`pnpm boundaries`, `pnpm test`, `pnpm build` (together `pnpm check`), `pnpm schemas` or
`pnpm test:web`. The Postgres legs of the store contract were not run either. I used only `git`,
`grep`, `sed`, `cat` and file reads. I did not run the `claude` binary.

## Round 1 findings

| R1 | Status | Where |
|---|---|---|
| F1 (blocker) R-6 deferred | **Fixed.** `Goal.agents` and `Pulse.agents` hold a full `AgentDef`. The spec pins on pulse create, on a `preset`/`params` update (the same point as `snapshotProfiles` in `updatePulse`), on `from-preset`, on slot fire (copied from the pulse) and on `approvePlan`. Offers only copy the pin. AC-19 and AC-25 can fail on a fire that follows a later push. Repo agents stay unpinned, and the Open questions say why. | Hub behaviour "Pins (R-6)", "Offers"; AC-19, AC-25 |
| F2 (blocker) working-tree pushes | **Fixed.** Pushes read only committed blobs, from `refs/remotes/<R>/HEAD` or else `HEAD`, and only move forward (`merge-base --is-ancestor`). AC-09 covers uncommitted and untracked files, a new commit, `origin/HEAD`, and two daemons converging. | "Daemon catalog push"; AC-09 |
| F3 `source` of the lock | Fixed (always the full repo id). | Types, CLI; AC-13 |
| F4 `gone` on any failure | Fixed (`gone` only for the `no agent` 404). | CLI; AC-14 |
| F5 sync rules without AC | Fixed (inventory filter, hiding under stored `steps` or no stored share). | Sync, Visibility; AC-05 |
| F6 sibling rules files | Recorded as a limitation in Out, Open questions and the concepts doc. | |
| F7 ids a key cannot express | Fixed for characters (422 at registration). See N1 for length. | Routes; AC-07 |
| F8 push size | Fixed (8 000 000 characters, 422). | Routes; AC-08 |
| F9 diff format | Fixed (always `,n`; `-` before `+`; the 6/7-line hunk rule). | `unifiedDiff`; AC-02 |
| F10 "no file read" | Fixed (stated as what is sent). | AC-05 |
| F11 key collision with RL-1 | Recorded in Open questions. | |

No round 1 finding is still open, so there are no REPEAT findings.

## What I verified against the code

- **Pin points.** `createPulse`, `updatePulse` (only when `preset` or `params` changes), `goalFromPreset`
  and `fireSlot` → `createWithPlan` are the places `profiles` are snapshotted or copied today, so the
  `agents` snapshot fits beside them. `approvePlan` runs inside `goalTx`, so a 422 rolls back the
  `approved` save and the plan stays pending, as the spec says. `replan` creates no plan, and
  `createGoal` creates none either, so every other approved plan goes through `approvePlan`.
- **Storage.** `Pulse` and `Goal` are zod objects stored as `value` JSON. A new optional or defaulted
  field needs no column, and old rows parse. `pulseView` destructures `profiles`, so the spec's
  `PulseView.agents` (policy string to hash) needs the same treatment there. The spec states this.
- **Third-party default profile** (design §7): `HEADLESS_DEFAULTS.profile` is already `read-only`
  for every headless step, roster steps included.
- **Visibility.** The spec hides a machine's copies from its own user when the stored share is `steps`
  or absent. `sessionVisible` does not hide them from the user. The difference is deliberate (R1 F5),
  and the spec states it.
- **Remote choice.** "`origin`, else the first" matches `repoForCwd`, and `parseRemotes` keeps config
  order.
- **Registration grammar.** `repoFromRemote("https://git.example.com/team/a~b.git")` gives
  `git.example.com/team/a~b`, which fails the documented grammar, so AC-07's 422 is reachable.
  `"nope"` gives `undefined` and fails the fallback pattern.
- **Routes.** `member` covers device tokens (`/v1/sync` uses it), so the daemon can call
  `GET /v1/agents/resolve`. The tags and scopes exist in `HUB_API`.

## Findings

None is a blocker. All are suggestions.

### N1 (suggestion, NEW): the 200-character key cap breaks the daemon's own run-time key for long source ids

`parseRosterKey` rejects keys over 200 characters. The daemon resolves
`<agentDef.source>/<agentDef.name>@<64-hex hash>`, which is `|source| + |name| + 66` characters.
Registration bounds `repo` only by the body's 300 and by the grammar, not by this sum. Example: a
100-character source id (deep subgroup paths reach this) and a 40-character agent name. The short key
`agents/x` validates and pins at approval, but every run then fails to start with
`roster agent … is not available: agent key must be …`. `mesh agent outdated/diff/update` also resolve
`<entry.source>/<name>`, so they hit the same cap a little later.

Fix (either one):
- Raise the cap to cover the longest key the system builds: 300 (source) + 1 + 64 + 1 + 64 = 430.
  `StepPolicy.agent` then needs the same bound.
- Reject ids at registration whose length is over 200 − 1 − 64 − 1 − 64 = 70. This is too
  restrictive; I prefer the first option.

Add an AC-01 or AC-11 case with a source id of at least 100 characters.

### N2 (suggestion, NEW): the order of the catalog push and the inventory sync within a rescan is not stated

The push route answers 403 when the machine's **stored** inventory lacks the repo. The spec does not
say whether the push of a rescan happens before or after the sync that carries that rescan's `repos`
is accepted. In AC-09, a daemon that has just gained the checkout can therefore get a 403 on its first
push, log it, and store `rev` only one rescan later. The test will then wait for one or two rescans
depending on the implementation, and "a rescan without changes makes no push call" becomes
order-dependent. State that the push runs after the sync carrying the rescan's `repos` was accepted
(or on the next tick after it).

### N3 (suggestion, REGRESSION-OF-OWN-REPAIR, from the F2 fix): AC-09's `origin/HEAD` case contradicts the forward-only rule when it runs in sequence

AC-09 lists its cases as one story: push HEAD (no `origin/HEAD`), then an edit, then a commit. It
then adds "with `refs/remotes/origin/HEAD` pointing at a commit older than HEAD, the pushed commit and
texts are the `origin/HEAD` ones". On the same source, the stored commit is now HEAD (or later). The
older `origin/HEAD` commit does not descend from it, so step 2 skips the push and logs
`… does not descend from …`. A test writer who follows the AC in order sees no push and has to guess.
Say that this case starts from a fresh source with no stored `commit`. Alternatively, add the inverse
assertion explicitly: on the same source, the push is skipped with the documented log line.

### N4 (suggestion, NEW): forward-only is enforced only by daemons, so concurrent first pushes can still move a source back

Step 2 runs on the daemon, against the `commit` it read from `GET /v1/catalog-sources`. Suppose two
daemons both read "no commit", and C2's push lands before C1's. Then C1 overwrites C2, and `current`
flips back until C2's next rescan. During that time a pulse create or plan approval pins the older
definition. AC-09 runs the daemons in sequence, so it does not cover this. A small fix: `CatalogPush`
gains `base?: 40 hex`, the stored commit the daemon saw (absent when there was none), and the hub
answers 409 `catalog source <repo> moved to <commit7>` when `base` differs from the stored `commit`.
The daemon treats that 409 as a skip until the next rescan. If the race is accepted instead, record it
in Open questions.

### N5 (suggestion, NEW): AC-10's "versions ordered by copies" cannot fail in its fixture

In the AC-10 fixture each version (H1 alpha, H2 beta, H3 catalog) has exactly one copy. "Two machines
reporting the same `alpha` copy" merges into one copy with `machines: 2`, so the count is still one.
The ordering by count is never exercised, and only the hash tie-break decides. Give one version two
copies, for example a repo `gamma` that also holds `reviewer` at H1. Then assert that H1 comes first
even when its hash sorts last.

### N6 (suggestion, NEW): `agents.reported {machine, count}` reveals activity of a `me` machine

Under `me`, the machine's copies are hidden from everyone else. The event feed, however, carries the
machine id and the number of agent files it reported each time they change. MM-1 emits no event for
inventory changes. Either drop the event, or leave out `count` and state who sees the event, in line
with the share level.

### N7 (suggestion, NEW): `mesh agent outdated` does not say whether a failure stops the run

"A resolve failure other than … → prints that text and no status line, exit 1" does not say whether
the remaining entries are still checked and printed. When the hub is unreachable every entry fails,
so AC-14 cannot tell the two behaviours apart. State one of them. I suggest stopping at the first
such failure, which is simplest and matches "no status line". Add a case where only the second
entry's resolve fails (a 409).

## Scope

The spec stays inside S5 plus the R-6 work that RL-3 deferred to S5. The new `PulseView.agents` and
`Goal.agents` fields are the minimum that R-6 needs. Stats, Roster metrics, TUI views, source removal
and the pinning of repo agents are left out, and the reasons are recorded.

## Summary

The 2 blockers of round 1 (F1, F2) are fixed, and the 9 round 1 suggestions are fixed or recorded.
This round has 7 suggestions and no blockers: N1, N2 and N4 to N7 are NEW, and N3 is a
REGRESSION-OF-OWN-REPAIR (from the F2 fix). There are no REPEAT findings. N1 and N3 are cheap to fix
before the test-writer starts, and I recommend fixing them.
