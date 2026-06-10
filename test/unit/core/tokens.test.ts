import { describe, expect, it } from "vitest";

import {
  MAX_TOKEN_BUDGET,
  estimateTokenCount,
  normalizeTokenBudget
} from "../../../src/core/tokens.js";

describe("context token estimation", () => {
  it("estimates tokens from character count deterministically", () => {
    expect(estimateTokenCount("")).toBe(0);
    expect(estimateTokenCount("a")).toBe(1);
    expect(estimateTokenCount("abcd")).toBe(1);
    expect(estimateTokenCount("abcde")).toBe(2);
    expect(estimateTokenCount("x".repeat(41))).toBe(11);
  });

  it("returns the same estimate for repeated calls", () => {
    const text = "Deterministic token counting uses approximate character length.";

    expect(estimateTokenCount(text)).toBe(estimateTokenCount(text));
  });
});

describe("context token budget normalization", () => {
  it("returns no token target when no budget is explicitly requested", () => {
    const result = normalizeTokenBudget();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        tokenTarget: null,
        wasCapped: false
      });
    }
  });

  it("rejects explicitly requested budgets that are not valid integers above the minimum", () => {
    for (const requestedBudget of [0, 500, 499, 500.5, Number.NaN, Infinity, -Infinity]) {
      const result = normalizeTokenBudget({ requestedBudget });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("MemoryValidationFailed");
        expect(result.error.details).toMatchObject({
          field: "token_budget",
          minimumExclusive: 500,
          maximum: 50000
        });
      }
    }
  });

  it("preserves requested budgets above the minimum", () => {
    const result = normalizeTokenBudget({ requestedBudget: 501 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        tokenTarget: 501,
        wasCapped: false
      });
    }
  });

  it("caps requested budgets above the maximum", () => {
    const result = normalizeTokenBudget({ requestedBudget: 50001 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        tokenTarget: MAX_TOKEN_BUDGET,
        wasCapped: true
      });
    }
  });
});
