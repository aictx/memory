import { readdir } from "node:fs/promises";
import { basename } from "node:path";

import { describe, expect, it } from "vitest";

import { main, type CliOutputWriter } from "../../../src/cli/main.js";

describe("memory docs", () => {
  it("lists bundled public docs topics", async () => {
    const output = createCapturedOutput();

    const exitCode = await main(["node", "memory", "docs"], output.writers);

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");
    expect(output.stdout()).toContain("Memory docs: https://docs.aictx.dev/");
    expect(output.stdout()).toContain("- getting-started:");
    expect(output.stdout()).toContain("- mental-model:");
    expect(output.stdout()).toContain("- capabilities:");
    expect(output.stdout()).toContain("- cli:");
    expect(output.stdout()).toContain("- mcp:");
    expect(output.stdout()).toContain("- agent-integration:");
    expect(output.stdout()).toContain("- plugin-publishing:");
    expect(output.stdout()).toContain("- viewer:");
    expect(output.stdout()).toContain("- troubleshooting:");
    expect(output.stdout()).toContain("- reference:");
  });

  it("keeps the topic list aligned with bundled docs pages", async () => {
    const output = createCapturedOutput();

    const exitCode = await main(["node", "memory", "--json", "docs"], output.writers);

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");

    const envelope = JSON.parse(output.stdout()) as {
      ok: true;
      data: {
        kind: "list";
        topics: { topic: string }[];
      };
    };
    const bundledDocs = await readdir(
      new URL("../../../docs/src/content/docs/", import.meta.url)
    );
    const docTopics = bundledDocs
      .filter((file) => file.endsWith(".md") && file !== "index.md")
      .map((file) => basename(file, ".md"))
      .sort();
    const listedTopics = envelope.data.topics.map((topic) => topic.topic).sort();

    expect(envelope.ok).toBe(true);
    expect(envelope.data.kind).toBe("list");
    expect(listedTopics).toEqual(docTopics);
  });

  it("prints a bundled topic without Starlight frontmatter", async () => {
    const output = createCapturedOutput();

    const exitCode = await main(["node", "memory", "docs", "quickstart"], output.writers);

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");
    expect(output.stdout()).toContain("# Getting started");
    expect(output.stdout()).toContain("memory init");
    expect(output.stdout()).not.toMatch(/^---\n/u);
  });

  it("returns JSON envelopes for topic output", async () => {
    const output = createCapturedOutput();

    const exitCode = await main(
      ["node", "memory", "--json", "docs", "agents"],
      output.writers
    );

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");
    const envelope = JSON.parse(output.stdout()) as {
      ok: true;
      data: {
        kind: "topic";
        topic: string;
        url: string;
        content: string;
      };
    };

    expect(envelope.ok).toBe(true);
    expect(envelope.data.kind).toBe("topic");
    expect(envelope.data.topic).toBe("agent-integration");
    expect(envelope.data.url).toBe("https://docs.aictx.dev/agent-integration/");
    expect(envelope.data.content).toContain("# Agent integration");
  });

  it("prints the bundled capabilities topic", async () => {
    const output = createCapturedOutput();

    const exitCode = await main(["node", "memory", "docs", "features"], output.writers);

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");
    expect(output.stdout()).toContain("# Capabilities");
    expect(output.stdout()).toContain("memory query");
  });

  it("prints the bundled mental model topic", async () => {
    const output = createCapturedOutput();

    const exitCode = await main(["node", "memory", "docs", "product-graph"], output.writers);

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");
    expect(output.stdout()).toContain("# Mental model");
    expect(output.stdout()).toContain("Anchors");
    expect(output.stdout()).toContain("memory sync");
  });

  it("prints the bundled plugin publishing topic", async () => {
    const output = createCapturedOutput();

    const exitCode = await main(["node", "memory", "docs", "plugin-publishing"], output.writers);

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");
    expect(output.stdout()).toContain("# Publishing Plugins");
    expect(output.stdout()).toContain("codex plugin marketplace add aictx/memory");
    expect(output.stdout()).toContain("claude plugin validate");
  });

  it("opens the hosted docs URL through the injected opener", async () => {
    const output = createCapturedOutput();
    const openedUrls: string[] = [];

    const exitCode = await main(["node", "memory", "docs", "reference", "--open"], {
      ...output.writers,
      docs: {
        opener: (url) => {
          openedUrls.push(url);
        }
      }
    });

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");
    expect(openedUrls).toEqual(["https://docs.aictx.dev/reference/"]);
    expect(output.stdout()).toContain("# Reference");
  });

  it("fails clearly for an unknown topic", async () => {
    const output = createCapturedOutput();

    const exitCode = await main(["node", "memory", "docs", "does-not-exist"], output.writers);

    expect(exitCode).toBe(1);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toContain("Unknown docs topic: does-not-exist");
  });
});

function createCapturedOutput(): {
  writers: { stdout: CliOutputWriter; stderr: CliOutputWriter };
  stdout: () => string;
  stderr: () => string;
} {
  let stdout = "";
  let stderr = "";

  return {
    writers: {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      }
    },
    stdout: () => stdout,
    stderr: () => stderr
  };
}
