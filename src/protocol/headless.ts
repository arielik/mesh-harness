// RL-1: the local run file of a headless step (`<runsDir>/<runId>/run.json`).

import { z } from "zod";
import { ProfileBase, RunExit } from "./goal.ts";

export const RunState = z.enum(["queued", "running", "finished", "released"]);
export type RunState = z.infer<typeof RunState>;

export const RunFile = z.object({
  runId: z.string(),
  step: z.string(),
  goal: z.string(),
  repo: z.string(),
  state: RunState,
  acceptedAt: z.number(),
  deadline: z.number(),
  /** The session id the run's `claude -p` is started with (a UUID). */
  sessionId: z.string(),
  /** The checkout the run's worktree is made from. */
  checkout: z.string(),
  /** The run directory. */
  dir: z.string(),
  worktree: z.string().optional(),
  baseCommit: z.string().optional(),
  startedAt: z.number().optional(),
  pid: z.number().int().optional(),
  /** Names the process instance (not just its pid), see HeadlessRunner. */
  startId: z.string().optional(),
  killedForBudget: z.boolean().optional(),
  /** RL-1: ended by the daemon DONE_GRACE_MS after its step's mesh_done was accepted (not a budget kill). */
  stoppedAfterDone: z.boolean().optional(),
  /** RL-26: killed on a person's request (a `run_stop` message); it finishes as `killed_operator`. */
  stoppedByOperator: z.boolean().optional(),
  stopReason: z.string().optional(),
  /** RL-26: who asked (`by`, `via`), for the owner notice at the end. */
  stoppedBy: z.object({ by: z.string(), via: z.string().optional() }).optional(),
  endedAt: z.number().optional(),
  exitCode: z.number().int().optional(),
  exit: RunExit.optional(),
  profile: z.object({ name: z.string(), sha256: z.string(), base: ProfileBase }),
  budget: z.object({ turns: z.number().int(), minutes: z.number().int(), usd: z.number().optional() }),
  agent: z.object({ name: z.string(), key: z.string(), hash: z.string() }).optional(),
});
export type RunFile = z.infer<typeof RunFile>;
