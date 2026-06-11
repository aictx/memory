import { describe, expect, it } from "vitest";

import {
  AGENT_GUIDANCE_MARKERS,
  applyMarkedSection,
  buildMarkedSectionBlock,
  extractMarkedSection,
  PRODUCT_MAP_MARKERS
} from "../../../src/storage/marked-section.js";

const guidanceBlock = buildMarkedSectionBlock(AGENT_GUIDANCE_MARKERS, "guidance body");
const mapBlock = buildMarkedSectionBlock(PRODUCT_MAP_MARKERS, "map body");

describe("applyMarkedSection", () => {
  it("appends the block to files without markers", () => {
    const result = applyMarkedSection("# Existing\n", AGENT_GUIDANCE_MARKERS, guidanceBlock);

    expect(result).toEqual({
      status: "updated",
      contents: `# Existing\n\n${guidanceBlock}`
    });
  });

  it("is idempotent: re-applying the same block is a no-op", () => {
    const first = applyMarkedSection("# Existing\n", AGENT_GUIDANCE_MARKERS, guidanceBlock);

    expect(first.status).toBe("updated");
    if (first.status !== "updated") {
      return;
    }

    const second = applyMarkedSection(first.contents, AGENT_GUIDANCE_MARKERS, guidanceBlock);

    expect(second.status).toBe("updated");
    if (second.status === "updated") {
      expect(second.contents).toBe(first.contents);
    }
  });

  it("replaces only between markers and preserves surrounding content", () => {
    const contents = [
      "# Heading",
      "",
      AGENT_GUIDANCE_MARKERS.start,
      "old body",
      AGENT_GUIDANCE_MARKERS.end,
      "",
      "Tail line."
    ].join("\n");

    const result = applyMarkedSection(contents, AGENT_GUIDANCE_MARKERS, guidanceBlock);

    expect(result.status).toBe("updated");
    if (result.status !== "updated") {
      return;
    }

    expect(result.contents).toContain("# Heading");
    expect(result.contents).toContain("Tail line.");
    expect(result.contents).toContain("guidance body");
    expect(result.contents).not.toContain("old body");
  });

  it("keeps two marker sets in one file independent", () => {
    const contents = `# Top\n\n${guidanceBlock}\n${mapBlock}`;
    const newMapBlock = buildMarkedSectionBlock(PRODUCT_MAP_MARKERS, "fresh map body");

    const result = applyMarkedSection(contents, PRODUCT_MAP_MARKERS, newMapBlock);

    expect(result.status).toBe("updated");
    if (result.status !== "updated") {
      return;
    }

    expect(result.contents).toContain("guidance body");
    expect(result.contents).toContain("fresh map body");
    expect(result.contents).not.toContain("\nmap body\n");

    const guidanceAgain = applyMarkedSection(
      result.contents,
      AGENT_GUIDANCE_MARKERS,
      buildMarkedSectionBlock(AGENT_GUIDANCE_MARKERS, "fresh guidance body")
    );

    expect(guidanceAgain.status).toBe("updated");
    if (guidanceAgain.status === "updated") {
      expect(guidanceAgain.contents).toContain("fresh guidance body");
      expect(guidanceAgain.contents).toContain("fresh map body");
    }
  });

  it("skips missing markers when appendIfMissing is disabled", () => {
    const result = applyMarkedSection("# Existing\n", PRODUCT_MAP_MARKERS, mapBlock, {
      appendIfMissing: false
    });

    expect(result).toEqual({ status: "skipped" });
  });

  it("skips ambiguous or out-of-order markers", () => {
    const duplicated = `${PRODUCT_MAP_MARKERS.start}\n${PRODUCT_MAP_MARKERS.start}\nbody\n${PRODUCT_MAP_MARKERS.end}\n`;
    const reversed = `${PRODUCT_MAP_MARKERS.end}\nbody\n${PRODUCT_MAP_MARKERS.start}\n`;
    const startOnly = `${PRODUCT_MAP_MARKERS.start}\n`;

    expect(applyMarkedSection(duplicated, PRODUCT_MAP_MARKERS, mapBlock)).toEqual({
      status: "skipped"
    });
    expect(applyMarkedSection(reversed, PRODUCT_MAP_MARKERS, mapBlock)).toEqual({
      status: "skipped"
    });
    expect(applyMarkedSection(startOnly, PRODUCT_MAP_MARKERS, mapBlock)).toEqual({
      status: "skipped"
    });
  });
});

describe("extractMarkedSection", () => {
  it("returns the body between markers", () => {
    expect(extractMarkedSection(`prefix\n${mapBlock}suffix\n`, PRODUCT_MAP_MARKERS)).toBe(
      "map body"
    );
  });

  it("returns null when markers are missing or ambiguous", () => {
    expect(extractMarkedSection("no markers", PRODUCT_MAP_MARKERS)).toBeNull();
    expect(
      extractMarkedSection(`${mapBlock}${mapBlock}`, PRODUCT_MAP_MARKERS)
    ).toBeNull();
  });
});
