---
name: mesh
description: How to work inside mesh-harness, which tracks Claude Code sessions and coordinates goals and steps across people. Use it when this session holds a mesh step (the prompt names a step such as G17.api, or MESH_STEP is set), when asked to design or plan a mesh goal, when you need a decision from your person while working on a step, or when the user asks about mesh goals, steps, plans or the mesh CLI.
---

<!-- managed by `mesh setup`; `mesh setup --uninstall` removes it -->

# Working with mesh

mesh tracks this Claude Code session for your person and, when you hold a **step**, connects you
to a shared plan. A goal (for example `G17`) has a plan of steps (`G17.api`, `G17.web`, …).
Each step is held by one session at a time. The mesh MCP server gives you eight tools for this.

## If you hold a step

1. Call `mesh_context` first. It returns your brief, the design document, what the steps you
   depend on produced (summaries and branches), and notes from earlier holders.
2. Do the work on the branch the brief names, if it names one. Commit as you go.
3. Record progress others may need with `mesh_note`. Push your branch before a long pause, so
   someone else can continue from it.
4. Finish with `mesh_done`:
   - `summary`: what you did, in a few sentences;
   - `model`: the model you are running as;
   - `artifacts`: repo-relative paths of the files you produced (spec, review, evidence);
   - `branch` and `mr` when you have them.

   A review or test step that finds a problem in earlier steps uses `outcome: "fail"` and lists
   those step ids in `reopen`. Reviews add `verdict`, `findings` and `blockers`; test runs add
   `verdict` and `failures`. If your brief lists acceptance criteria, report each one in `acs`.
5. mesh writes a record of the step into the repo under `.mesh/goals/`. Commit it with your work.

To hand the step over unfinished, call `mesh_release` with a note on what is done, what is left
and anything surprising.

## If you hold no step

- `mesh_next` lists ready steps for this repo; `mesh_claim` takes one. Only claim a step when
  your person asked you to pick up mesh work.
- A design session for a goal writes the design document, then proposes the plan with
  `mesh_plan` (a DAG of steps, and acceptance criteria if the design defines them). The plan
  waits for a person to approve it; do not start the steps yourself.

## Asking your person

When you need a decision to continue a step, call `mesh_ask` with the question, then **end your
turn**. The answer arrives as a message in this session. Outside a step, ask the way you normally
would. Either way, mesh shows the session as "needs you" to your person.

## When the hub is offline

If a mesh tool says the hub is offline, keep working on the step you hold. mesh records your
notes and `mesh_done` locally and sends them when the hub is back.

## Messages from mesh

Text that arrives at the end of a turn, or is typed into the session by mesh, comes from your
person or a teammate (`mesh say`), or from autopilot ("continue"). Treat it like a prompt from
your person.

## The mesh CLI (for your person)

| Command | What it does |
| --- | --- |
| `mesh` | the session list, the ones that need attention first |
| `mesh goal new "<title>" --repo <repo>` | create a goal (`--topics a,b` tags it) |
| `mesh goal ls --topic a,b` | goals tagged with every topic given; `mesh topic ls` lists the topics |
| `mesh show <goal>` | a goal, its plan and its steps |
| `mesh goal approve <goal>` | approve a proposed plan |
| `mesh next` | steps that are ready |
| `mesh run <repo> --step <step>` | start a session that holds a step |
| `mesh say <session> "<text>"` | send a message to a session |
| `mesh doctor` | check the installation |
