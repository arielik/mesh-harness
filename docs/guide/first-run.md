# Your first hour with mesh

A hands-on walk-through for someone new to mesh: install it, watch your Claude Code sessions, then
take one small goal from design to done in a scratch repo. It runs in Solo mode, on your machine
only, and works the same over SSH. Allow about an hour, most of it in step F.

You need Linux or macOS, Claude Code 2.1.314 or later, `curl`, `git` and `tmux`. Node.js comes in
step A.

## A. Node.js 24 for your user

mesh needs Node.js 22.13+ or 24+. If `node -v` already prints one of those, skip to B. Otherwise
install it for your user, for example with nvm:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
exec $SHELL -l
nvm install 24 && nvm alias default 24
node -v          # v24.x
```

Open a new shell (or `exec $SHELL -l`) before step B, so the installer runs on the new Node. On
an older Node it stops with "Node.js … is too old".

## B. Install mesh

```bash
curl -fsSL https://github.com/arielik/mesh-harness/releases/latest/download/install.sh | sh
mesh --version
```

No sudo: the command lands in `~/.local/bin/mesh`. If the installer says that folder isn't on your
PATH, add it:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && exec $SHELL -l
```

## C. Connect Claude Code and keep the daemon running

```bash
mesh setup --notify terminal   # hooks, the MCP server and the mesh skill for Claude Code
mesh up --install              # prints the commands that make the daemon a service; run them
mesh doctor                    # every line ✓, ending with "Solo: working on the local hub …"
```

- `mesh setup` saves the path of the Node.js that runs it, so run it on the Node from step A. After
  a major Node.js upgrade, run `mesh setup` and `mesh up --install` again.
- On a Linux machine you reach over SSH, let the service outlive your login:
  `sudo loginctl enable-linger $USER`. Otherwise the daemon stops when your last SSH session
  closes.
- `--notify terminal` writes notifications into the session's own terminal, so they reach you over
  SSH. Inside tmux, add `set -g allow-passthrough on` to `~/.tmux.conf`. If your terminal shows
  nothing, use `--notify off` and rely on the list; on a desktop, `--notify desktop` is the default.

## D. Restart your Claude Code sessions

Claude Code reads its hooks when a session starts, so sessions that were already open don't report
to mesh yet. Exit each one when it's at a good stopping point and resume it in the same folder:

```bash
claude --continue
```

## E. Watch your sessions

```bash
mesh            # the live list; the sessions that need you come first
mesh status
```

```
mesh 0.1.0 · you · solo (local hub)

NEEDS YOU (1)
  ● api-service      permission                                            1m
WORKING (1)
  ◐ web-app          working · turn 3 · 2m                                 2m
IDLE (2)
  ○ docs             done: Updated the README                              9m
  ○ infra            idle                                                  1h
```

Work normally for a while and check that:

- a session that asks you something, or waits for a permission, moves to **NEEDS YOU**;
- a working session shows **WORKING**, and a finished one **IDLE** with its last message;
- notifications reach you (step C);
- `mesh doctor` doesn't warn about sessions with old hooks.

In the list, `⏎` jumps to a session that runs in tmux. You stay in tmux, so come back with the tmux
prefix (`Ctrl+b` by default) and `L` (the last session), or `s` to pick from all sessions. Don't
type `/exit` in the session to get back: that ends Claude, not the jump. Sessions in other
terminals (your own tabs, for example) are listed too, but mesh can't switch to them.

## F. A goal from design to done

Use a scratch repo, so the records mesh writes don't land in a real one. Run these from the folder
that holds your checkouts: mesh finds a repo by its folder name, under the current folder and its
parent.

```bash
cd ~/src                       # wherever your checkouts live
mkdir mesh-try && cd mesh-try && git init && echo "# try" > README.md && git add . && git commit -m init && cd ..

mesh goal new "Add a hello script" --repo mesh-try    # prints the goal id, G1
mesh run --design G1           # a design session in tmux session "mesh"
```

1. **Accept the folder.** Claude asks whether you trust a folder it hasn't seen before, and nothing
   starts until you answer. The list shows that window under NEEDS YOU; switch to it with
   `tmux switch-client -t mesh:1` (or prefix + `s`) and choose "Yes, I trust this folder".
2. **Let it design.** The session reads the repo, writes a short design document and proposes a
   plan. Come back to the list with prefix + `m`.
3. **Review and approve the plan.**

   ```bash
   mesh show G1                # the plan: its steps and the design document
   mesh goal approve G1        # or: mesh goal revise G1 "<what to change>"
   mesh next                   # the steps that are ready
   ```
4. **Run a step.** Start a session that holds it (the step id is in `mesh next`):

   ```bash
   mesh run mesh-try --step G1.<step>
   ```

   The session reads its brief with `mesh_context`, does the work and finishes with `mesh_done`.
   If it needs a decision it asks, and the list shows it under NEEDS YOU.
5. **Check the result.**

   ```bash
   mesh show G1                     # the step is done
   git -C mesh-try log --stat -3    # the work, with the record under .mesh/goals/G1/
   ```

When you're done, delete the scratch repo: `rm -rf ~/src/mesh-try`.

## If something is off

- `mesh doctor` checks the whole installation and says what to fix.
- The daemon's log: `journalctl --user -u mesh -f` on Linux; on macOS, `daemon.log` in mesh's
  state folder (`~/.local/state/mesh/` unless you moved it).
- `mesh setup --uninstall` removes the hooks, the MCP server and the skill, and leaves Claude Code's
  settings exactly as they were.
- To update mesh later, run the installer again; it refreshes your setup and restarts the daemon.

## Next

- [How-to](howto.md): every task with examples, including joining a team hub.
- [Concepts](concepts.md): sessions, goals, plans and steps.
- [Install](install.md): every installation option.
