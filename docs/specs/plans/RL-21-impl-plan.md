# RL-21 implementation plan

Spec: [RL-21](../RL-21.md). Release 0.1.40. No migration (schema 12), no daemon change.

1. **Protocol** (src/protocol)
   - hub-api.ts: `SERVICE_SCOPES` + `steps:assign`; `HubRoute.onBehalfOfRequired?`; the assign and
     suggest rows get `scope: "steps:assign"`, `onBehalfOf: true` (suggest also
     `onBehalfOfRequired: true`), the assign row's body becomes `StepAssignRequest`; the OpenAPI
     generator marks the header required for services on suggest.
   - hub.ts: `StepAssignRequest = AssignRequest.extend({mode, profile})`; `AssignResult.message?`;
     `OfferView.via?`; `HUB_FEATURES` + `step-assign-for` (sorted).
   - goal.ts: `StepOffer` + `mode?: "headless"`, `via?: string`.
2. **Errors**: `HubError` gains `code?` (4th argument); app.ts `onError` adds `code` to the body; the
   route rule's 401/403 get `login-required`/`forbidden`.
3. **app.ts**: `Route.onBehalfOfRequired`; `forPerson(route, {required})`; assign and suggest wrapped
   with `forPerson` and scope `steps:assign`; `actingFor` gets `write: POST || required`.
4. **service.ts**
   - `actingFor`: codes on its four refusals.
   - `assignStep`: step checks with codes; act-for option refusals; `resolveTarget(actor, to, {owner})`
     with the machine ownership check before the session lookup, and session ownership; codes on the
     machine/session 404/409; the override rules (own machine, profile-required, needs-headless,
     session target, stick, mismatch, profile-not-yours under act-for); `headlessGuard(step, machine,
     goal, override?)` with codes returned; `offerStep` takes `headless` (forced) and `via`, returns the
     message id; `offer.mode`, `offer.via`; message `data.via` and text suffix; `step.offered` payload.
   - `suggestStep`: codes; act-for `team` refusal; `suggestView` filters sessions to the person.
   - `acceptStep` (with sid) and `claimStep` accept branch: `offer-headless`.
   - `runHeld(step)` (async, reads the holder session): the tick and `deciderOf` (made async).
   - `offers()`: `via`.
5. **Docs**: auth.md, concepts.md (assign), events.md, operations.md, implementation-plan §5.6.
6. `node scripts/schemas.ts`; update the tests that pin `HUB_FEATURES`.
