// Claude Code adapter: hook installer, agents --json, background wake, version (plan §5.1, §6).
export { listAgents } from "./agents.ts";
export { attachCommand, wakeBackground, type WakeResult } from "./background.ts";
export { run, type RunOptions, type RunResult, type Runner } from "./exec.ts";
export {
  hookCommand,
  hookUrl,
  inspect,
  inspectSettingsFile,
  installInto,
  installSettingsFile,
  MESH_HOOK_PATH,
  meshHookGroup,
  uninstallFrom,
  uninstallSettingsFile,
  type HookStatus,
  type HookTarget,
} from "./installer.ts";
export { claudeVersion, compareVersions, MIN_CLAUDE_VERSION, parseVersion } from "./version.ts";
export { installSkill, skillStatus, uninstallSkill, type SkillStatus } from "./skill.ts";
export { claudeMdInstalled, installClaudeMd, installMcp, MCP_NAME, mcpInstalled, uninstallClaudeMd, uninstallMcp } from "./extras.ts";
export { computeHarness } from "./harness.ts";
export { agentPaths, readAgentFiles, scanWorkflowRuns } from "./workflow.ts";
export { claudeStatePath, folderTrusted } from "./trust.ts";
