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
