import { describe, expect, it } from "vitest";

import type { AnchorVerification } from "../../../src/anchors/verify.js";
import { estimateTokenCount } from "../../../src/core/tokens.js";
import type { FeatureStage, ObjectStatus, ObjectType } from "../../../src/core/types.js";
import {
  PRODUCT_MAP_EMPTY_PLACEHOLDER,
  PRODUCT_MAP_HEADER,
  PRODUCT_MAP_TOKEN_CAP,
  renderProductMap
} from "../../../src/map/render.js";
import type { StoredMemoryObject } from "../../../src/storage/objects.js";

interface MakeObjectOptions {
  id: string;
  type: ObjectType;
  title?: string;
  body?: string;
  status?: ObjectStatus;
  stage?: FeatureStage;
  anchors?: string[];
  updatedAt?: string;
}

function makeObject(options: MakeObjectOptions): StoredMemoryObject {
  const title = options.title ?? options.id;

  return {
    path: `.memory/memory/${options.id}.json`,
    bodyPath: `.memory/memory/${options.id}.md`,
    body: options.body ?? `# ${title}\n\nBody of ${title}.\n`,
    sidecar: {
      id: options.id,
      type: options.type,
      status: options.status ?? (options.type === "question" ? "open" : "active"),
      title,
      body_path: `memory/${options.id}.md`,
      ...(options.stage === undefined ? {} : { stage: options.stage }),
      ...(options.anchors === undefined ? {} : { anchors: options.anchors }),
      content_hash: "0".repeat(64),
      created_at: "2026-01-01T00:00:00Z",
      updated_at: options.updatedAt ?? "2026-01-02T00:00:00Z"
    }
  };
}

const projectNode = makeObject({
  id: "project.demo",
  type: "project",
  title: "Demo",
  body: "# Demo\n\nLocal-first product memory for coding agents. More detail later.\n"
});

