# S6: Binding hooks and MCP calls to a session by Claude pid

Claude Code 2.1.314. Spikes: `spikes/print.ts`, `spikes/interactive.ts`.

## Results

| Observation | Value |
|---|---|
| tmux `pane_pid` (pane runs `claude` directly) | 15919 |
| `$PPID` inside an async command hook (`X-Claude-Pid`) | 15919 ✓ |
| stdio MCP server `process.ppid` | 15919 ✓ |
| Hook environment | `CLAUDE_PID=15919`, `CLAUDE_CODE_SESSION_ID=<current id>`, `CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_ENTRYPOINT` (`cli` interactive, `sdk-cli` for `-p`), `CLAUDE_CODE_SESSION_ATTENDED` (1 interactive, 0 print) |
| MCP server environment | `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_ENTRYPOINT` (no `CLAUDE_PID`, but `ppid` is the Claude pid) |
| After `/clear` | The MCP server is **not** restarted. Its `CLAUDE_CODE_SESSION_ID` is now **stale**. |

## Decisions (plan §3.1, §5.1, §5.2)

- Hooks send `X-Claude-Pid: ${CLAUDE_PID:-$PPID}`: the documented variable, with the shell parent as a fallback.
- `mesh mcp` sends its `process.ppid` as the Claude pid. The daemon maps pid → current `sid`/session id from the latest hooks and `agents --json`. **Never trust the MCP server's `CLAUDE_CODE_SESSION_ID`**, because it is stale after `/clear`.
- The S6 fallback (binding by machine + cwd) is not needed.
