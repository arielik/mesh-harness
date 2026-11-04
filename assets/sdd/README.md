# The SDD kit (ships with mesh-harness)

A complete, self-contained spec-driven development cycle for Claude Code. It needs no other repository and no mesh. With mesh installed, every run is recorded in the ledger.

```bash
mesh assets install            # copies .claude/agents, .claude/workflows and templates/ into this repo
```

| File | What |
|---|---|
| `.claude/agents/spec-writer.md` | spec with interface contracts and acceptance criteria (AC-01…, each with the state that makes it fail) |
| `.claude/agents/reviewer.md` | cold reviewer of a spec or a diff: four blocker kinds, finding classes, verdicts |
| `.claude/agents/impl-planner.md`, `test-planner.md` | plans per criterion, written apart: the test side never sees the implementation plan |
| `.claude/agents/developer.md`, `test-writer.md` | separate worktrees; fail-first tests from the pre-change base; neither touches the other's files |
| `.claude/agents/merger.md` | combines the test branch into the implementation branch |
| `.claude/agents/test-executor.md` | read-only verify: each criterion pass / fail / unrun, each failure bucketed |
| `.claude/workflows/sdd-programme.js` | the whole cycle, unattended, for one or more rows |
| `templates/spec.md` | the spec layout |

## Two ways to run it

**1. As a programme, in one Claude Code session.** Ask Claude: "Run the workflow `.claude/workflows/sdd-programme.js` with args `{rows: [{key: 'ROW-1', title: 'add()', brief: '…'}]}`." The script runs the cycle:
1. spec, then a cold review (at most 3 rounds, parks on churn);
2. the two plans in parallel; a test plan that misses a criterion parks the row;
3. developer and test-writer in separate worktrees;
4. combine;
5. verify, at most 3 cycles: impl-bug goes back to the developer, test-bug to the test-writer, spec-gap or infra parks the row;
6. a diff review.

Rows end "ready to land" or "parked" with a reason. Nothing is pushed or merged.

With mesh installed, every `agent()` call is recorded per role under the row's key, from its label `<role>:<key>[:<round>]` and its typed result. The final step runs `mesh ledger stage` and commits the records. Without mesh that step does nothing.

**2. As mesh steps.** `mesh goal plan <G> --preset sdd-split --repo <repo> --acs acs.yaml` turns the same cycle into steps that people and their sessions take one by one. The steps use the same agents (`mesh run <repo> --step <G>.<step>`), and mesh enforces the separation, the round caps, routing and the R2/R3 gates. See `docs/guide/cycle.md` in mesh-harness.

Change anything: the agents and the workflow are yours. mesh relies only on the label format and on the result fields named in each agent's "Report" section (all optional).
