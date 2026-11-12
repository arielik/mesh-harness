// MM-3 AC-14: hub YAML `thresholds.offer_expiry` gives `thresholds.offerExpiryMs` (default 30 min).

import { describe, expect, it } from "vitest";
import { buildHubConfig } from "./config.ts";

describe("AC-14 offer expiry threshold", () => {
  const raw = { auth: { providers: [{ kind: "none" }] } };
  const thresholds = (c: ReturnType<typeof buildHubConfig>) => c.thresholds as unknown as Record<string, number>;

  it("test_AC14_config_duration", () => {
    const set = buildHubConfig({ ...raw, thresholds: { offer_expiry: "5m" } }, { baseDir: "/srv", env: {} });
    expect(thresholds(set).offerExpiryMs).toBe(300_000);
    const unset = buildHubConfig(raw, { baseDir: "/srv", env: {} });
    expect(thresholds(unset).offerExpiryMs).toBe(1_800_000);
    // Positive control: an existing threshold parses next to it.
    const both = buildHubConfig({ ...raw, thresholds: { takeover_after: "90m", offer_expiry: "45m" } }, { baseDir: "/srv", env: {} });
    expect(thresholds(both).takeoverAfterMs).toBe(90 * 60_000);
    expect(thresholds(both).offerExpiryMs).toBe(45 * 60_000);
  });
});

// RL-1 AC-09 (config): hub YAML `artifacts` gives `HubConfig.artifacts`.
describe("artifacts", () => {
  const raw = { auth: { providers: [{ kind: "none" }] } };
  const artifacts = (c: ReturnType<typeof buildHubConfig>) => (c as unknown as { artifacts?: unknown }).artifacts;

  it("test_AC09_config_parse", () => {
    const set = buildHubConfig({ ...raw, artifacts: { max_bytes: 100, per_round: 2, retention_days: 0 } }, { baseDir: "/srv", env: {} });
    expect(artifacts(set)).toStrictEqual({ maxBytes: 100, perRound: 2, retentionDays: 0 });
    const unset = buildHubConfig(raw, { baseDir: "/srv", env: {} });
    expect(artifacts(unset)).toStrictEqual({ maxBytes: 1_048_576, perRound: 10, retentionDays: 365 });
    const partial = buildHubConfig({ ...raw, artifacts: { retention_days: 30 } }, { baseDir: "/srv", env: {} });
    expect(artifacts(partial)).toStrictEqual({ maxBytes: 1_048_576, perRound: 10, retentionDays: 30 });
  });
});

// RL-6 AC-01 (config): hub YAML `calibration: { threshold: <int ≥ 1> }` gives
// `HubConfig.calibration.threshold` (default 5). Written from the spec's contracts only (docs/specs/RL-6.md).
describe("RL-6 calibration threshold", () => {
  const raw = { auth: { providers: [{ kind: "none" }] } };
  const threshold = (c: ReturnType<typeof buildHubConfig>) => (c as unknown as { calibration?: { threshold?: number } }).calibration?.threshold;
  const build = (calibration: unknown) => buildHubConfig({ ...raw, calibration }, { baseDir: "/srv", env: {} });

  it("test_AC01_config_threshold", () => {
    expect(threshold(buildHubConfig(raw, { baseDir: "/srv", env: {} }))).toBe(5);
    expect(threshold(build({ threshold: 2 }))).toBe(2);
    expect(threshold(build({ threshold: 1 }))).toBe(1);
    for (const bad of [0, -1, 1.5, "3"]) expect(() => build({ threshold: bad }), String(bad)).toThrow();
  });
});
