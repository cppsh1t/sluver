import { describe, expect, it } from "vitest";

import { formatDurationMs } from "./format";

describe("formatDurationMs", () => {
  it("renders zero as a real zero", () => {
    expect(formatDurationMs(0)).toBe("0ms");
  });

  it("renders sub-second durations as rounded whole ms", () => {
    expect(formatDurationMs(230.4)).toBe("230ms");
  });

  it("rounds before the <1000 branch check, so 999.6 crosses to 1000ms", () => {
    // 999.6 < 1000 takes the ms branch, but Math.round(999.6) === 1000 —
    // the honest output is "1000ms", not "1s". Asserting actual behavior.
    expect(formatDurationMs(999.6)).toBe("1000ms");
  });

  it("renders seconds with one decimal", () => {
    expect(formatDurationMs(1400)).toBe("1.4s");
  });

  it("drops a trailing .0 on whole seconds", () => {
    expect(formatDurationMs(5000)).toBe("5s");
  });

  it("renders an exact minute without a seconds part", () => {
    expect(formatDurationMs(60_000)).toBe("1m");
  });

  it("renders minutes with rounded leftover seconds", () => {
    expect(formatDurationMs(123_456)).toBe("2m 3s");
  });
});
