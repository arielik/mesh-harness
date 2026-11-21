Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 1

# Review of the RL-21 spec, round 1

This is a cold review of `docs/specs/RL-21.md` (commit 12e5589 on `spec/RL-21`). I checked it against
`src/hub/app.ts` (routes, the per-route middleware, `onError`), `src/hub/service.ts` (`actingFor`,
`assignStep`, `assignGoal`, `resolveTarget`, `findMachine`, `findSessionOn`, `callerMachine`,
`offerStep`, `emitReady`, `autoFor`, `headlessGuard`, `suggestView`/`suggestStep`, `offers`,
`acceptStep`, `claimStep`, `resumeStep`, `releaseStep`, `takeStep`, `doneStep`, `deciderOf`,
`runReport`, `ack`, the tick), `src/core/{roles,suggest,offers,visibility,claims,dag,calibration,profiles}.ts`,
`src/protocol/{hub,hub-api,goal,pulse}.ts`, `src/store/hub-store.ts`, `src/daemon/daemon.ts`
(`handleOffer`, `acceptLocal`), `src/daemon/runs.ts` (`handleOffer`), `src/daemon/tools.ts`, and
`docs/guide/auth.md`. No earlier review of RL-21 exists, so every finding is new.

## What holds

- **The rights rule is sound for machines and sessions.** "Resolve with today's resolver, then compare
  ids on the resolved rows" closes every name form I tried. `findMachine` (service.ts:592-600) uses
  `actor.userId` for the bare-nickname step, and under act-for that is the person, so a bare nickname is
  always the person's own or an exact machine id (refused when foreign). `<other>/<nick>` and the
  3-part form resolve through `machineByNickname(user, nick)`, an exact `=` (hub-store.ts:666-668), so
  `Bob/box` is a 404 and `bob/box` is bob's row, refused. Nicknames are lowercase, contain no `/` and
  cannot look like a machine id (`nicknameOk`, protocol/hub.ts:103-110), so a nickname cannot shadow an
  id or a 2-part form. With the machine check placed before `findSessionOn`, a session part can never
  be probed on a foreign machine (no session-existence oracle), and `findSessionOn` already filters to
  `hs.machineId === m.id` (service.ts:610-612).
