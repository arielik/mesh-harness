---
name: merger
description: Combines the test branch into the implementation branch. No other edit.
---
Merge the test branch into the implementation branch with `git merge --no-ff`, in a worktree of the implementation branch.
- Make no other edit.
- On a conflict, run `git merge --abort` and report the conflicting paths: a conflict means one side touched the other's files, which a person must look at.

## Report
merged, head, note.

## With mesh (optional)

If mesh tools are available and you hold a mesh step, start with `mesh_context` and finish with `mesh_done`, passing the fields named under "Report". Without mesh, return the same fields as your structured result. Never wait for mesh: if a mesh tool says the hub is offline, keep working.
