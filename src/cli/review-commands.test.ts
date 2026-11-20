// RL-18 AC-09 (unit): `mesh debrief` starts a spot-check step with its own prompt (docs/specs/RL-18.md).

import { describe, expect, it } from "vitest";
import { debriefPrompt } from "./review-commands.ts";

describe("RL-18 AC-09 debrief prompt", () => {
  it("test_AC09_debrief_prompt", () => {
    expect(debriefPrompt("G4.check", true)).toBe(
      "You hold the mesh spot-check step G4.check. Use the mesh-debrief skill, section Spot checks: call mesh_context, then go through the sampled decisions with me one at a time. Record each verdict with mesh_spot_check, then submit the review record with mesh_review and finish with mesh_done.",
    );
    expect(debriefPrompt("G4.debrief")).toBe(
      "You hold the mesh debrief step G4.debrief. Use the mesh-debrief skill: call mesh_context, then go through the items with me one at a time, highest severity first. Record each decision with mesh_dispose, then submit the debrief's review record with mesh_review and finish with mesh_done.",
    );
  });
});
