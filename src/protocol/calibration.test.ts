// RL-6 AC-01 (unit): `DismissalRef`, `GoalCalibration`, `Goal.calibration` and the `calibration`
// input keyword of `StepPolicy.inputs`. Written from the spec's contracts only (docs/specs/RL-6.md).
// New exports are read loosely so the file compiles before they exist; a missing export fails its test.

import { describe, expect, it } from "vitest";
import * as protocol from "./index.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- new exports, read loosely
const P = protocol as any;

const T0 = Date.UTC(2026, 10, 19, 12);
const KEY = "alpha/auditor";
const HA = "a".repeat(64);
const goal = { id: "G1", title: "Calibrate", ownerId: "ann", state: "in_progress", priority: 0, createdAt: T0, updatedAt: T0 };
const ref = (fp: string, at: number) => ({ lineage: "-|/src/alpha|auditor", fp, goal: "G0", step: "G0.validate", round: 1, at });
const R1 = ref("aaaaaaaaaaaaaaaa", T0 - 2);
const R2 = ref("bbbbbbbbbbbbbbbb", T0 - 1);
const CAL = { key: KEY, hash: HA, threshold: 3, dismissals: [R1, R2] };

describe("RL-6 AC-01 calibration schemas", () => {
  it("test_AC01_goal_calibration", () => {
    const g = P.Goal.parse({ ...goal, calibration: CAL });
    expect(g.calibration).toStrictEqual(CAL);
    expect(g.calibration.dismissals.map((d: { fp: string }) => d.fp)).toStrictEqual([R1.fp, R2.fp]);
    // threshold must be ≥ 1.
    expect(P.Goal.safeParse({ ...goal, calibration: { ...CAL, threshold: 0 } }).success).toBe(false);
    expect(P.Goal.safeParse({ ...goal, calibration: { ...CAL, threshold: 1.5 } }).success).toBe(false);
    // A ref's round is an integer.
    expect(P.Goal.safeParse({ ...goal, calibration: { ...CAL, dismissals: [{ ...R1, round: 1.5 }] } }).success).toBe(false);
    // A goal without calibration has no calibration key.
    const plain = P.Goal.parse(goal);
    expect("calibration" in plain).toBe(false);
  });

  it("test_AC01_exported_schemas", () => {
    expect(P.DismissalRef.parse(R1)).toStrictEqual(R1);
    expect(P.DismissalRef.safeParse({ ...R1, round: "1" }).success).toBe(false);
    expect(P.GoalCalibration.parse(CAL)).toStrictEqual(CAL);
    expect(P.GoalCalibration.parse({ ...CAL, threshold: 1 }).threshold).toBe(1);
    expect(P.GoalCalibration.safeParse({ ...CAL, threshold: 0 }).success).toBe(false);
  });

  it("test_AC01_step_policy_calibration_input", () => {
    const pol = P.StepPolicy.parse({ inputs: ["calibration"] });
    expect(pol.inputs).toStrictEqual(["calibration"]);
    // Control: the RL-2 keyword parses the same way.
    expect(P.StepPolicy.parse({ inputs: ["dispositions"] }).inputs).toStrictEqual(["dispositions"]);
  });
});
