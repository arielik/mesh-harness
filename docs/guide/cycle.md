# Running the development cycle with mesh

The team's SDD cycle runs as the plan template `sdd-split`:
- design → spec ⇄ cold review → R2;
- implementation and test plans written apart;
- developer and test-writer blind to each other;
- combine → verify, with fixes routed by bucket;
- cold diff review → R3.

mesh enforces the separation and the caps, and records everything. Your agents, skills and workflows stay as they are.

```bash
mesh preset ls                         # sdd-split, sdd-collapse (+ .mesh/presets/*.yaml in the repo)
mesh preset show sdd-split             # the template as YAML

# Either a design session proposes the plan from the template …
mesh goal new "IPv6 underlay" --repo frr-dplane-ovs --refs spec=771,backlog=NA-1054 --preset sdd-split
mesh run --design G7

# … or you fill it in directly, with the acceptance criteria:
mesh goal plan G7 --preset sdd-split --repo frr-dplane-ovs --acs acs.yaml
#   acs.yaml:  - { id: AC-01, text: …, surface: OVS lane, fails_when: … }

mesh show G7                           # the graph; "steps: 1 needs a person · 2 in progress · …"
mesh run frr-dplane-ovs --step G7.write-tests     # worktree mesh/g7-write-tests from HEAD (--base REF)
mesh step approve G7.r2 --comment "spec is good"  # gates: R2, R3 (or in the web dashboard)
mesh step reject G7.r3 --reopen develop --comment "CI red on AC-02"
mesh step resume G7.verify --comment "lane fixed" # a parked step goes on
```

What the agents pass to `mesh_done`, and what mesh does with it:

| Step | Agent reports | mesh |
|---|---|---|
| spec, plans, develop, write tests | `acs_addressed` | with `must_cover`: a plan missing a criterion is sent back once ("Not accepted: …"), then parked |
| spec review, diff review | `verdict`, `findings`, `blockers` | `changes_requested` reopens the `target`; parks on the cap or on churn (regressions are more than half of the findings) |
| verify | `verdict`, `acs` per criterion, `failures` with bucket | routes each bucket (impl-bug → develop, test-bug → write-tests, spec-gap → spec, infra → park); parks on the cap or on stall (two rounds with no new criterion met); the reopened step gets the bucket, criterion and assertion only |
| R2, R3 | a person decides | the decision, rule and inputs are recorded |

**Separation.**
- A blind step can't be taken by anyone who worked on the other side. In Solo (`blind_guard: session`), one person may play both sides from different sessions.
- Its agent's `mesh_context` hides the other side's summary, notes and branch.
- `forbid` paths become Claude Code deny rules for its session. These are best-effort: shell commands are not covered.
- The record says whether the sides were really kept apart (`blind.separated`).

**Programmes in one Claude session** (the canonical `define-rows.js` / `build-rows.js`) are recorded per role from their labels and typed results, as described in [the ledger](ledger.md). Their separation is by the workflow's own worktrees and is recorded, not enforced.
