# S8: Typing into a session (tmux bracketed paste)

Claude Code 2.1.314, tmux 3.8. Spike: `spikes/interactive.ts`.

## Results

| Case | Result |
|---|---|
| `load-buffer` + `paste-buffer -p` (bracketed) of "hello from mesh" into an **open permission dialog**, no Enter | The dialog did not change and nothing was approved (`touch spike-marker.txt` did not run). |
| Esc on the permission dialog | Rejects the tool call ("Interrupted · What should Claude do instead?"). No Stop hook fires. |
| Bracketed paste of "Reply with exactly the word: PASTED" + a separate `Enter` into an **idle prompt** | Submitted as a normal prompt. `UserPromptSubmit.prompt` is the pasted text, and Claude answered `PASTED`. |
| Typed text sent while a startup notice was open | Swallowed by the notice. The prompt did not arrive. |

## Decisions (plan §6.4)

- Delivery by paste requires `agents --json` to show `status: idle` with no `waitingFor`. A dialog swallows input, and a future dialog type might act on it, so the guard stays even though this paste was harmless.
- Use bracketed paste plus a separate Enter, as planned.
- A pasted delivery is indistinguishable from a human prompt in `UserPromptSubmit`. The daemon tags each delivery and matches the next prompt by exact text to exclude it from `human_prompts`.
