// MM-4 AC-11 (protocol side): `MessageRequest` gains `to`; one of toSid, to or toStep is required.
import { describe, expect, it } from "vitest";
import { MessageRequest } from "./index.ts";

describe("AC-11 MessageRequest.to", () => {
  it("test_AC11_schema_refine", () => {
    const r = MessageRequest.safeParse({ text: "x" });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.message)).toContain("toSid, to or toStep is required");
    // Positive control: each one of the three alone is enough.
    for (const body of [{ toSid: "s1", text: "x" }, { toStep: "G1.a", text: "x" }, { to: "a1/perf", text: "x" }]) expect(MessageRequest.safeParse(body).success, JSON.stringify(body)).toBe(true);
  });

  it("test_AC11_schema_to", () => {
    expect(MessageRequest.parse({ to: "a1/perf", text: "x" })).toMatchObject({ to: "a1/perf", text: "x" });
    expect(MessageRequest.safeParse({ to: "", text: "x" }).success).toBe(false);
    expect(MessageRequest.safeParse({ to: "m".repeat(200), text: "x" }).success).toBe(true);
    expect(MessageRequest.safeParse({ to: "m".repeat(201), text: "x" }).success).toBe(false);
    expect(MessageRequest.safeParse({ to: 3, text: "x" }).success).toBe(false);
  });
});