- **The session check is needed and correct.** `upsertSession` updates `machine_id` on a sid conflict
  but keeps the first `user_id` (hub-store.ts:671-680), so a row with `machine = ann's, user = bob` can
  be built by a sid collision; `hs.userId !== person → session-not-yours` covers it, and the
  machine-first order covers the converse (`user = ann` on bob's machine).
- **The `sid` and `stick` refusals are the right ones.** With no `machineId`, `callerMachine(actor, sid)`
  would turn a person's own sid into a `byMachine` (service.ts:583-585), which can satisfy a
  `machine:<x>` rule and redirects `reportBack`; `stick` would persist `by = person` without `via` for
  every later `emitReady` offer (service.ts:756). Refusing both is necessary.
- **Admins and service accounts.** `actingFor` returns `roles: ["member"]` and refuses a user with the
  `service` role (service.ts:2146-2147); `assignStep` has no role branch, so AC-07 holds. Acting for a
  person also grants *less* than the person's own token (own machines only), which is the safe side.
- **Idempotency** is keyed `<via>><person>` (app.ts:581) before the handler runs, so a replay never
  crosses persons; AC-16 tests it.
- **Scope choice.** `goals:write` is on the example tokens in auth.md:45 and :59 and creates
  service-owned goals only; folding assign into it would silently widen every existing token. A new
  `steps:assign`, available only on a newly minted token, is the right call. `onBehalfOfRequired` on
  suggest is needed: without it a `steps:assign` service with no header would run suggest as the
  service account, and `team=1` would list every machine (service.ts:1970).
- **Codes are additive.** `onError` (app.ts:546) only gains a field; the existing `error` texts stay.
- **Information leaks** through refusal order (`step-offered` names the current target, 403 vs 404
  tells whether a foreign machine exists) stay within what the person can already see (suggest
  `team=1`, `/v1/live`), so the service gains nothing beyond the person's rights.

## Blocking

**B1. "Effective headless" keyed on the accepted offer's `mode` misclassifies interactive holds.**
The spec makes a step with an accepted `offer.mode: "headless"` headless for the tick and for
`deciderOf` (RL-21.md:158-166). It argues that a later interactive hold is unaffected because the
accepted offer is removed "on release, reopen and takeover". Two paths break this:

1. *An overridden headless offer can be accepted interactively.* The daemon lists a headless offer
   that is not `auto` (daemon.ts:852-853: `if (d.auto !== true) return await listed()`). The only
   guards against binding a headless step to a session check the **declared** mode:
   `acceptLocal` (daemon.ts:997) and the accept/claim tool (tools.ts:385) test
   `st.policy?.mode === "headless"`. For an overridden interactive step they pass, and the hub accepts:
   `acceptStep` (service.ts:2005-2016) and `claimStep` (service.ts:2797-2799, a claim from a session on
   the target machine) both call `markAccepted`, which keeps `mode` on the offer. The person then works
   in an interactive session that the tick never pauses when it ends (service.ts:7034), and their
   review decisions are recorded with an **agent** decider (service.ts:1323). The listed case is
   common: it happens on any machine whose accept policy does not match, for example a member's
   own-token override to their own machine with `accept` unset, or an act-for offer to a machine
   without `self`.
2. *The accepted offer survives other re-holds.* `doneStep` with outcome `failed` keeps the accepted
   offer (service.ts:2983), `resumeStep` moves the step to `blocked`/`ready` without removing it
   (service.ts:3076-3091), and a plain claim of a ready step keeps `s.offer` (`hold`,
   core/claims.ts:19-25, via `claimInTx`). A paused step (holder machine offline) re-claimed by the
   same user from an interactive session also keeps it (claims.ts:31). The removal sites the spec
   cites (service.ts:414/423/2571/2817/3121, dag.ts:228) do not cover these.

Required:
- (a) The hub refuses an interactive accept of a headless-mode offer. `acceptStep` with a `sid`, and
  the accept branch of `claimStep`, answer 409 (a new code, e.g. `offer-headless`) when
  `offer.mode === "headless"`. A run accepts without a sid (runs.ts:518) and then binds with a claim
  on a step that is already held, so it is unaffected. The check is on the hub, so it covers old
  daemons, and "Daemons: no change" stays true.
- (b) Either clear an accepted headless-mode offer on `resumeStep`, on any claim that is not an
  accept, and on a re-claim of a paused step, or define effective headless more narrowly (for example,
  an accepted headless offer **and** a `run.started` event for the current round).
- (c) ACs:
  - An overridden headless offer that is not auto, accepted with a sid, gets 409, and the step stays
    offered.
  - A failed overridden step that is resumed and then claimed interactively is paused by the tick when
    its session ends, and its review record has a person decider.

## Suggestions

**S1. Under act-for, the service, not the machine owner, picks the run's permission surface.**
The spec justifies the own-machine rule with "choosing the permission surface of a run is the machine
owner's choice" (RL-21.md:143-145). Under act-for, though, the service chooses the `profile`:
- A registered profile may add arbitrary `allow` entries (`compileProfile`, core/profiles.ts:66-75).
- Any member can register profiles, and a `profiles:write` service can register one for a person.
- With the person's `self` rule, `autoFor` gives `auto = true` (core/offers.ts:31), and the daemon
  starts `claude -p` with no person present (daemon.ts:852-866).

So a token that holds only `steps:assign` can turn any interactive step into an unattended run under
any registered profile. There is precedent: `pulses:write` act-for already runs a `PresetSnapshot`
the service supplies on the person's machines (protocol/pulse.ts:58-61). That path, however, pins
profiles in the goal snapshot (RL-3).

Recommend: under act-for, `profile` must be the step's declared one, a key of `goal.profiles`, or a
built-in (or a registered profile `createdBy` the person). Refuse anything else with a code (for
example `on-behalf-of-option`), and add an AC. Also state in concepts.md that a `self` rule now
auto-accepts offers a service makes for the person, and consider a later opt-in rule (for example
`via:<service>`).

**S2. The HX5 outcome table misses `failed`.** `ackOffer` also sends `state: "failed"` with the error
text as `method` (daemon.ts:829, :845; runs.ts:500, :508, :520: no valid profile, accept refused,
decline refused). Add a row: `message.delivered` with `state: "failed"`, `method` = the reason, and
the offer still `offered` until it expires. Also note that:
- reading `GET /v1/steps/:id` needs `goals:read` on the token, which a `steps:assign`-only token lacks;
- `message.delivered` carries no step id (service.ts:3272), so the `message` reply field is the only
  join key.

**S3. AC-05's nickname clause cannot be set up through the API.** The API refuses "ann having a
machine whose nickname equals bob's machine id" (`nicknameOk`, protocol/hub.ts:108-110). Either say
the test sets it up with a store insert (as AC-06 does) or drop it. Open question 2 is moot for the
same reason. Add to AC-05:
- `bob/box/<a sid that does not exist>` gives `403 machine-not-yours`, not a 404. This proves the
  check runs before the session lookup.
- bob's machine has `share: all`, so the session part names a session that ann's own token could see.

**S4. Name the other places that branch on `step.policy.mode`.** Besides the tick and `deciderOf`:
- The run brief's Grep/Glob fallback hint (tools.ts:151) is missing for an overridden run with the
  `read-only` profile, which is exactly the case that needs it.
- Run cards and efficiency report `mode: "interactive"` (service.ts:7348, core/efficiency.ts:84).
- `deciderOf` gives an overridden step a pseudo-agent key (service.ts:1323), and calibration counts
  no runs for it (core/calibration.ts:244), so its dismissals land without runs.

Decide each one: follow `offer.mode`, or say why not.

**S5. `stick: true` with `mode`/`profile` on a person's own token.** `setStick` stores only
`to/by/bySid/byMachine` (service.ts:821-826), so later `emitReady` offers ignore the override. Refuse
the combination, or say that the stick does not carry it.

**S6. Keep the offer message text parseable, and show `via` in it.** The daemon parses the title with
`/^MESH: @\S+ offers step \S+ "(.*)" \(repo /` (daemon.ts:834). Under act-for, the session or person
sees the service's `note` as `@ann offers …: <note>`. Append `(via <service>)` after the existing
text so the reader knows who wrote the note, and say that the prefix stays unchanged.

**S7. Small interface gaps.**
- `onBehalfOfRequired` must be added to both `HubRoute` (protocol/hub-api.ts:90) and the `Route` type
  in app.ts (app.ts:69-77).
- The OpenAPI generator's `onBehalfOf` branch (hub-api.ts:491) should mark the header as required for
  services on suggest.
- `machineMessage` returns `void` (service.ts:664-667), so `offerStep` must return the id of the
  `addMessage` row for `message`.
- The new effective mode/profile argument of `headlessGuard` must stay optional, so that `assignGoal`,
  `emitReady` and the pulse path (service.ts:753, 840, 6299) keep their declared-only behaviour.
- AC-03's blank header: state whether the test sends `" "` (Hono sees `""`, giving `user-unknown`),
  so that a harness that drops empty headers does not turn it into `on-behalf-of-required`.

**S8. Add a round-trip AC for suggest then assign.** Under act-for, a suggestion's `to`
(`suggestionTo`, core/suggest.ts:62-65, the person's nickname) passed back to assign must resolve to
the same machine. It does, because `findMachine` uses the person's nicknames; one assertion proves
the dashboard flow end to end.
