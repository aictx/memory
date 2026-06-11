import { describe, expect, it } from "vitest";

import {
  generateObjectId,
  generateRelationId,
  isObjectId,
  isRelationId,
  isSlug,
  slugify
} from "../../../src/core/ids.js";

describe("core ID and slug generation", () => {
  describe("slugify", () => {
    it("normalizes titles to lowercase ASCII slugs", () => {
      expect(slugify("Billing retries moved to Queue Worker")).toBe(
        "billing-retries-moved-to-queue-worker"
      );
      expect(slugify("Café déjà vu")).toBe("cafe-deja-vu");
    });

    it("removes or normalizes invalid characters predictably", () => {
      expect(slugify("Bob's “quoted” note")).toBe("bobs-quoted-note");
      expect(slugify("memory/decisions/billing-retries.md")).toBe(
        "memory-decisions-billing-retries-md"
      );
      expect(slugify("alpha---beta___gamma")).toBe("alpha-beta-gamma");
      expect(slugify("Ship 🚀 now!")).toBe("ship-now");
    });

    it("uses a slugified fallback for empty results", () => {
      expect(slugify("🚀🚀🚀")).toBe("untitled");
      expect(slugify("🚀🚀🚀", { fallback: "Fallback Title" })).toBe("fallback-title");
      expect(slugify("🚀🚀🚀", { fallback: "!!!" })).toBe("untitled");
    });

    it("validates slug strings", () => {
      expect(isSlug("billing-retries")).toBe(true);
      expect(isSlug("billing--retries")).toBe(true);
      expect(isSlug("Billing")).toBe(false);
      expect(isSlug("-billing")).toBe(false);
      expect(isSlug("billing_ retries")).toBe(false);
    });
  });

  describe("generateObjectId", () => {
    it("generates object IDs from type and slugified title", () => {
      const id = generateObjectId({
        type: "decision",
        title: "Billing retries moved to Queue Worker"
      });

      expect(id).toBe("decision.billing-retries-moved-to-queue-worker");
      expect(isObjectId(id)).toBe(true);
    });

    it("adds deterministic suffixes when object IDs collide", () => {
      expect(
        generateObjectId({
          type: "gotcha",
          title: "Stripe webhook behavior",
          existingIds: ["gotcha.stripe-webhook-behavior"]
        })
      ).toBe("gotcha.stripe-webhook-behavior-2");

      expect(
        generateObjectId({
          type: "gotcha",
          title: "Stripe webhook behavior",
          existingIds: ["gotcha.stripe-webhook-behavior", "gotcha.stripe-webhook-behavior-2"]
        })
      ).toBe("gotcha.stripe-webhook-behavior-3");
    });

    it("uses fallback slug text for empty object titles", () => {
      expect(generateObjectId({ type: "question", title: "💡" })).toBe("question.untitled");
    });
  });

  describe("generateRelationId", () => {
    it("generates type-qualified relation IDs from endpoints and predicate", () => {
      const id = generateRelationId({
        from: "decision.billing-retries",
        predicate: "affects",
        to: "feature.webhook-idempotency"
      });

      expect(id).toBe(
        "rel.decision-billing-retries-affects-feature-webhook-idempotency"
      );
      expect(isRelationId(id)).toBe(true);
    });

    it("normalizes underscore predicates in relation IDs", () => {
      expect(
        generateRelationId({
          from: "decision.billing-retries",
          predicate: "depends_on",
          to: "feature.billing"
        })
      ).toBe("rel.decision-billing-retries-depends-on-feature-billing");
    });

    it("adds deterministic suffixes when relation IDs collide", () => {
      const existingIds = [
        "rel.decision-billing-retries-affects-feature-webhook-idempotency",
        "rel.decision-billing-retries-affects-feature-webhook-idempotency-2"
      ];

      expect(
        generateRelationId({
          from: "decision.billing-retries",
          predicate: "affects",
          to: "feature.webhook-idempotency",
          existingIds
        })
      ).toBe("rel.decision-billing-retries-affects-feature-webhook-idempotency-3");
    });

    it("rejects invalid relation endpoints", () => {
      expect(() =>
        generateRelationId({
          from: "not-an-object-id",
          predicate: "affects",
          to: "feature.webhook-idempotency"
        })
      ).toThrow("Invalid object ID: not-an-object-id");
    });
  });
});
