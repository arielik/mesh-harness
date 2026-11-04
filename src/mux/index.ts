// Terminal multiplexer (tmux) and desktop notification adapters (plan §6.4).
export { run, type Runner } from "./exec.ts";
export { desktopNotify } from "./notify.ts";
export {
  bindReturnKey,
  capturePane,
  hasSession,
  jumpToPane,
  killServer,
  newSession,
  newWindow,
  paneExists,
  pasteToPane,
  serverFromEnv,
  type TmuxOpts,
  type TmuxServer,
  type WindowSpec,
} from "./tmux.ts";