describe("renderProductMap", () => {
  it("groups active features in stage order and excludes dead and inactive ones", () => {
    const body = renderProductMap({
      objects: [
        projectNode,
        makeObject({ id: "feature.idea-one", type: "feature", stage: "idea" }),
        makeObject({ id: "feature.paused-one", type: "feature", stage: "paused" }),
        makeObject({
          id: "feature.building-one",
          type: "feature",
          stage: "building",
          body: "# Building one\n\nDoes the building thing.\n",
          anchors: ["src/build/", "src/extra/"]
        }),
        makeObject({ id: "feature.shipped-one", type: "feature", stage: "shipped" }),
        makeObject({ id: "feature.dead-one", type: "feature", stage: "dead" }),
        makeObject({
          id: "feature.stale-one",
          type: "feature",
          stage: "building",
          status: "stale"
        }),
        makeObject({
          id: "feature.superseded-one",
          type: "feature",
          stage: "shipped",
          status: "superseded"
        })
      ]
    });

    expect(body).toContain(PRODUCT_MAP_HEADER);
    expect(body).toContain("Demo — Local-first product memory for coding agents.");
    expect(body).toContain(
      "**Building:** building-one — Does the building thing. — src/build/"
    );
    expect(body).toContain("**Shipped:** shipped-one");
    expect(body).toContain("**Paused:** paused-one");
    expect(body).toContain("**Idea:** idea-one");
    expect(body).not.toContain("dead-one");
    expect(body).not.toContain("stale-one");
    expect(body).not.toContain("superseded-one");

    const buildingIndex = body.indexOf("**Building:**");
    const shippedIndex = body.indexOf("**Shipped:**");
    const pausedIndex = body.indexOf("**Paused:**");
    const ideaIndex = body.indexOf("**Idea:**");
    expect(buildingIndex).toBeLessThan(shippedIndex);
    expect(shippedIndex).toBeLessThan(pausedIndex);
    expect(pausedIndex).toBeLessThan(ideaIndex);
  });

  it("renders recent decisions, open questions, and stale anchors with caps", () => {
    const decisions = Array.from({ length: 7 }, (_, index) =>
      makeObject({
        id: `decision.decision-${index}`,
        type: "decision",
        title: `Decision ${index}`,
        updatedAt: `2026-01-0${index + 1}T00:00:00Z`
      })
    );
    const questions = Array.from({ length: 7 }, (_, index) =>
      makeObject({
        id: `question.question-${index}`,
        type: "question",
        title: `Question ${index}`,
        status: index === 6 ? "closed" : "open"
      })
    );
    const findings: AnchorVerification[] = Array.from({ length: 7 }, (_, index) => ({
      id: `decision.decision-${index}`,
      matched_anchors: [],
      orphaned_anchors: [`src/gone-${index}/`]
    }));

    const body = renderProductMap({
      objects: [projectNode, ...decisions, ...questions],
      anchorFindings: findings
    });

    const decisionsLine = body
      .split("\n")
      .find((line) => line.startsWith("**Recent decisions:**"));
    expect(decisionsLine).toBeDefined();
    expect(decisionsLine).toContain("decision-6 — Decision 6");
    expect(decisionsLine).toContain("decision-2 — Decision 2");
    expect(decisionsLine).not.toContain("decision-1 —");
    expect(decisionsLine).not.toContain("decision-0 —");

    const questionsLine = body
      .split("\n")
      .find((line) => line.startsWith("**Open questions:**"));
    expect(questionsLine).toBeDefined();
    expect((questionsLine?.match(/question-\d/gu) ?? []).length).toBe(5);
    expect(questionsLine).not.toContain("question-6");

    expect(body).toContain("**Stale:** decision.decision-0 — anchor src/gone-0/ matches no files");
    expect((body.match(/matches no files/gu) ?? []).length).toBe(5);
  });

  it("trims intent fragments to 80 characters", () => {
    const longSentence = `This very long feature intent sentence ${"keeps going ".repeat(10)}until done.`;
    const body = renderProductMap({
      objects: [
        projectNode,
        makeObject({
          id: "feature.long-intent",
          type: "feature",
          stage: "building",
          body: `# Long intent\n\n${longSentence}\n`
        })
      ]
    });
    const line = body.split("\n").find((entry) => entry.startsWith("**Building:**"));

    expect(line).toBeDefined();
    const fragment = (line ?? "").replace("**Building:** long-intent — ", "");
    expect(fragment.length).toBeLessThanOrEqual(80);
    expect(fragment.endsWith("…")).toBe(true);
  });

  it("renders the empty-graph placeholder when only the project node exists", () => {
    const body = renderProductMap({ objects: [projectNode] });

    expect(body).toBe(
      [
        PRODUCT_MAP_HEADER,
        "Demo — Local-first product memory for coding agents.",
        "",
        PRODUCT_MAP_EMPTY_PLACEHOLDER
      ].join("\n")
    );
  });

  it("omits empty sections", () => {
    const body = renderProductMap({
      objects: [
        projectNode,
        makeObject({ id: "feature.solo", type: "feature", stage: "building" })
      ]
    });

    expect(body).toContain("**Building:**");
    expect(body).not.toContain("**Shipped:**");
    expect(body).not.toContain("**Recent decisions:**");
    expect(body).not.toContain("**Open questions:**");
    expect(body).not.toContain("**Stale:**");
    expect(body).not.toContain(PRODUCT_MAP_EMPTY_PLACEHOLDER);
  });

  it("drops stale lines and questions before decisions when over the token cap", () => {
    const hugeTitle = `Question with a very long title ${"padding ".repeat(120)}end`;
    const questions = Array.from({ length: 5 }, (_, index) =>
      makeObject({
        id: `question.huge-${index}`,
        type: "question",
        title: hugeTitle
      })
    );
    const decisions = Array.from({ length: 5 }, (_, index) =>
      makeObject({
        id: `decision.kept-${index}`,
        type: "decision",
        title: `Kept decision ${index} ${"padding ".repeat(40)}end`
      })
    );
    const findings: AnchorVerification[] = Array.from({ length: 5 }, (_, index) => ({
      id: `decision.kept-${index}`,
      matched_anchors: [],
      orphaned_anchors: [`src/${"long-segment-".repeat(20)}${index}/`]
    }));

    const body = renderProductMap({
      objects: [projectNode, ...questions, ...decisions],
      anchorFindings: findings
    });

    expect(estimateTokenCount(body)).toBeLessThanOrEqual(PRODUCT_MAP_TOKEN_CAP);
    expect(body).not.toContain("**Stale:**");
    expect(body).toContain("**Recent decisions:**");
    expect((body.match(/kept-\d — Kept decision/gu) ?? []).length).toBe(5);
    const questionCount = (body.match(/huge-\d/gu) ?? []).length;
    expect(questionCount).toBeGreaterThan(0);
    expect(questionCount).toBeLessThan(5);
  });

  it("trims intents and finally drops feature lines from the end of stage groups", () => {
    const longSentence = `Intent sentence ${"that keeps stretching out ".repeat(4)}forever onward.`;
    const features = Array.from({ length: 200 }, (_, index) =>
      makeObject({
        id: `feature.f-${String(index).padStart(3, "0")}`,
        type: "feature",
        stage: index % 2 === 0 ? "building" : "idea",
        body: `# Feature ${index}\n\n${longSentence}\n`,
        updatedAt: `2026-03-${String((index % 28) + 1).padStart(2, "0")}T00:00:00Z`
      })
    );

    const body = renderProductMap({ objects: [projectNode, ...features] });

    expect(estimateTokenCount(body)).toBeLessThanOrEqual(PRODUCT_MAP_TOKEN_CAP);
    expect(body).toContain(PRODUCT_MAP_HEADER);
    expect(body).toContain("Demo — Local-first product memory for coding agents.");
    expect(body).toContain("**Building:**");
    const renderedFeatureCount = (body.match(/f-\d{3} — /gu) ?? []).length;
    expect(renderedFeatureCount).toBeGreaterThan(0);
    expect(renderedFeatureCount).toBeLessThan(200);
    // Intent fragments were trimmed to the short cap before feature lines dropped.
    const firstFeatureFragment = /f-\d{3} — ([^·\n]+)/u.exec(body)?.[1]?.trim() ?? "";
    expect(firstFeatureFragment.length).toBeLessThanOrEqual(40);
  });

  it("always stays under the hard token cap", () => {
    const objects = [
      projectNode,
      ...Array.from({ length: 300 }, (_, index) =>
        makeObject({
          id: `feature.bulk-${index}`,
          type: "feature",
          stage: "shipped",
          body: `# Bulk ${index}\n\n${"Lots of intent text here. ".repeat(10)}\n`
        })
      )
    ];

    const body = renderProductMap({ objects });

    expect(estimateTokenCount(body)).toBeLessThanOrEqual(PRODUCT_MAP_TOKEN_CAP);
  });
});
