// Terminal multiplexer (tmux) and desktop notification adapters (plan §6.4).
export { run, spawnDetached, type Runner } from "./exec.ts";
export { desktopNotify, osc9, processTty, terminalNotify, tmuxPassthrough, type TerminalTarget } from "./notify.ts";
export {
  bindReturnKey,
  capturePane,
  hasSession,
  jumpToPane,
  killServer,
  newSession,
  newWindow,
  paneExists,
  paneSocket,
  paneText,
  pasteToPane,
  serverFromEnv,
  type TmuxOpts,
  type TmuxServer,
  type WindowSpec,
} from "./tmux.ts";
