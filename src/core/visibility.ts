// Who may see a session in hub listings (MM-1): /v1/live, /v1/fleet, and messaging by sid.

import type { ShareLevel } from "../protocol/index.ts";

/**
 * True when the viewer owns the session, the session holds a step, or its machine shares its
 * sessions with the team (`all`). `share` is the stored share level of the session's machine;
 * `steps`, `me` and absent (a daemon that never reported one) show a no-step session to its owner only.
 */
export function sessionVisible(viewerId: string, s: { userId: string; step?: string | undefined }, share: ShareLevel | undefined): boolean {
  return s.userId === viewerId || s.step !== undefined || share === "all";
}
