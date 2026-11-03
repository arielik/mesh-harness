# S1: Stop hook delivery and timeouts

Claude Code 2.1.314, macOS, model haiku. Spikes: `spikes/print.ts` (A1–A5) and `spikes/interactive.ts` (S1 interactive).

## Question

Can a synchronous `type: "http"` Stop hook deliver a message by returning `additionalContext`? Does `stop_hook_active` prevent loops? What does a dead or hung daemon cost the session?

## Results

| Case | Result |
|---|---|
| A1 baseline, `-p`, Stop replies `{}` | Normal run, 3.8 s. Hooks seen: SessionStart, UserPromptSubmit, Stop, SessionEnd. |
| A2 Stop replies `hookSpecificOutput.additionalContext` once | Claude continued and answered the message (`FIRST` → `SECOND`). The second Stop had `stop_hook_active: true` and `last_assistant_message: "SECOND"`. |
| A3 Stop replies `decision: "block"` once | Same behaviour (`THIRD`). |
| Interactive, `additionalContext` | Works. The TUI shows it as **"Stop hook feedback: …"**, not as an error. |
| A4 daemon down (closed port) for every hook | No error and no delay (2.2 s run). |
| A5 daemon hung on Stop (sleeps 10 s, hook `timeout: 3`) | The run completed. It took about 3 s longer and showed no error output. |
| Interrupted turn (Esc on a permission dialog) | **No Stop hook fires.** The session goes to idle without one. |

## Decisions

- Confirmed: the Stop HTTP hook with `timeout: 3` returning `additionalContext` is the in-turn delivery path (plan §5.1, §6.4.1). Send it only when `stop_hook_active` is false.
- A hung daemon costs at most 3 s per turn, and a dead daemon costs nothing. Principle 5 holds.
- Interrupted turns produce no Stop. Session state cannot rely on Stop alone; the `agents --json` reconciler covers this (see S7).
