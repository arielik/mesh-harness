Verdict: CHANGES REQUESTED | Round: 2 | Blocking-open: 2

# Diff review of RL-1, round 2

Reviewed: `git diff feat/relay-design...comb/RL-1` (comb/RL-1 at 9f9886b; impl/RL-1 at 49de911 and
test/RL-1 at eccce0d combined) against `docs/specs/RL-1.md` (revision 2 plus the dated Open
questions, three of them new this round). I read the earlier rounds first: `r1-changes-requested.md`,
`r2-approved.md` (spec reviews) and `diff-r1-changes-requested.md`. Then I read the changes since
round 1 (`git diff eca019f comb/RL-1`: fe430c4, 620083c, e88a823, 49de911, eccce0d) and re-checked
them against the whole diff.

comb/RL-1 is red: `pnpm test` fails two tests. Both failures come from the developer's repairs of
round-1 suggestions S1 and S2. AC-34 needs `pnpm check` to pass, so it fails too.

## Checks

I ran these on an export of comb/RL-1 (`git archive`, in a scratch folder, not in the integration
worktree):
- `pnpm install --frozen-lockfile --prefer-offline`: ok.
- `pnpm lint`: pass.
- `pnpm typecheck`: pass.
- `pnpm boundaries`: pass (178 modules, 625 dependencies, no violations).
- `pnpm test`: **fail**. 69 files; 2 failed, 1351 passed, 68 skipped. The skipped tests are the
  Postgres legs, because `MESH_TEST_PG_URL` is not set. The failures:
  - `test/relay-daemon.test.ts` > `test_AC39_no_delivery_to_the_run` (B1).
  - `src/core/redact.test.ts` > `test_AC13_order_and_count` (B2).
- `pnpm build`: pass.
- `pnpm schemas`: the regenerated `schemas/hub-api.openapi.json` is byte-identical to the
  committed one.
- Fail-first for the test-writer's new edit in `test/m2-flow.test.ts` (eccce0d): I ran it on an
  export of the base (feat/relay-design). It fails there ("exposes the eight tools …"), as it should,
  because the base has no `mesh_artifact`.

I did not run:
- `pnpm check` as one command. I ran its five parts one by one.
- the Postgres contract and World legs (no Postgres available). The `serialize()` added to
  `saveProfile` is reviewed by reading only.
- fail-first for the two other test edits in eccce0d:
  - The `ping-Z` assertion in AC-39 is in a test that already fails on the base as a whole.
  - The AC-34 edit removes an assertion and adds none.
- the real `claude` binary (never run).

## Round-1 findings: status

| Round 1 | Status |
|---|---|
| B1 AC-34 source-text check | Fixed (eccce0d). The loop is gone, and placement is proven by module exports. |
| B2 developer edited `m2-flow.test.ts` | Fixed. The developer reverted it (fe430c4), and the test-writer made the edit (eccce0d), which fails first on the base. |
| S1 finished run's session muted forever | Repaired in 620083c, but the repair breaks AC-39. See **B1**. |
| S2 redaction double count | Repaired in e88a823, but the repair contradicts the spec and AC-13. See **B2** and S10. |
| S3 AC-39 conditional check | Fixed (eccce0d). `ping-Z` is now asserted with no condition. |
| S4 upload `sid` not checked | Fixed (49de911). It uses `callerMachine` + `refuseForeign`, like `doneStep`. There is no test for it (S8). |
| S5 artifacts in the next holder's round | Recorded as a dated Open question. Closed. |
| S6 group leftovers after the leader exited | Fixed (620083c). `reapGroup` runs after an end this daemon saw, and only signals members whose environment carries `MESH_RUN=<runId>`. It is Linux only, and an Open question records that. Closed. |
| S7 profile ownership race | Fixed (49de911). `store.serialize()` runs before the read inside `store.tx`, the same pattern as the other read-check-write paths. Closed. |

## Blockers

### B1 (REGRESSION-OF-OWN-REPAIR, impl) A run's held messages are failed the moment the run ends

Files:
- `src/daemon/daemon.ts`: `held()` and the two loops in `deliverPending`.
- `src/daemon/runs.ts`: `finishedRunEnd`.

The repair of S1 does two things:
- `held(sid)` is true for a finished run only while the session is **ended or gone**.
- The TTL check is still `now - m.createdAt > MESSAGE_TTL_MS`.

Consider a message that waited more than an hour while the run was running, which is the normal
case for a long run. When the run ends while its session is still listed as alive, `held` is
false. That happens in AC-39's own setup, and with a person who `claude --resume`s the run. The
first `deliverPending` loop then settles the message as `failed` ("not delivered within an hour")
at once.

I confirmed it on the export. At the end of `test_AC39_no_delivery_to_the_run`, the daemon store
has `ping-X` and `ping-Z` both `failed / not delivered within an hour`, and session 7 is `idle`.
`pendingMessages(s7)` is `[]`. So:
- AC-39's "the messages are still in the inbox after the run ends" fails. This is the assertion
  at line 1180, which passed at round 1.
- The developer's own Open question is not met. It says "a session resumed with
  `claude --resume <sessionId>` … gets them", but it never does, because the messages are already
  failed.

