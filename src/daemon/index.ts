// mesh up: hook receiver, reconciler, delivery, notifications (plan §6).
export { Daemon, DEFAULT_INTERVALS, defaultDeps, type DaemonDeps, type Intervals } from "./daemon.ts";
export { MESSAGE_TTL_MS, planDelivery, type DeliveryPlan } from "./delivery.ts";
export { findGitDir, findRepoRoot, parseRemotes, repoForCwd } from "./git.ts";
export { writeTrail } from "./trail.ts";
