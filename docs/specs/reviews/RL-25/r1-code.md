Verdict: APPROVED | Round: 1 | Blocking-open: 0

# RL-25 code review, round 1 (ad8a0dc..c0c6de6, row B-251)

Reviewer: cold reviewer, claude-opus-5-5 (did not write the code)
Date: 2026-11-26
Diff: `git diff ad8a0dc..HEAD` on aiops-2026-11-26-B-251 (commits 9fdc911, 168dd3b, cb02b31, 3e8d98a, c0c6de6)
Spec: docs/specs/RL-25.md (revision 3; round-2 spec review mesh-ai `reviews/B-251/r2-spec.md`, APPROVED)

## Runs

- `vitest run test/alert-webhook.test.ts test/alert-daemon.test.ts test/docs-rl25.test.ts
  test/health-hub.test.ts test/m46-ops.test.ts test/schemas.test.ts src/store/hub-store.contract.test.ts`:
  215 pass, 101 skipped (Postgres, no `MESH_TEST_PG_URL`), 3 fail. The 3 failures are the
  `test_AC*_version` pins in test/schemas.test.ts (expect `0.1.40`, package.json is `0.1.41` at the base
  ad8a0dc); this diff touches neither those lines nor package.json, so they are pre-existing.
- `pnpm test` (full): 2992 pass, 112 skipped, 5 fail: the 3 above, test/docs-rl13.test.ts
  `test_AC10_skill_and_version` (same `0.1.40` pin, pre-existing) and test/m45-cli.test.ts
  `test_AC15_daemon_failure_warns_and_starts`, which passes when run alone (load-timing flake, files
  not touched by this diff).
- `pnpm typecheck` clean; `pnpm lint` clean; `pnpm boundaries` no violations.

## AC coverage

| AC | Test(s) | Result |
|---|---|---|
| AC-01 | test_AC01_refusals (403 forbidden / service-only, 401, 400 on-behalf, nothing stored, service-only before body) | covered |
| AC-02 | test_AC02_version_and_body (v3, 1001 alerts, no fingerprint, `startsAt: "yesterday"`, 1000 accepted) | covered |
| AC-03 | test_AC03_skipped_alerts, test_AC03_person_label_trimmed | covered (service account `am` → person-unknown fails without the service check) |
| AC-04 | test_AC04_notified, test_AC04_text_rules | covered (text, data incl. dashboard, event, row; summary fallbacks, 200-char cap, control chars, 2000-char link drop) |
| AC-05 | test_AC05_repeats_suppressed, test_AC05_concurrent_same_hub, test_AC05_two_hubs_sqlite_file, test_AC05_two_hubs_postgres (skipped here) | covered |
| AC-06 | test_AC06_reminder_cancels_pending | covered |
| AC-07 | test_AC07_resolved_after_delivered, _while_pending, _without_row, _reminder_then_resolve, _no_recipient_at_resolve | covered |
| AC-08 | test_AC08_new_episode_after_resolve, _late_firing_after_resolve (incl. no recipient → suppressed), _new_start_while_firing, _late_resolve_of_previous_episode | covered |
| AC-09 | test_AC09_each_own_machines | covered |
| AC-10 | test_AC10_tick_prunes_old_resolved | covered |
| AC-11 | test_AC11_default_batch_is_2s, _two_notices_one_call, _both_method, _ended_session_not_a_target, _repull_before_ack_taken | covered |
| AC-12 | test_AC12_notify_off, _stale, _notify_false_or_throws, _no_target, _late_joiner_in_window, _other_machine_wide_kinds_unknown | covered |
| AC-13 | test_AC13_offer_only_receive_acks_failed (in test/alert-webhook.test.ts rather than the hub-link test; equivalent fixture) | covered |
| AC-14 | contract tests test_AC14_migration_13, _cancel_only_pending, _episode_rows (both dialects); m46-ops test_AC14_migrate_copies_alert_episodes (PG, skipped here); hub-copy TABLES | covered |
| AC-15 | test/docs-rl25.test.ts (route, scope and feature, OpenAPI, no cost field, `mesh hub token --scope alerts:notify`, docs) | covered |

