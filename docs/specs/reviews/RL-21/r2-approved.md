Verdict: APPROVED | Round: 2 | Blocking-open: 0

# Review of the RL-21 spec, round 2

Cold review of `docs/specs/RL-21.md` at 159e824 (revision 2), against the diff from 12e5589 and the
code: `src/hub/app.ts`, `src/hub/service.ts` (`assignStep`, `offerStep`, `markAccepted`,
`headlessGuard`, `acceptStep`, `claimStep`, `deciderOf`, `runReport`, `slotStarted`, the tick,
profile registration), `src/core/{claims,profiles,session-state}.ts`, `src/daemon/{daemon,runs,tools,hub-link}.ts`,
`src/store/hub-store.ts`, `test/relay-run-session.test.ts`, and the hub tests that accept or claim
headless steps (`test/pulse-hub.test.ts`, `test/assign.test.ts`, `test/relay-hub.test.ts`).

## Round-1 findings

**B1. RESOLVED.**
- (a) The hub now refuses `409 offer-headless` on `accept` with a `sid` and on the accept branch of
  `claim` (RL-21.md:172-178). The existing run flow is unaffected: the daemon accepts without a sid
  (runs.ts:518), and its bind claim (daemon.ts:956) arrives when `offer.state` is already
  `accepted`, so `claimStep` takes its first branch (service.ts:2794), not the accept branch
  (service.ts:2797-2799). Existing hub tests accept headless run steps without a sid
  (pulse-hub.test.ts:485, :783 and others), and the `assign.test.ts` accepts with a sid are on
  interactive steps.
- (b) "Run-held" = declared headless, or an accepted headless offer **and** a holder session with
  `kind: "print"` (RL-21.md:180-188). I checked that a run's session really has that kind at the
  hub. `applyRunSession` sets `kind = "print"` (session-state.ts:475). The reconciler keeps it for
  the same pid (session-state.ts:274-275). A hook that arrives first is merged into the same record
  by the run's Claude session id (session-state.ts:462, runs.ts:535/653). Step holders are synced as
  full records, kind included, at every share level (hub-link.ts:91-94). A test already asserts
  `kind: "print"` (relay-run-session.test.ts:107). The case where the bind claim reaches the hub
  before the session row does is harmless: the tick needs `hs` to pause (service.ts:7034).
  Interactive re-holds (fail, resume, plain claim, paused re-claim) bind an interactive sid, or no
  sid (`hold` deletes `holderSid`, claims.ts:22-23), so they are not run-held.
- (c) AC-18 and AC-19 cover both paths.

**S1. PARTIAL.** A `steps:assign`-only token can no longer name another member's registered
profile (RL-21.md:151-154, AC-20). A residual is left; see N4.

**S2. RESOLVED.** The `failed` row and the `goals:read` / join-key notes were added (RL-21.md:230-234).

**S3. RESOLVED.** The nickname clause was dropped. AC-05 adds the two missing-session forms (which
must return 403, not 404) and `share: all`. The open question was replaced.

**S4. RESOLVED.** Each place that branches on mode has a decision, deliberately left on the
declared mode and documented (RL-21.md:190-194).

**S5. RESOLVED.** `400 headless-stick` (RL-21.md:145-146). See N1 for an AC that contradicts the
rights order.

**S6. RESOLVED.** The prefix stays and ` (via <service>)` is appended (RL-21.md:203-206, AC-22).
The daemon's title regex (daemon.ts:834) stops at `" (repo `, so the suffix does not affect it.

**S7. RESOLVED.** `onBehalfOfRequired` is on both types, the OpenAPI generator documents it,
`offerStep` returns the message id, `headlessGuard` takes an optional argument, and AC-03 sends
`" "`.

**S8. RESOLVED.** AC-21.

## New findings (none blocking)

**N1. AC-20's stick clause contradicts the rights order.** AC-20 sits under "Profile choice under
act-for" and expects `stick: true` with `mode` → `400 headless-stick`. Under act-for, §Rights
step 2 refuses `stick: true` first with `400 on-behalf-of-option` (RL-21.md:104-106), and
headless checks only run in step 5. Fix: test that clause with ann's **own** token. Optionally add
that act-for `stick` + `mode` gives `on-behalf-of-option`.

**N2. `offer-headless` also changes the declared-headless path. Say so, and cover offers that are
open across the upgrade.**
- `mesh_claim` has no headless check (tools.ts:390-392), unlike `mesh_accept` (tools.ts:385).
  Today, a `mesh_claim` from a session on the target machine of an offered **declared** headless
  step binds it into that session. A claim with no sid from the target's machine token does the
  same. Both now get 409. This is correct (it closes the same gap as B1), but Compatibility should
  list it as an intended change.
- An offerer who targeted their own machine now hits the accept branch first
  (service.ts:2797, before the offerer/withdraw branch at :2801). Their claim gets
  `offer-headless`, not a withdraw. The error text should end with
  `withdraw it first (mesh withdraw <id>)`.
- Offers made before the upgrade have no `offer.mode`. The hub check would let a declared one
  through, leaving only the daemon's guard. Testing
  `offer.mode === "headless" || step.policy?.mode === "headless"` closes that.

**N3. Run-held: implementation notes.**
- `deciderOf` (service.ts:1322) is synchronous. It needs the holder session row, so it becomes
  async, or `submitReview` passes the session in.
- The daemon's fallback bind from a tool call (daemon.ts:1120-1123) passes `sid` of an existing
  session. The `own` branch of `applyRunSession` (session-state.ts:452-460) keeps that session's
  kind (`unknown`, or `interactive` after the reconciler). An overridden run bound only through
  that path is therefore not run-held: the tick may pause it after `pauseGraceMs`, and its review
  gets a person decider. This is rare, because the normal start path sets `print`. Either accept
  it and say so in the spec, or set `kind = "print"` in the `own` branch (a one-line daemon change;
  today the spec says "Daemons: no change").

**N4. S1 residual: who "owns" a registered profile.**
- `POST /v1/profiles` under act-for stores `createdBy = <person>` (service.ts:953-960). So any
  service with `profiles:write` (auth.md's example `writer` token) can register a profile with
  arbitrary `allow` entries "as ann". A `steps:assign` service can then name it, and it passes
  `profile-not-yours`.
- An admin can replace a profile's content and keep its `createdBy` (service.ts:953).
- The built-in `propose-via-branch` (profiles.ts:43-53) lets a `steps:assign`-only token turn any
  interactive step into an unattended edit, commit and push run on the person's machine (with the
  person's `self` rule).
- None of these exceeds what the admin who minted the tokens granted, and pulse act-for has the
  same reach. Recommended: state this in auth.md ("`steps:assign` lets the service choose a
  built-in profile, or one registered for the person, including by a `profiles:write` service").
  Optionally record `via` on a profile written under act-for, and exclude such profiles here.

**N5. The HX5 "listed" row for a headless offer.** A headless offer that is not auto is listed
(daemon.ts:852-853), and nothing the owner can do starts it. `acceptLocal` and `mesh_accept`
refuse declared steps (daemon.ts:997, tools.ts:385). The hub now refuses accepts with a sid, and
the daemon runs only auto offers. So for a headless offer, "listed" means it waits until it is
declined, withdrawn or expires. Say that in the outcome table, so a dashboard does not show
"waiting for the owner" as something the owner can act on.
