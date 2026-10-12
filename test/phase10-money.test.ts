import { describe, it, expect } from "vitest";
import {
  decimalPlaces, scaleOf, toMinorAtScale, fromMinorAtScale, lineTotalAtScale, sumAtScale,
} from "~/lib/bundles/money";

/*
 * Phase 10.1 M4(b) — exact decimal money (no binary floating point).
 */
describe("Phase 10.1 M4b — exact decimal money", () => {
  it("decimalPlaces + scaleOf (minimum 2, honours 3-decimal prices)", () => {
    expect(decimalPlaces("12.345")).toBe(3);
    expect(decimalPlaces("12")).toBe(0);
    expect(scaleOf(["1.00", "2.5"])).toBe(2);
    expect(scaleOf(["1.000", "2.5"])).toBe(3);
    expect(scaleOf([null, undefined, "5"])).toBe(2);
  });

  it("round-trips exact values at a scale", () => {
    expect(fromMinorAtScale(toMinorAtScale("12.34", 2), 2)).toBe("12.34");
    expect(fromMinorAtScale(toMinorAtScale("12.340", 3), 3)).toBe("12.340");
    expect(fromMinorAtScale(toMinorAtScale("7", 2), 2)).toBe("7.00");
  });

  it("0.1 + 0.2 = 0.30 exactly (no float error)", () => {
    expect(sumAtScale(["0.1", "0.2"], 2)).toBe("0.30");
    // and the classic trap with more terms
    expect(sumAtScale(["0.1", "0.1", "0.1"], 2)).toBe("0.30");
  });

  it("line totals: qty > 1, whole numbers, and 3-decimal prices", () => {
    expect(lineTotalAtScale("19.99", 3, 2)).toBe("59.97");
    expect(lineTotalAtScale("10", 2, 2)).toBe("20.00");
    expect(lineTotalAtScale("1.005", 2, 3)).toBe("2.010"); // 3-decimal preserved, no truncation
  });

  it("sums a mix at the bundle-wide scale", () => {
    const scale = scaleOf(["10.00", "1.005", "2"]); // → 3
    expect(scale).toBe(3);
    const lts = [lineTotalAtScale("10.00", 1, scale), lineTotalAtScale("1.005", 2, scale), lineTotalAtScale("2", 1, scale)];
    // 10.000 + 2.010 + 2.000 = 14.010
    expect(sumAtScale(lts, scale)).toBe("14.010");
  });
});
