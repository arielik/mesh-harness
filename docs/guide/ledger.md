# The ledger (`mesh.ledger.v1`)

The rule (owner decision 1):
- **Git:** durable, generated summaries, the ledger.
- **Hub events:** precise and live-only data, kept N days.
- **Never typed by hand:** everything comes from hooks, events, tool arguments and Claude Code's own files.

The JSON Schemas are in [`schemas/`](../../schemas); `pnpm schemas` regenerates them from `src/protocol/ledger.ts`. New fields are always optional, so readers must accept unknown ones.

## Files

| Path | Record | Written |
|---|---|---|
| `.mesh/goals/<G>/goal.yaml` | `goal` | on `mesh_plan`; again with a `rollup` when the goal is done |
| `.mesh/goals/<G>/plan.vN.yaml` | `plan` | on `mesh_plan`; again with the decision on approval |
| `.mesh/goals/<G>/steps/<id>.md` | `step` | on `mesh_done` (front matter + summary and notes); the design step on approval |
| `.mesh/goals/<key>/steps/<role>.md` | `agent-step` | workflow programmes: pending in `<git common dir>/mesh/pending/<key>/`, copied by `mesh ledger stage <key>` |

The daemon writes these files into the session's repo, and the agent commits them with its work, so they appear in the merge request.

## A step record

```yaml
---
schema: mesh.ledger.v1
record: step
goal: G17
step: dplane
kind: implement
repo: frr-dplane-ovs
plan: v2
holders: [{ user: ariel, from: 2026-11-03T09:12Z, to: 2026-11-03T10:12Z }, …]
models: [claude-opus-5-5, claude-sonnet-5]
turns: 5
human_prompts: 3          # typed by a person; messages mesh delivered are not counted
nudges: 1
waits: { count: 2, minutes: 9 }
active_minutes: 95
fix_cycles: 1
outcome: done
artifacts: [{ path: docs/design/g17.md, sha: abc123 }]
segments:                 # one per session that worked on it
  - sid: s1
    user: ariel
    from: 2026-11-03T09:12Z
    to: 2026-11-03T10:05Z
    model: claude-opus-5-5
    model_source: hook    # hook (SessionStart) · agent (mesh_done) · workflow (Claude Code's files)
    effort: high
    permission_mode: default
    claude_code: 2.1.318
    harness: { hash: 9f2c…, parts: { repo: 1a0b…, user: 77de…, plugins: c3f1…, mesh: 0.4.0 } }
    repo_commit: 4e1d2a7…
    turns: 4
    human_prompts: 3
    nudges: 1
    waits: { count: 2, minutes: 9 }
    active_minutes: 41
rounds:                   # one per mesh_done; a reopened step has several
  - { n: 1, user: ariel, started: …, finished: …, minutes: 40, outcome: done, summary: first cut }
  - { n: 2, user: tom, started: …, finished: …, minutes: 55, outcome: done, model: claude-sonnet-5 }
recorded_offline: true    # only when the daemon wrote it while the hub was away
# M4.5 (all optional):
role: test-executor
acs: [AC-01, AC-02]       # criteria this step covers
blind: { steps: [impl-plan], separated: true }   # nobody worked on both sides
parked: { reason: "stall: no new acceptance criterion met in 2 rounds", at: … }
# and per round: verdict, findings {new, repeat, regression}, blockers,
# failures [{ac, bucket, assertion}], acs {AC-01: met}, acs_addressed, reconcile {missing},
# gate {by, rule, inputs, comment}, parked
---
Added v6 underlay next-hop programming.
```

## A programme record

```yaml
---
schema: mesh.ledger.v1
record: agent-step
key: NA-1054                 # the team's id, from the label
role: reviewer
name: reviewer               # reviewer-diff for diff reviews, gate-advisor-r3 for gate tokens
workflow: define-rows
models: [claude-opus-5-5]
rounds:
  - n: 1
    label: reviewer:NA-1054:r1
    agent_id: a1b2…
    workflow_run: wf_…
    phase: Define
    model: claude-opus-5-5
    model_source: workflow
    started: 2026-11-04T12:01:00Z
    finished: 2026-11-04T12:02:00Z
    duration_s: 60
    result: { verdict: CHANGES REQUESTED, blocking_open: 2, findings_new: 3 }   # the workflow's typed result
  - n: 2
    …
---
```

Labels follow the canonical workflows' `<role>:<key>[:<round>]`:
- `r<n>`, `c<n>`, `v<n>`, `fix<n>` and `rfix<n>` are rounds of the same record, numbered in the order they ran.
- `diff<n>` makes a separate `-diff` record.
- Other tokens (e.g. `R3`) name a separate record.
- Labels without a key (`ledger`, `clean`) are not recorded.

## Goal roll-up

When a goal is done, `goal.yaml` gets totals:
- steps, rounds, fix cycles;
- plan versions and design rounds (`revised` only);
- people, models and harness hashes;
- human prompts, nudges, minutes waiting and active;
- lead time;
- per step kind: steps, rounds, fix cycles, minutes;
- with M4.5: parks, failures per bucket, per criterion whether it was met and in which step and round it first was, and the gates with who decided them and by which rule.

Plan files carry the plan's `acs` and each step's rules (role, blind, route, …).

This is the per-goal retro, written with no agent.

## Reading it

```bash
mesh ledger export --repo ~/src/a --repo ~/src/b [--ref origin/HEAD] [--events] --out ledger.jsonl
```

The export reads every record under `.mesh/goals` at the ref (default `origin/HEAD`, else `HEAD`) and validates it. It writes one JSON line per record, `{kind: "record", repo, path, ref, commit, record}`, and with `--events` one per hub event. Files written before `mesh.ledger.v1` are skipped and counted.