Expected:
- For a message held because of a run, measure its TTL from the later of `createdAt` and the
  run's end. For example, in the first loop settle only when
  `now - Math.max(m.createdAt, this.runs?.finishedRunEnd(m.sid) ?? 0) > MESSAGE_TTL_MS && !this.held(m.sid, now)`,
  and use the same age in the second loop's skip.
- Then a run's messages:
  - stay pending until an hour after the run ended when the session is ended or gone;
  - are delivered normally when the session is alive or resumed.
- `test_AC39_no_delivery_to_the_run` must pass unchanged. The developer must not edit it.

### B2 (REGRESSION-OF-OWN-REPAIR, impl + spec) `redactSecrets` no longer matches its spec, and AC-13 is red

File: `src/core/redact.ts` (e88a823).

The spec's contract for `redactSecrets` (`docs/specs/RL-1.md`, the block after its signature) says:
- the passes run "in this order": PEM, tokens, assignments, then literals;
- the function "counts one per replacement".

The test plan's assumption A1 pins what follows from that: `token=ghp_…` gives `count: 2`.
`test_AC13_order_and_count` asserts exactly that.

The repair changed two things:
- The order is now PEM, literals, tokens, assignments.
- An assignment whose value is already redacted is not counted.

So the test now gets `count: 1` and fails. The spec text was not amended, and no Open question
records the change.

My round-1 S2 suggested the count-once behaviour. It was a suggestion against the spec as written,
so it needed the spec, the test and the code to change together. A code-only change cannot do
that.

Expected: choose one and keep all three in step.
- (a) Revert e88a823, so the code follows the spec contract again (count 2). Record "a token
  inside an assignment is counted twice" as a dated Open question.
- (b) Keep count-once, and:
  - amend the spec's `redactSecrets` contract (the new order, and "an already-redacted value is
    not counted again");
  - add a dated Open question;
  - have the **test-writer** (not the developer) change `test_AC13_order_and_count` to
    `count: 1`, and add the round-1 case `secret=<literal>` → `count: 1`. Both must fail first on
    the round-1 code (eca019f).

## Suggestions (non-blocking)

### S8 (NEW, test) The round-1 repairs have no tests

These repairs are untested:
- the 403 for a foreign `sid` on `POST /v1/steps/:id/artifacts` (49de911);
- delivery to a resumed run session after the run finished (620083c);
- `reapGroup`, which signals only `MESH_RUN` members (620083c).

None of them is an acceptance criterion, so this does not block.

Expected: the test-writer adds the following, each failing first on eca019f:
- in `test/relay-hub.test.ts`: an upload with another user's `sid` gives 403
  `session <sid> is not yours on this machine`, and no `step.artifact` event;
- in `test/relay-daemon.test.ts`: after a run ends with its session alive, a held message is
  delivered and not failed.

### S9 (REGRESSION-OF-OWN-REPAIR, impl) An assignment value that only starts with a redaction keeps its tail

File: `src/core/redact.ts`, assignment pass: `if (value.startsWith(MARK)) return m;`.

Before the repair, `password=<literal>tail` became `password=[REDACTED]`. Now the literal pass
gives `password=[REDACTED]tail`, and the assignment pass returns that unchanged, because the value
starts with `[REDACTED`. The same happens with `token=sk-ant-…` followed by characters outside the
token class. The tail leaks.

Expected (only if B2 goes with option b): return `m` unchanged only when the whole value is a
redaction mark (`/^\[REDACTED[^\]]*\]$/`). For any other value that contains a mark, redact the
whole value without counting it.

### S10 (REPEAT, process) impl/RL-1 still carries the developer's version edit to `test/schemas.test.ts`

impl/RL-1 still differs from the base in `test/schemas.test.ts` (16a1ffb: `0.1.14` → `0.1.15`).
The combine drops it, so it has no effect on comb/RL-1. Round 1 noted it with no request.

Expected: the developer drops it from impl/RL-1 next time the branch is touched, so a later
combine cannot pick it up.

### Process note

comb/RL-1 (5) was combined while two tests were red. The merger should run `pnpm test` (better:
`pnpm check`) before it hands a combine to review.

## What I checked and found right (changes since round 1)

- **Auth.** The upload's `sid` check runs after the holder check and before any write. With a
  machine token it also refuses a session of another machine.
- **Postgres parity.** `saveProfile` takes `store.serialize()` inside `store.tx` before
  `getProfile`, like `goalTx`. SQLite's single writer already serialises.
- **Races.**
  - `detectEnd` is reached only while `endedAt` is undefined, so `reapGroup` runs at most once per
    run.
  - The `MESH_RUN` environment check keeps a reused process group id from being signalled.
  - A run reaped after a restart is still never signalled.
- **Idempotency.** Unchanged since round 1.
- **Role separation.**
  - eccce0d (test-writer) touches only `test/` files.
  - The developer's commits since round 1 touch only `src/` and the spec's Open questions. The
    exception is fe430c4, which only reverts the developer's own earlier test edit. That revert
    is the requested remedy for round-1 B2.
- **No assertion on source text.** The new and changed tests read only run outputs, fixtures and
  `package.json`'s version, which AC-34 allows.
- **Docs.**
  - Three new dated Open questions (S1, S5, S6).
  - `concepts.md` and `howto.md` need no change for these repairs.
  - The `redactSecrets` contract needs one (see B2).
  - No team-, company- or person-specific names were added.
