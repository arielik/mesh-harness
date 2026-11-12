# Claude Code CLI spike for headless steps (S1)

Date: 2026-11-12. Supports `2026-11-12-pulse-relay-roster.md` §5.1 (Headless step) and §5.9 (Telemetry).

**CLI:** `/home/ghost2/.local/bin/claude`, `claude --version` → `2.1.322 (Claude Code)`. Runs used
`--model haiku` (resolves to `claude-haiku-5-5`), a throwaway git repo under the session scratchpad,
`--max-turns 1..6`. About 30 `-p` runs plus one `--bg` session; total reported cost about $0.05. Each fact
below comes from one run (n=1), unless a row says otherwise. No user or global config was edited.

Shorthand used in the evidence column: `RUN = claude -p "<prompt>" --model haiku --output-format
stream-json --verbose --max-turns N`, run from the throwaway repo. Output is summarised from the
stream (`tool_use`, `tool_result`, `result` lines).

## 1. Findings

| # | Item | Verified fact (exact flag spelling) | Evidence | Consequence for the design |
|---|---|---|---|---|
| 1a | `stream-json` needs `--verbose` | **Yes.** Without it, exit 1 and nothing on stdout. | `claude -p "Reply with just OK" --output-format stream-json --max-turns 2` → stderr `Error: When using --print, --output-format=stream-json requires --verbose`, exit 1 | Keep `--verbose` in the command (it already is in §5.1). |
| 1b | Event types | One JSON object per line. `type`/`subtype` values seen: `system/hook_started`, `system/hook_response` (SessionStart hooks only, unless `--include-hook-events`), `system/init`, `system/thinking_tokens`, `system/permission_denied`, `assistant`, `user` (tool results), `rate_limit_event`, `result/*`. With `--include-hook-events`: also `UserPromptSubmit` and `Stop` hook events. | Sample in §2 | The log parser must ignore unknown types and subtypes. |
| 1c | `assistant` events are per content block | One `assistant` event per content block, not per API message: blocks of the same response repeat `message.id` (and the same `usage`). | 31 streams: `7-git` had 8 assistant events, 4 unique `message.id`, `num_turns` 5; `4a` had 4 events, 2 ids, `num_turns` 2 | §5.9 "turns counted from assistant events" must count **distinct `message.id`**, and sum `usage` once per id. Even then it can be 1 below `num_turns` (see 2a), so label it approximate. |
| 1d | `system/init` fields | `cwd`, `session_id`, `tools` (string[], includes `mcp__<server>__<tool>`), `mcp_servers` ([{name,status,source}], `source` is `user`/`claudeai`/`dynamic`), `model` (resolved id, e.g. `claude-haiku-5-5`), `permissionMode`, `slash_commands`, `apiKeySource`, `claude_code_version`, `output_style`, `agents` (string[], names only), `skills`, `plugins`, `memory_paths`, `additional_directories`, `original_cwd`, `capabilities`, `fast_mode_state`, `uuid` and more. **No field names the selected `--agent`.** | §2 | `model` from init is correct even with `--agent` (it reflects the agent's or `--model`'s choice; see 6c). Record `agentKey`/`agentHash` from mesh's own arguments, because init doesn't report the agent. `tools` and `mcp_servers` are a cheap check that the profile and MCP isolation applied; store them in run telemetry. |
| 1e | `result` fields | `subtype`, `is_error`, `num_turns`, `duration_ms`, `duration_api_ms`, `total_cost_usd`, `usage` {`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation` {`ephemeral_5m_input_tokens`, `ephemeral_1h_input_tokens`}, `output_tokens_details.thinking_tokens`, `server_tool_use`, `service_tier`, `iterations`[]}, `modelUsage` {per model: `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `costUSD`, `costBasis`, ...}, `permission_denials` [{`tool_name`, `tool_use_id`, `tool_input`}], `result` (final text or null), `stop_reason`, `terminal_reason`, `session_id`, `errors` (on error subtypes), `api_error_status`, `subagent_stats`, `safety_stops`. | §2 | §5.9 mapping: `turns=num_turns`, `tokensIn=usage.input_tokens`, `tokensOut=usage.output_tokens`, `cacheRead=usage.cache_read_input_tokens`, `cacheWrite=usage.cache_creation_input_tokens`, `costUsdEstimate=total_cost_usd`, `durationMs=duration_ms`, `exit=subtype`. Prefer `modelUsage` keys for the model list when subagents ran on another model. Also store `permission_denials` (count and tool names): it is the direct signal for "the profile is too narrow". |
| 1f | `subtype` values | Seen: `success` (exit 0), `error_max_turns` (exit 1, `terminal_reason: "max_turns"`), `error_max_budget_usd` (exit 1, `terminal_reason: "budget_exhausted"`). `is_error` is true on both error subtypes; `result` is null. `success` with `is_error:false` even when tools were denied. | runs `1`, `2-maxturns`, `2-budget` | `exit` enum: `success | error_max_turns | error_max_budget_usd | error_*` (keep it open), plus daemon-side `killed_budget | crashed | no_result`. A refused tool does not fail a run: `mesh_done`/`permission_denials` decide. |
| 2a | `--max-turns` exceeded | `subtype: "error_max_turns"`, `is_error: true`, `errors: ["Reached maximum number of turns (1)"]`, exit code 1. Cost and usage are still reported. Note `--max-turns 1` still executed one tool round (num_turns 2). | `RUN(N=1)` "Read a.txt then b.txt…" → `{'subtype':'error_max_turns','is_error':True,'num_turns':2,'terminal_reason':'max_turns','result':None,'total_cost_usd':0.0022}` | `budget.turns` maps to `--max-turns`; the run then fails cleanly with full telemetry. Treat exit code 1 with a `result` event as "ended", not "crashed". |
| 2b | `--max-budget-usd <amount>` | Exists (`-p` only). Ends with `error_max_budget_usd`. The limit is checked after a response, so spend can overshoot (limit 0.0001, spent 0.0018). | `RUN --max-budget-usd 0.0001` → `RESULT error_max_budget_usd … cost 0.0018 terminal budget_exhausted` | Optional extra cap per run (a cost ceiling next to turns/minutes). Not in §5.1 today; worth adding as `budget.usd`. |
| 2c | SIGTERM mid-run | **No `result` event.** Stream stops after the last flushed event; exit 143 (signal). `SessionEnd` hooks **do** fire; `Stop` hooks do not. The session transcript `~/.claude/projects/<cwd-slug>/<session_id>.jsonl` persists. | `setsid claude -p "Write a 1500-word essay…" … &`, `kill -TERM -- -$pgid` after 7 s → `exit=143`, stream ends after `system/init`, hook marks `flag-SessionStart flag-SessionEnd` (no `flag-Stop`) | §5.1 "killed: no `result` event" confirmed. Partial telemetry: `durationMs` from the daemon, turns and usage from distinct `message.id`s in the stream log (or the transcript). The mesh SessionEnd hook will tell the daemon the session ended; the daemon must not mistake that for a normal finish. Kill the whole process group (`setsid` + `kill -- -pgid`). |
| 3a | `--settings <file-or-json>` | Accepts **both** a path and inline JSON. | inline: `--settings '{"permissions":{"deny":["Bash(cat *)"]}}'` applied (3b); path: `--settings …/flag-hooks.json` applied (hooks ran, 4a) | The daemon may pass the compiled profile inline (no temp file) or as a file in the run dir. A file is easier to debug and to hash; both work. |
| 3b | Merge and precedence | Flag settings **merge** with other sources: permission rules add up, and hooks from `--settings` run **in addition to** user hooks (2 SessionStart hooks ran: user mesh + flag). **Deny wins over allow** across sources: `--allowedTools "Bash(cat *)"` + `--settings` deny `Bash(cat *)` → denied. | `RUN --allowedTools "Bash(cat *)" --settings '{"permissions":{"deny":["Bash(cat *)"]}}'` → `permission_denied`, `tool_result is_error=True 'Permission to use Bash with command cat b.txt has been denied.'`, result `DENIED` | Profile denies are reliable even if a user has broad allows. The other way round is the risk: **user-level allows also apply to a headless run** (merged), so a profile cannot narrow a user's allow except by an explicit deny. UNVERIFIED with a real user-level allow: the user has no `permissions` in `~/.claude/settings.json` and the spike must not edit it. The CLI-allow + flag-deny test stands in for that. |
| 3c | Untrusted workspace | In `-p`, a never-trusted directory's **project `permissions.allow` is ignored** (stderr: `Ignoring 1 permissions.allow entry from .claude/settings.json: this workspace has not been trusted…`), **but project hooks still run** (all three project hooks fired). | default sources, repo `.claude/settings.json` with allow `Bash(touch *)` and SessionStart/Stop/SessionEnd hooks → touch denied; marks `project-SessionStart project-Stop project-SessionEnd` written | A fresh run worktree is untrusted, yet without `--setting-sources user` the subject repo's hooks **execute**. That makes `--setting-sources user` a security requirement for headless runs, not just hygiene. |
| 4a | `--setting-sources` | Exists: `--setting-sources <sources>`, comma-separated, values `user`, `project`, `local`. `claude agents` takes it too. | `claude --help` | Use `--setting-sources user`. Flag settings (`--settings`) are still applied with it. |
| 4b | `--setting-sources user` drops the project | Project hooks do **not** run; project permission rules are not loaded. Project `CLAUDE.md` is **not** loaded either. Project agents (`.claude/agents/*.md`) are **not** available (see 6b). | hooks: marks only `flag-SessionStart flag-Stop flag-SessionEnd`. CLAUDE.md with "end every reply with CLAUDEMD-77": user sources → `'OK'`; default sources → `'OK\nCLAUDEMD-77'` | The headless agent does not see the repo's CLAUDE.md. Either accept that (it is a review step with its own brief) or have `mesh_context` serve the repo's CLAUDE.md as labelled, fenced, untrusted input. §5.1 should say which. |
| 4c | User hooks fire in `-p` | **Yes.** SessionStart (user mesh curl + flag), UserPromptSubmit, Stop (the user's http hook to the mesh daemon) and SessionEnd all fire in `-p` with `--setting-sources user`. | `RUN --setting-sources user --include-hook-events …` → `hook_started SessionStart:startup`, `hook_started UserPromptSubmit`, `hook_started Stop`; flag marks show SessionEnd fired after the result | Mesh session binding through the user-level hooks works for headless runs, as §5.1 assumes. Pass `MESH_STEP` in the environment: the hook headers already carry it. Every `-p` run, including a failed one, registers a session with the local daemon. |
| 5a | `--strict-mcp-config` + `--mcp-config` | Both exist. `--mcp-config <configs...>` takes JSON strings or files. With `--strict-mcp-config`, **only** the given servers load: the user-scope `mesh` server and the `claude.ai` connector servers are both gone (init `mcp_servers` shows only the given server, `source: "dynamic"`). | `RUN --strict-mcp-config --mcp-config '{"mcpServers":{"tiny":{"command":"python3","args":["-I",".../tinymcp.py"]}}}'` → `mcp=[('tiny','connected','dynamic')]`, tools `['mcp__tiny__ping']` | Pass mesh explicitly: `--mcp-config '{"mcpServers":{"mesh":{"command":"mesh","args":["mcp"]}}}'` (verified: connects, exposes `mcp__mesh__mesh_ask/claim/context/done/next/note/plan/release`). Use the absolute `mesh` path from the daemon's own install, not PATH lookup. |
| 5b | MCP tool naming and allow rules | Name is `mcp__<server>__<tool>`. An unlisted MCP tool is **denied** in `-p` (`Claude requested permissions to use mcp__tiny__ping, but you haven't granted it yet.`). `allow: ["mcp__tiny__ping"]` permits one tool; `allow: ["mcp__tiny"]` permits every tool of the server. | runs `5a` (denied), `5b` (allowed, `pong-7731`), `6d-withmcp` (server-level allow) | Profiles list the mesh tools by full name: `mcp__mesh__mesh_context`, `mcp__mesh__mesh_artifact`, `mcp__mesh__mesh_review`, `mcp__mesh__mesh_done`. Do **not** use the server-wide `mcp__mesh` rule: it would also allow `mesh_claim`, `mesh_plan` and the rest. Note `mesh_artifact` and `mesh_review` don't exist in the installed mesh yet. |
| 5c | Deferred MCP tools | MCP tools start deferred: the model calls `ToolSearch` (`select:mcp__…`) before the first use. That costs one extra turn. ToolSearch needs no allow rule. With an agent whose `tools` list names the MCP tool, it was called directly. | `5a`/`5b`/`5c`: `tool_use ToolSearch {"query":"select:mcp__tiny__ping"}` then the call; `6d-withmcp`: direct call | Add 1 to `--max-turns` budgets. If a profile ever uses `--tools`, include `ToolSearch` or name the MCP tools in the agent's `tools`. |
| 5d | Mesh shim in `-p` | `mesh_context` from a `-p` session with mesh-only strict MCP config answered `This session holds no mesh step, and no step is ready for this repo.` (it resolved a session, which held no step). | `5c-mesh-context` run, allow `mcp__mesh__mesh_context` | Partly verified: the shim works in `-p`. **UNVERIFIED:** that it binds the run to the held step (needs a real offered step plus `MESH_STEP`); test that in slice S1 against a dev hub, not the user's daemon. |
| 6a | `--agents <json-or-file>` + `--agent <agent>` | Both exist. `--agent` makes the **main thread** run as that agent: its `prompt` is the system prompt, `tools` restrict the main thread's tools, `model` sets the model. `--agents` accepts inline JSON or, with `--print`, a file path. | inline `zebra` (prompt "reply ZEBRA-INLINE", tools `["Read","Grep"]`, model `haiku`), no `--model`, user default is opus → init `model=claude-haiku-5-5`, `tools=['Read','Grep']`, reply `ZEBRA-INLINE`, `modelUsage` only haiku. File: `--agents …/agents.json --agent narrow` worked. | The roster path in §5.1 works as designed: `--agents <run-dir>/agents.json --agent <key>`. Writing the definition into the worktree's `.claude/agents/` is not needed. |
| 6b | Repo agent files vs `--setting-sources user` | A repo `.claude/agents/filer.md` is found with default sources (reply `WALRUS-FILE`, tools `['Read']` from its front matter). With `--setting-sources user` it is **not**: exit 1, `--agent 'filer' not found. Available agents: claude, Explore, general-purpose, Plan, statusline-setup`, and no stream at all. | runs `6c-file-default`, `6b-file-userSources` | Conflict in §5.1: "a name present in the step repo runs with `--agent <name>`" doesn't work together with `--setting-sources user`. **The daemon must read `<repo>/.claude/agents/<name>.md` itself, convert front matter + body to `--agents` JSON, and hash that** (that also gives `agentHash`). Also handle exit 1 with an empty stream (bad agent name, bad flags) as `crashed` with stderr as the reason. |
| 6c | Agent `tools` vs MCP, `--model` vs agent `model` | An agent `tools` list also filters MCP tools: `tools: ["Read"]` hides `mcp__tiny__ping` even with an allow rule (`NOTOOL`); `tools: ["Read","mcp__tiny__ping"]` keeps it. An agent with no `tools` inherits all tools (33, mesh included). `--model haiku` **overrides** an agent's `model: sonnet` (init and `modelUsage` show only haiku). `--append-system-prompt` still applies with `--agent`. | runs `6d-narrow`, `6d-withmcp`, `6e-model-override`, `9c-agent-append` (`'ZEBRA-INLINE\nAPPENDED-99'`) | When an agent's front matter has `tools`, the daemon must **add the four mesh tool names** to it, or the agent can't report. Pass `--model` only when the step/profile sets one, because it overrides the agent's choice. |
| 7a | Unlisted tools in `-p` | Denied, not prompted: the tool returns an error to the model, the run continues, and the denial is listed in `result.permission_denials`. Seen for `touch c.txt` (write), `cat /etc/hostname` (outside working dirs), `git log --output=o.txt`, `git -c core.pager=cat status`, an unlisted MCP tool, and Read outside cwd. | `7-write`: `"touch in '…/c.txt' needs approval…"`; `7-git`: `'This command requires approval'` for the two risky git forms | As §5.1 says. The `--permission-prompts none` flag exists (default `host`); untested, but the default already denies when no host answers. |
| 7b | Built-in read-only auto-allow | **Read-only commands inside the working directories are allowed with no rule**, in `default` and in `dontAsk` mode: `cat b.txt`, `git status --short`, `git rev-parse --git-dir`, and the Read tool. | `7-none`: `cat b.txt` ran with no allow (`secret-content-42`); `7-dontask-cat`/`-read` likewise; `7-git`: (1) and (4) allowed | The `read-only` profile's git allow-list is mostly redundant, and **it cannot stop reads** inside the worktree and `--add-dir` dirs. Fine for review steps, but don't present the allow-list as the read boundary. To shrink further, use `--tools` (built-in set) or explicit denies. |
| 7c | `--allowedTools` / `--disallowedTools` / `--permission-mode` | All exist. `--allowedTools`, `--allowed-tools <tools...>` and the `--disallowedTools` equivalent take a comma or space separated list. `--permission-mode` choices: `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`; init reports it (`permissionMode: "dontAsk"`). | `3a` (allowedTools works), `7-dontask-*` | Prefer putting rules in the `--settings` profile (one hashed artifact) over CLI flags. Pass `--permission-mode default` (or `dontAsk`) **explicitly**: the user's settings have `autoMode`, and the `--bg` session came up in `auto` mode (8b). `-p` runs reported `default`. |
| 8a | `claude --bg` | `--bg, --background` starts an **interactive TUI session** in a pre-spawned helper process (`claude bg-spare --bg-spare <sock>`, managed by a per-user daemon), prints `backgrounded · <id> · <name>` and returns. Manage it with `claude attach|logs|stop|rm <id>` and list it with `claude agents --json [--all]`. **Refuses untrusted dirs:** `Workspace not trusted. Run 'claude' in <dir> once and accept the trust prompt, then retry.` (exit 1). | `claude --bg --name spike-bg --model haiku --strict-mcp-config --tools "" --max-turns 2 "Reply with just BG-OK…"` in a trusted worktree → `backgrounded · c9ccd7fe · spike-bg` | Fresh run worktrees are untrusted, so `--bg` would need mesh to write trust into `~/.claude.json`. |
| 8b | `--bg` result and cost | **Not retrievable as a result.** `claude agents --json --all` gives only `{pid,id,cwd,kind:"background",startedAt,sessionId,name,status:"idle",state:"done",waitingFor}`: no cost, turns or final text. `claude logs` prints raw terminal output (ANSI). The session **does not exit** when done (`status: idle`), it waits for input. Permission mode came up `auto` (from user settings). Usage per message exists only in the transcript jsonl (no `total_cost_usd`). | `claude agents --json --all`, `claude logs c9ccd7fe`, transcript `permission-mode` lines `"permissionMode":"auto"`; then `claude stop` / `claude rm` | See §4: `-p` is the better fit. |
| 9a | `-p` honours `--append-system-prompt`, `--model`, `--add-dir` | All three: `--append-system-prompt` changed the reply (`…APPENDED-99`); `--model haiku` → init `model: claude-haiku-5-5`; `--add-dir <dir>` → init `additional_directories` lists it and Read outside cwd succeeds (denied without it). | `9a-noadd` (denied), `9b-add` (`'extra-content-55\n\nAPPENDED-99'`) | Use `--add-dir` for read-only inputs outside the worktree (e.g. a previous run's artifacts) when `mesh_context` isn't the channel. Remember 7b: anything under `--add-dir` becomes readable with no rule. |

### Other flags seen in `--help` that matter

- `--session-id <uuid>`: the daemon can choose the session id before start, write it in the run file,
  and match hook events and the transcript to the run without parsing the stream first. Recommended.
- `--no-session-persistence` (`-p` only): keeps no transcript. Don't use it: the transcript is the
  fallback telemetry source after a kill (2c).
- `--include-hook-events`: puts all hook lifecycle events in the stream. Useful for debugging; not needed.
- `--bare`: skips **all** hooks, including the user's mesh hooks, and ignores OAuth. Unusable for mesh.
- `--restricted`: drops Bash-like tools and ignores user/project/local settings files (so the mesh
  hooks too). An option for a future sandboxed profile only if mesh binds the session by `--session-id`
  instead of hooks.
- `--tools <tools...>`: limits the built-in tool set (`""` = none). A stronger floor than allow rules.
- `--json-schema <schema>`: structured final output validation in `-p`. Not needed while results go
  through `mesh_review`.

## 2. Sample stream (trimmed)

`claude -p "Reply with just OK" --model haiku --output-format stream-json --verbose --max-turns 2`
(UUIDs shortened, long arrays cut):

```jsonl
{"type":"system","subtype":"hook_started","hook_id":"dd3d…","hook_name":"SessionStart:startup","hook_event":"SessionStart","uuid":"c626…","session_id":"85ad50b7-…"}
{"type":"system","subtype":"hook_response","hook_id":"dd3d…","hook_name":"SessionStart:startup","hook_event":"SessionStart","output":"","stdout":"","stderr":"","exit_code":0,"outcome":"success","uuid":"6004…","session_id":"85ad50b7-…"}
{"type":"system","subtype":"init","cwd":"/…/cli-spike/repo","session_id":"85ad50b7-…","tools":["Task","Bash","CronCreate","…41 total, incl. mcp__mesh__mesh_context"],"mcp_servers":[{"name":"mesh","status":"connected","source":"user"},{"name":"claude.ai Claude Docs","status":"connected","source":"claudeai"}],"model":"claude-haiku-5-5","permissionMode":"default","slash_commands":["…"],"apiKeySource":"none","claude_code_version":"2.1.322","output_style":"default","agents":["claude","Explore","general-purpose","Plan","statusline-setup"],"skills":["…"],"plugins":["…"],"capabilities":["…"],"memory_paths":{"auto":"…"},"original_cwd":"/…/repo","additional_directories":[],"fast_mode_state":"off","uuid":"7389…"}
{"type":"assistant","message":{"model":"claude-haiku-5-5","id":"msg_011Cgx…","role":"assistant","content":[{"type":"text","text":"OK"}],"stop_reason":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":12236,"cache_read_input_tokens":11382,"output_tokens":4,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":12236}}},"parent_tool_use_id":null,"session_id":"85ad50b7-…","uuid":"…"}
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","rateLimitType":"seven_day","utilization":0.81,"…":"…"},"session_id":"85ad50b7-…"}
{"type":"result","subtype":"success","is_error":false,"num_turns":1,"duration_ms":1425,"duration_api_ms":1313,"total_cost_usd":0.00256322,"result":"OK","stop_reason":"end_turn","terminal_reason":"completed","session_id":"85ad50b7-…","usage":{"input_tokens":2,"cache_creation_input_tokens":12236,"cache_read_input_tokens":11382,"output_tokens":4,"output_tokens_details":{"thinking_tokens":0},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"cache_creation":{"ephemeral_1h_input_tokens":12236,"ephemeral_5m_input_tokens":0},"iterations":["…"]},"modelUsage":{"claude-haiku-5-5":{"inputTokens":2,"outputTokens":4,"cacheReadInputTokens":11382,"cacheCreationInputTokens":12236,"costUSD":0.00256322,"contextWindow":1000000,"costBasis":"list"}},"permission_denials":[],"subagent_stats":{"spawned":0,"…":"…"},"safety_stops":0,"api_error_status":null,"uuid":"…"}
```

A denial inside a run (from `3b`), between `assistant` and `user` events:

```jsonl
{"type":"system","subtype":"permission_denied", "…":"…"}
{"type":"user","message":{"content":[{"type":"tool_result","is_error":true,"content":"Permission to use Bash with command cat b.txt has been denied."}]}}
```

and in the result: `"permission_denials":[{"tool_name":"Bash","tool_use_id":"toolu_01Wi…","tool_input":{"command":"cat b.txt","description":"Print contents of b.txt"}}]`.

Two more notes. The stream has `rate_limit_event` (the account's weekly utilisation); don't put it in
telemetry, since that is account data. Also, the user's `~/.claude/settings.json` hook commands embed
the daemon's key in plain text, so a stream run with `--include-hook-events` or a hook-output tail must
not be stored as a `transcript` artifact without redaction (§5.1 "rendered tail" already avoids raw JSON).

## 3. Changes the spike implies for §5.1 / §5.9

1. **`--setting-sources user` is required** (3c: an untrusted worktree still runs project hooks).
   Remove the † mark; the fallback "clean config dir" is not needed.
2. **Repo agents go through `--agents` too** (6b). The daemon reads `<worktree>/.claude/agents/<name>.md`,
   builds `{name: {description, prompt, tools?, model?}}`, writes `<run-dir>/agents.json`, hashes it, and
   passes `--agents <file> --agent <name>`. Remove the "write into `.claude/agents/`" workaround. Remove the † on `--agent`.
3. **Add the mesh tools to an agent's `tools`** when it has a `tools` list (6c).
4. **Profiles name mesh tools one by one** (`mcp__mesh__mesh_context`, …), never `mcp__mesh` (5b).
5. **The `read-only` profile cannot prevent reads** inside the worktree and `--add-dir` dirs (7b). Say so
   in §5.1/§7, and use `--tools` when a profile must remove Bash entirely.
6. **The agent doesn't see the repo's `CLAUDE.md`** (4b). Decide whether `mesh_context` serves it as untrusted input.
7. **Telemetry (§5.9):** turns fallback = distinct `assistant.message.id` (approximate, 1c/2a); exit enum
   includes `error_max_turns`, `error_max_budget_usd`; record `permission_denials` count/tools, init
   `tools`/`mcp_servers`; `agentKey/agentHash` from mesh, not the stream. Exit code 1 + `result` = ended;
   exit ≠ 0 + empty stream = `crashed` (stderr is the reason, e.g. unknown agent).
8. **Kill by process group; expect SessionEnd hooks on kill** (2c). Optionally add `budget.usd` →
   `--max-budget-usd` (2b). Add one turn for ToolSearch (5c).
9. Pass `--session-id <uuid>` and `--permission-mode default` explicitly.

## 4. Recommendation

**Command for a headless mesh step** (cwd = the run worktree; env `MESH_STEP=<step-id>`; started with
`setsid`, stdout to `<run-dir>/stream.jsonl`, stderr to `<run-dir>/stderr.log`):

```sh
MESH_STEP=<step-id> setsid claude -p "<pointer prompt>" \
  --output-format stream-json --verbose \
  --session-id <uuid> \
  --max-turns <budget.turns + 1> \
  --setting-sources user \
  --settings <run-dir>/profile.json \
  --permission-mode default \
  --strict-mcp-config \
  --mcp-config '{"mcpServers":{"mesh":{"command":"<abs path to mesh>","args":["mcp"]}}}' \
  [--agents <run-dir>/agents.json --agent <name>] \
  [--model <m>] \
  [--max-budget-usd <budget.usd>] \
  [--add-dir <read-only input dir>]
```

`profile.json` = `{"permissions":{"allow":["mcp__mesh__mesh_context","mcp__mesh__mesh_artifact","mcp__mesh__mesh_review","mcp__mesh__mesh_done", …profile allows], "deny":[…profile denies]}}`.
The `budget.minutes` wall clock stays a daemon timer that sends SIGTERM to the process group.

**`-p` rather than `--bg`.** `-p` exits when done and ends with a machine-readable `result` (cost,
usage, turns, subtype, denials). It runs in untrusted worktrees, honours every flag tested here, and is
a plain child process the daemon can time, kill and adopt by pid from its run file. `--bg` sessions
are interactive TUIs. They stay alive (`idle`) after finishing and expose no result or cost
(`claude agents --json` has only state, ids and pid; `claude logs` is ANSI screen output). They refuse
untrusted directories, run in a helper process owned by Claude Code's own daemon, and came up in the
user's `auto` permission mode. `--bg` stays right for what `mesh run --bg` does today (a person-facing
session someone may `attach` to). It doesn't suit an unattended run whose result mesh must read.
Reattach for `-p` runs is not needed: the daemon re-reads the stream log, and a person can open the
transcript with `claude --resume <session-id>` after the run.

## 5. Not verified

- A **real user-level allow** merged into a `-p` run (no user `permissions` exist; editing user settings
  was off limits). The CLI-allow vs flag-deny test (3b) and documented precedence support "deny wins".
- **Step binding** of the mesh MCP shim for a `-p` run that holds a real step via `MESH_STEP` (5d): needs
  a dev hub and an offered step.
- `--permission-prompts none`: present in help, not run.
- Whether `--bg` honours `--max-turns`, `--setting-sources` and `--strict-mcp-config` (the flags were
  accepted; their effect in the spare process was not checked, since `--bg` is not recommended).
- `--add-dir` loading `CLAUDE.md` from added dirs (the `--bare` help suggests it does).
- Exit code and stream on SIGKILL or an API error (`api_error_status`): not run.
