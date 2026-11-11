// MM-2 AC-01: parseLabels, Label, LABEL_RULE, MAX_LABELS and Session.labels (src/protocol).

import { describe, expect, it } from "vitest";
import { Label, LABEL_RULE, MAX_LABELS, parseLabels, Session } from "./index.ts";

// Copied from the spec, not imported, so a changed text turns the tests red.
const RULE = "a label is 1-40 characters: lowercase letters, digits, '.', '_' or '-', starting with a letter or digit";

/** n distinct valid labels l01 … lnn. */
const L = (n: number) => Array.from({ length: n }, (_, i) => `l${String(i + 1).padStart(2, "0")}`);

const minimalSession = {
  sid: "s1",
  claudeSessionIds: ["c-s1"],
  cwd: "/w",
  kind: "interactive",
  state: "idle",
  quiet: false,
  startedAt: 1,
  lastEventAt: 1,
  turns: 0,
  humanPrompts: 0,
  seenByReconciler: false,
};

describe("AC-01 parseLabels", () => {
  it("test_AC01_string_split_trim_lower_dedupe_sort", () => {
    expect(parseLabels("Perf, gpu,perf")).toStrictEqual({ labels: ["gpu", "perf"] });
  });

  it("test_AC01_array_input_sorted", () => {
    expect(parseLabels(["b", "a"])).toStrictEqual({ labels: ["a", "b"] });
  });

  it("test_AC01_empty_inputs", () => {
    expect(parseLabels("")).toStrictEqual({ labels: [] });
    expect(parseLabels(" , ")).toStrictEqual({ labels: [] });
    expect(parseLabels([])).toStrictEqual({ labels: [] });
  });

  it("test_AC01_invalid_item_error_text", () => {
    expect(LABEL_RULE).toBe(RULE);
    expect(parseLabels("a b")).toStrictEqual({ error: `not a label: a b (${RULE})` });
    // Trimmed as given: surrounding blanks are not in the message.
    expect(parseLabels("ok,  a b  ")).toStrictEqual({ error: `not a label: a b (${RULE})` });
  });

  it("test_AC01_leading_dash_rejected", () => {
    const one = parseLabels("-x");
    expect("error" in one && one.error).toBe(`not a label: -x (${RULE})`);
    // The first bad item is named.
    const two = parseLabels(["ok", "-x", "_y"]);
    expect(two).toStrictEqual({ error: `not a label: -x (${RULE})` });
  });

  it("test_AC01_max_10", () => {
    expect(MAX_LABELS).toBe(10);
    expect(parseLabels(L(10))).toStrictEqual({ labels: L(10) });
    expect(parseLabels(L(11))).toStrictEqual({ error: "at most 10 labels" });
    expect(parseLabels(L(11).join(","))).toStrictEqual({ error: "at most 10 labels" });
    // Repeats (also after lowercasing) do not count.
    expect(parseLabels([...L(10), "l01", "L01"])).toStrictEqual({ labels: L(10) });
  });

  it("test_AC01_length_40_41", () => {
    expect(parseLabels("a".repeat(40))).toStrictEqual({ labels: ["a".repeat(40)] });
    const long = parseLabels("a".repeat(41));
    expect(long).toStrictEqual({ error: `not a label: ${"a".repeat(41)} (${RULE})` });
  });

  it("test_AC01_allowed_chars_and_all", () => {
    expect(parseLabels("a.b,c_d,e-f,9x,all")).toStrictEqual({ labels: ["9x", "a.b", "all", "c_d", "e-f"] });
    // Code-point order, not locale order: digits before letters, '-' (0x2d) before '.' (0x2e) before '_' (0x5f).
    expect(parseLabels(["a_", "a.", "a-", "a0"])).toStrictEqual({ labels: ["a-", "a.", "a0", "a_"] });
  });
});

describe("AC-01 Label and Session.labels", () => {
  it("test_AC01_Label_schema", () => {
    expect(Label.safeParse("gpu").success).toBe(true);
    for (const bad of ["GPU", "a b", "", "-x", "a".repeat(41)]) {
      const r = Label.safeParse(bad);
      expect(r.success, bad).toBe(false);
      if (!r.success) expect(r.error.issues[0]?.message).toBe(RULE);
    }
    // The schema does not lowercase: "GPU" is refused, not turned into "gpu".
    expect(Label.safeParse("a".repeat(40)).success).toBe(true);
  });

  it("test_AC01_Session_labels_field", () => {
    const ten = Session.parse({ ...minimalSession, labels: L(10) });
    expect(ten.labels).toStrictEqual(L(10));
    for (const labels of [L(11), ["bad label"], ["Gpu"]]) {
      expect(Session.safeParse({ ...minimalSession, labels }).success, JSON.stringify(labels)).toBe(false);
    }
    const plain = Session.parse(minimalSession);
    expect(Object.hasOwn(plain, "labels")).toBe(false);
  });
});
