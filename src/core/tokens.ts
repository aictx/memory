import { memoryError, type JsonValue } from "./errors.js";
import { err, ok, type Result } from "./result.js";

export const MIN_TOKEN_BUDGET_EXCLUSIVE = 500;
export const MAX_TOKEN_BUDGET = 50000;
export const TOKEN_CHARS_PER_TOKEN = 4;

export interface NormalizeTokenBudgetInput {
  requestedBudget?: number;
}

export interface NormalizedTokenBudget {
  tokenTarget: number | null;
  wasCapped: boolean;
}

export function estimateTokenCount(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  return Math.ceil(text.length / TOKEN_CHARS_PER_TOKEN);
}

export function normalizeTokenBudget(
  input: NormalizeTokenBudgetInput = {}
): Result<NormalizedTokenBudget> {
  if (input.requestedBudget === undefined) {
    return ok({
      tokenTarget: null,
      wasCapped: false
    });
  }

  if (!isValidRequestedBudget(input.requestedBudget)) {
    return invalidTokenBudget(input.requestedBudget);
  }

  const tokenTarget = Math.min(input.requestedBudget, MAX_TOKEN_BUDGET);

  return ok({
    tokenTarget,
    wasCapped: tokenTarget !== input.requestedBudget
  });
}

function isValidRequestedBudget(value: number): boolean {
  return isSafeIntegerAboveMinimum(value);
}

function isSafeIntegerAboveMinimum(value: number): boolean {
  return Number.isSafeInteger(value) && value > MIN_TOKEN_BUDGET_EXCLUSIVE;
}

function invalidTokenBudget<T>(actual: number): Result<T> {
  return err(
    memoryError("MemoryValidationFailed", "Token budget must be an integer greater than 500.", {
      field: "token_budget",
      minimumExclusive: MIN_TOKEN_BUDGET_EXCLUSIVE,
      maximum: MAX_TOKEN_BUDGET,
      actual: numberDetail(actual)
    })
  );
}

function numberDetail(value: number): JsonValue {
  if (Number.isNaN(value)) {
    return "NaN";
  }

  if (value === Infinity) {
    return "Infinity";
  }

  if (value === -Infinity) {
    return "-Infinity";
  }

  return value;
}