All new tests exercise code that does not exist at the base, so each would fail without the change.

## Correctness and security checks

- Auth: `allowed("member", p, "alerts:notify")` admits a service only through the route's own scope
  (src/core/roles.ts:56); `alertWebhook` refuses any actor that is not service-without-member with
  `403 service-only` before `readBody()` runs (src/hub/service.ts). No act-for: the route has no
  `onBehalfOf`, so `actingFor` returns `400 on-behalf-of-not-accepted`. No new act-for anywhere.
- Input: zod schema as specified (version string, `alerts` max 1000, fingerprint 1..64, RFC 3339 +
  `Date.parse` refine on `startsAt`); invalid JSON → `400 alert-body`; non-"4" string version →
  `alert-version` before schema parse.
- Episode logic matches the §Episodes table row for row, including revision 3's same-`startsAt`
  resolve, all-pending cancel on reminder, and the same-episode suppressions before the recipient
  check. Whole request in `goalTx` (serialize lock); two-hub SQLite file test confirms one notice.
- Recipients: `listMachines({ userId: person })` selects `WHERE user_id = ?`, so other people's
  shared machines are never recipients; 14-day `lastSeen` filter applied.
- Resolved notices go only to machines with a `delivered` notice of the episode, deduplicated.
- Daemon: alert ids live in `offersInFlight` from arrival to ack (so `forgetOffers` spares them and a
  re-pull shows nothing twice); `notify: off` is decided before stale; method from
  `notifyChannels(config)`; falsy or throwing `notify` → `failed`/`no-channel`; target is the live
  interactive session with the latest `lastEventAt` having a pid or pane. Terminal output goes through
  `osc9`, which cleans control characters; desktop goes through argv (no shell).
- Migration 13 on SQLite and Postgres, `alert_episode` in hub-copy TABLES, prune in `tick()`.
- Hard rules: no package.json version bump; no new dependency; no cost/budget field; scope limited
  to the spec (no TUI/web/CLI listing, no act-for, B-250/B-252 untouched). OpenAPI regenerated,
  docs/events.md, docs/guide/auth.md, docs/guide/operations.md, implementation-plan updated.

## Findings

1. **MINOR — docs/guide/operations.md upgrade step 2 still says the hub migrates "to 12, the current
   `SCHEMA_VERSION`"** (line 102, under "Upgrading to 0.1.40"), while the new 0.1.42 sentence in the
   paragraph above says schema 13. Change "12" to "13" (the heading may follow at release time).

2. **MINOR — `labels.severity` is not bounded or cleaned in the notice text.** `alertInfo` caps and
   cleans `summary` only; `MESH ALERT <SEVERITY>:` puts the upper-cased label verbatim into `text`, the
   episode row and the `alert.notified` payload, so a long or control-character severity makes `text`
   exceed the intended size. The caller is the trusted `alerts:notify` token and `osc9` cleans the
   terminal path, so this is not exploitable; the spec does not require more. Consider applying the
   same control-character replacement and a short cap (e.g. 32) to severity.

3. **MINOR — `forgetOffersOfOtherHub` does not drop a pending alert batch.** If the daemon switches hub
   inside the 2-second batch window, the batched notices of the old hub are acked through the link to
   the new hub, where those ids name other messages. The offer path has the same window for in-flight
   offers, so this mirrors existing behaviour; clearing `alertBatch` (and its ids from
   `offersInFlight`) there would close it.

4. **MINOR — spec Status still reads "Draft" (revision 3).** The round-2 spec review is APPROVED; the
   Status section should carry the R2 gate record ("Approved …") as RL-20/RL-21 do, which is the gate
   step's job, not the builder's. Noted so the gate does not miss it.

5. **MINOR (not this diff) — pre-existing red tests.** The `0.1.40` version pins in
   test/schemas.test.ts and test/docs-rl13.test.ts fail at the base ad8a0dc (package.json 0.1.41), so
   `pnpm check` is red independently of this row; the release that bumps the version must update them.

No BLOCKING or MAJOR findings.
