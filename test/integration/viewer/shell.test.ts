import { mkdir, mkdtemp, realpath, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type ConsoleMessage, type Page } from "playwright";
import { afterEach, describe, expect, it } from "vitest";

import { main, type CliOutputWriter } from "../../../src/cli/main.js";
import type {
  Evidence,
  ObjectFacets,
  ObjectStatus,
  ObjectType,
  Predicate,
  RelationStatus,
  SourceOrigin
} from "../../../src/core/types.js";
import {
  computeObjectContentHash,
  computeRelationContentHash
} from "../../../src/storage/hashes.js";
import type { MemoryObjectSidecar } from "../../../src/storage/objects.js";
import { readCanonicalStorage } from "../../../src/storage/read.js";
import type { MemoryRelation } from "../../../src/storage/relations.js";
import { startViewerServer } from "../../../src/viewer/server.js";
import {
  FIXED_TIMESTAMP,
  FIXED_TIMESTAMP_NEXT_MINUTE
} from "../../fixtures/time.js";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const viewerAssetsDir = join(repoRoot, "dist", "viewer");
const tempRoots: string[] = [];

interface MemoryFixture {
  id: string;
  type: ObjectType;
  status: ObjectStatus;
  title: string;
  bodyPath: string;
  body: string;
  tags: string[];
  facets?: ObjectFacets;
  evidence?: Evidence[];
  origin?: SourceOrigin;
  updatedAt?: string;
}

interface RelationFixture {
  id: string;
  from: string;
  predicate: Predicate;
  to: string;
  status: RelationStatus;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("read-only viewer shell", () => {
  it("loads bootstrap data, searches objects, renders safe Markdown, JSON, and relations", async () => {
    const assets = await stat(join(viewerAssetsDir, "index.html"));

    expect(assets.isFile()).toBe(true);

    const projectRoot = await createInitializedProject("memory-viewer-shell-project-");
    await writeViewerFixtures(projectRoot);
    await rebuildProjectIndex(projectRoot);
    const memoryHome = await createTempRoot("memory-viewer-shell-home-");
    const started = await startViewerServer({
      cwd: projectRoot,
      assetsDir: viewerAssetsDir,
      memoryHome,
      token: "viewer-shell-token"
    });

    expect(started.ok).toBe(true);
    if (!started.ok) {
      throw new Error(started.error.message);
    }

    let browser: Browser | null = null;

    try {
      browser = await chromium.launch();
      const page = await browser.newPage();
      const consoleErrors = collectPageErrors(page);

      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(started.data.url, { waitUntil: "domcontentloaded" });
      await page.locator('[data-testid="projects-view"]').waitFor();
      await expectSidebarClosed(page);
      await openSidebar(page);
      await page.locator('[data-testid="viewer-search"]').waitFor();
      await page.keyboard.press("Escape");
      await expectSidebarClosed(page);
      await openSidebar(page);
      await page.locator('[data-testid="sidebar-backdrop"]').click({ position: { x: 700, y: 40 } });
      await expectSidebarClosed(page);
      await expectText(page, '[data-testid="projects-view"]', "Projects");
      await expectText(page, '[data-testid="project-list"]', "Current");
      await expectCount(page, '[data-testid="memory-list-view"]', 0);
      await page.getByRole("button", { name: "Open project" }).first().click();
      await expectText(page, '[data-testid="graph-view"]', "Graph");
      await expectText(page, '[data-testid="graph-node-count"]', "11");
      await expectText(page, '[data-testid="graph-relation-count"]', "6");
      await expectText(page, '[data-testid="graph-unlinked-count"]', "2");
      await expectText(page, '[data-testid="graph-inspector"]', "Agent Guidance Synthesis");
      await expectText(page, '[data-testid="graph-inspector"]', "Source: docs/agent-integration.md");
      await openSidebar(page);
      await page.locator('[data-testid="nav-memories"]').click();
      await expectSidebarClosed(page);
      await expectText(page, '[data-testid="memory-list-view"]', "Memory Viewer Shell Project");
      await expectText(page, '[data-testid="memory-list-view"]', "Memory Schema");
      await expectText(page, '[data-testid="memory-list-view"]', "Canonical objects");
      await expectNoText(page, '[data-testid="memory-list-view"]', "Schema projection loaded");
      await expectCount(page, '[data-testid="guided-views-panel"]', 0);
      await expectCount(page, '[data-testid="context-preview-panel"]', 0);
      await page.selectOption('[data-testid="viewer-tag-filter"]', "viewer");
      await expect(objectRowIds(page)).resolves.toEqual([
        "source.agent-integration",
        "synthesis.agent-guidance",
        "decision.viewer-shell",
        "constraint.viewer-markdown",
        "fact.viewer-unrelated-source",
        "fact.viewer-unrelated-target",
        "gotcha.webhook-duplicates",
        "workflow.release-checklist",
        "note.viewer-empty"
      ]);
      await expectText(page, '[data-testid="object-meta-decision.viewer-shell"]', "Edited 2026-04-25 14:01");

      await page.selectOption('[data-testid="viewer-sort"]', "updated-desc");
      await expectText(page, '[data-testid="memory-list-view"]', "Recently edited objects");
      await expect(objectRowIds(page)).resolves.toEqual([
        "synthesis.agent-guidance",
        "decision.viewer-shell",
        "constraint.viewer-markdown",
        "source.agent-integration",
        "fact.viewer-unrelated-source",
        "fact.viewer-unrelated-target",
        "gotcha.webhook-duplicates",
        "workflow.release-checklist",
        "note.viewer-empty"
      ]);

      await page.selectOption('[data-testid="viewer-sort"]', "updated-asc");
      await expectText(page, '[data-testid="memory-list-view"]', "Oldest edited objects");
      await expect(objectRowIds(page)).resolves.toEqual([
        "source.agent-integration",
        "fact.viewer-unrelated-source",
        "fact.viewer-unrelated-target",
        "gotcha.webhook-duplicates",
        "workflow.release-checklist",
        "note.viewer-empty",
        "synthesis.agent-guidance",
        "decision.viewer-shell",
        "constraint.viewer-markdown"
      ]);
      await page.selectOption('[data-testid="viewer-type-filter"]', "constraint");
      await expectCount(page, '[data-testid="object-row-constraint.viewer-markdown"]', 1);
      await expectCount(page, '[data-testid="object-row-decision.viewer-shell"]', 0);
      await page.selectOption('[data-testid="viewer-type-filter"]', "all");
      await page.selectOption('[data-testid="viewer-tag-filter"]', "all");
      await page.selectOption('[data-testid="viewer-sort"]', "type");
      await page.locator('[data-testid="object-row-decision.viewer-shell"]').click();
      await assertSelectedObject(page, "Viewer Shell Layout", "decision.viewer-shell");

      await openSidebar(page);
      await page.locator('[data-testid="nav-graph"]').click();
      await expectSidebarClosed(page);
      await expectText(page, '[data-testid="graph-view"]', "Graph");
      await expectText(page, '[data-testid="graph-node-count"]', "11");
      await expectText(page, '[data-testid="graph-relation-count"]', "6");
      await expectText(page, '[data-testid="graph-unlinked-count"]', "2");
      await expectText(page, '[data-testid="graph-legend"]', "Project");
      await expectText(page, '[data-testid="graph-legend"]', "Provenance");
      await expectCount(page, '[data-testid="relation-graph"]', 1);
      await expectText(page, '[data-testid="graph-inspector"]', "Viewer Markdown Safety");
      await expectText(page, '[data-testid="graph-inspector"]', "Viewer Shell Layout");
      await page.locator('[data-testid="graph-zoom-in"]').click();
      await page.locator('[data-testid="graph-zoom-out"]').click();
      await page.locator('[data-testid="graph-fit"]').click();
      await page.locator('[data-testid="graph-reset-layout"]').click();
      await page.locator('[data-testid="graph-inspector"] button', { hasText: "Viewer Markdown Safety" }).click();
      await expectText(page, '[data-testid="graph-inspector"]', "requires");
      await expectText(page, '[data-testid="graph-inspector"]', "Confidence");
      await expectText(page, '[data-testid="graph-inspector"]', "high");
      await page.locator('[data-testid="graph-inspector"] button', { hasText: "Source node" }).click();
      await expectText(page, '[data-testid="graph-inspector"]', "Viewer Shell Layout");
      await page.locator('[data-testid="graph-inspector"] button', { hasText: "Open in schema browser" }).click();
      await assertSelectedObject(page, "Viewer Shell Layout", "decision.viewer-shell");

      await page.selectOption('[data-testid="viewer-type-filter"]', "decision");
      await expectCount(page, '[data-testid="object-row-decision.viewer-shell"]', 1);
      await expectCount(page, '[data-testid="object-row-constraint.viewer-markdown"]', 0);

      await page.selectOption('[data-testid="viewer-type-filter"]', "all");
      await page.selectOption('[data-testid="viewer-facet-filter"]', "decision-rationale");
      await expectCount(page, '[data-testid="object-row-decision.viewer-shell"]', 1);
      await expectCount(page, '[data-testid="object-row-constraint.viewer-markdown"]', 0);
      await expectText(page, '[data-testid="object-meta-decision.viewer-shell"]', "decision-rationale");
      await page.selectOption('[data-testid="viewer-facet-filter"]', "all");

      await page.selectOption('[data-testid="viewer-type-filter"]', "gotcha");
      await expectCount(page, '[data-testid="object-row-gotcha.webhook-duplicates"]', 1);
      await page.selectOption('[data-testid="viewer-type-filter"]', "workflow");
      await expectCount(page, '[data-testid="object-row-workflow.release-checklist"]', 1);

      await page.selectOption('[data-testid="viewer-type-filter"]', "all");
      await page.selectOption('[data-testid="viewer-status-filter"]', "stale");
      await expectCount(page, '[data-testid="object-row-fact.billing-context"]', 1);
      await expectCount(page, '[data-testid="object-row-decision.viewer-shell"]', 0);

      await page.selectOption('[data-testid="viewer-status-filter"]', "all");

      await page.locator('[data-testid="viewer-layer-inactive"]').click();
      await expectCount(page, '[data-testid="object-row-fact.billing-context"]', 1);
      await expectCount(page, '[data-testid="object-row-decision.viewer-shell"]', 0);

      await page.locator('[data-testid="viewer-layer-memories"]').click();
      await expectCount(page, '[data-testid="object-row-decision.viewer-shell"]', 1);
      await expectCount(page, '[data-testid="object-row-synthesis.agent-guidance"]', 0);
      await expectCount(page, '[data-testid="object-row-workflow.release-checklist"]', 1);

      await page.locator('[data-testid="viewer-layer-sources"]').click();
      await expectCount(page, '[data-testid="object-row-source.agent-integration"]', 1);
      await expectCount(page, '[data-testid="object-row-decision.viewer-shell"]', 0);

      await page.locator('[data-testid="viewer-layer-syntheses"]').click();
      await expectCount(page, '[data-testid="object-row-synthesis.agent-guidance"]', 1);
      await expectCount(page, '[data-testid="object-row-source.agent-integration"]', 0);

      await page.locator('[data-testid="viewer-layer-all"]').click();
      await setViewerSearch(page, "agent guidance provenance");
      await page.locator('[data-testid="object-row-synthesis.agent-guidance"]').click();
      await assertSelectedObject(page, "Agent Guidance Synthesis", "synthesis.agent-guidance");
      await expectText(page, '[data-testid="selected-object"]', "Source: docs/agent-integration.md");
      await expectText(page, '[data-testid="selected-object"]', "derived_from");
      await expectText(page, '[data-testid="selected-object"]', "supports");
      await expectText(page, '[data-testid="selected-object"]', "challenges");
      await expectText(page, '[data-testid="selected-object"]', "Webhook Duplicates");
      await page.getByRole("button", { name: "Source: docs/agent-integration.md" }).first().click();
      await assertSelectedObject(page, "Source: docs/agent-integration.md", "source.agent-integration");
      await expectText(page, '[data-testid="selected-object"]', "file");
      await expectText(page, '[data-testid="selected-object"]', "docs/agent-integration.md");
      await expectText(page, '[data-testid="selected-object"]', "text/markdown");
      await page.locator('[data-testid="object-row-source.agent-integration"]').click();
      await expectText(page, '[data-testid="memory-list-view"]', "Agent Guidance Synthesis");

      await setViewerSearch(page, "markdown safety");
      await page.locator('[data-testid="object-row-constraint.viewer-markdown"]').click();
      await assertSelectedObject(page, "Viewer Markdown Safety", "constraint.viewer-markdown");
      await expectText(page, '[data-testid="selected-object"]', "business-rule");
      await expectText(page, '[data-testid="facet-details"]', "viewer/src/App.svelte");
      await assertMarkdownIsSafe(page);

      await page.locator('[data-testid="object-row-constraint.viewer-markdown"]').click();
      await page.selectOption('[data-testid="viewer-tag-filter"]', "security");
      await expectText(page, '[data-testid="memory-list-view"]', "Viewer Markdown Safety");
      await expectCount(page, '[data-testid="object-row-decision.viewer-shell"]', 0);

      await page.selectOption('[data-testid="viewer-tag-filter"]', "all");
      await setViewerSearch(page, "shell layout");
      await page.locator('[data-testid="object-row-decision.viewer-shell"]').click();
      await assertSelectedObject(page, "Viewer Shell Layout", "decision.viewer-shell");
      await expectText(page, '[data-testid="outgoing-relations"]', "requires");
      await expectText(page, '[data-testid="outgoing-relations"]', "Viewer Markdown Safety");
      await expectNoText(page, '[data-testid="selected-object"]', "Unrelated Source");
      await expectNoText(page, '[data-testid="selected-object"]', "Unrelated Target");
      await expectCount(page, '[data-testid="relation-graph"]', 0);

      await page.locator('[data-testid="relation-card-rel.viewer-shell-requires-markdown"] button').click();
      await assertSelectedObject(page, "Viewer Markdown Safety", "constraint.viewer-markdown");
      await expectText(page, '[data-testid="incoming-relations"]', "Viewer Shell Layout");
      await expectText(page, '[data-testid="incoming-relations"]', "requires");
      await expectNoText(page, '[data-testid="selected-object"]', "Unrelated Source");

      await page.locator('[data-testid="technical-details"] summary').click();
      await expectText(page, '[data-testid="json-view"]', '"id": "constraint.viewer-markdown"');
      await expectText(page, '[data-testid="json-view"]', '"body_path": ".memory/memory/constraints/viewer-markdown.md"');
      await expectText(page, '[data-testid="incoming-relations"]', "Viewer Shell Layout");

      await page.locator('[data-testid="object-row-constraint.viewer-markdown"]').click();
      await expectText(page, '[data-testid="memory-list-view"]', "Viewer Shell Layout");
      await expectCount(page, '[data-testid="object-row-constraint.viewer-markdown"]', 1);

      await setViewerSearch(page, "empty neighborhood");
      await page.locator('[data-testid="object-row-note.viewer-empty"]').click();
      await assertSelectedObject(page, "Viewer Empty Neighborhood", "note.viewer-empty");
      await expectText(page, '[data-testid="outgoing-relations"]', "No outgoing related memories.");
      await expectText(page, '[data-testid="incoming-relations"]', "No incoming related memories.");
      await expectCount(page, '[data-testid="relation-graph"]', 0);
      await page.locator('[data-testid="selected-object-graph"]').click();
      await expectText(page, '[data-testid="graph-view"]', "Graph");
      await expectText(page, '[data-testid="graph-inspector"]', "Viewer Empty Neighborhood");

      expect(await page.evaluate("window.__MEMORY_HTML_EXECUTED")).toBeUndefined();
      expect(consoleErrors()).toEqual([]);
    } finally {
      await browser?.close();
      await started.data.close();
    }
  });

  it("explains the bootstrap workflow when only starter memory exists", async () => {
    const assets = await stat(join(viewerAssetsDir, "index.html"));

    expect(assets.isFile()).toBe(true);

    const projectRoot = await createInitializedProject("memory-viewer-starter-project-");
    const memoryHome = await createTempRoot("memory-viewer-starter-home-");
    const started = await startViewerServer({
      cwd: projectRoot,
      assetsDir: viewerAssetsDir,
      memoryHome,
      token: "viewer-starter-token"
    });

    expect(started.ok).toBe(true);
    if (!started.ok) {
      throw new Error(started.error.message);
    }

    let browser: Browser | null = null;

    try {
      browser = await chromium.launch();
      const page = await browser.newPage();
      const consoleErrors = collectPageErrors(page);

      await page.setViewportSize({ width: 390, height: 780 });
      await page.goto(started.data.url, { waitUntil: "domcontentloaded" });
      await expectSidebarClosed(page);
      await openSidebar(page);
      await page.locator('[data-testid="viewer-search"]').waitFor();
      await expectText(page, '[data-testid="projects-view"]', "Projects");
      await page.getByRole("button", { name: "Close menu" }).click();
      await expectSidebarClosed(page);
      await page.getByRole("button", { name: "Open project" }).first().click();

      await expectText(page, '[data-testid="graph-view"]', "Graph");
      await expectText(page, '[data-testid="graph-mobile-selection"]', "Selected object");
      await expectText(page, '[data-testid="graph-mobile-selection"]', "Current Architecture");
      const mobileGraphBox = await page.locator('[data-testid="relation-graph"]').boundingBox();
      expect(mobileGraphBox?.height).toBeLessThan(390);
      await openSidebar(page);
      await page.locator('[data-testid="nav-memories"]').click();
      await expectSidebarClosed(page);
      await expectText(page, '[data-testid="starter-memory-notice"]', "Starter memory only.");
      await expectText(page, '[data-testid="starter-memory-notice"]', "memory suggest --bootstrap --patch > bootstrap-memory.json");
      await expectText(page, '[data-testid="starter-memory-notice"]', "memory save --file bootstrap-memory.json");
      await expectText(page, '[data-testid="memory-list-view"]', "Memory Schema");
      await expectText(page, '[data-testid="memory-list-view"]', "Canonical objects");
      await expectNoText(page, '[data-testid="memory-list-view"]', "Schema projection loaded");
      await expect(page.locator('[data-testid="schema-context-toggle"]').isVisible()).resolves.toBe(true);
      await expect(page.locator('[data-testid="doc-relation-overview"]').isVisible()).resolves.toBe(true);
      await page.locator('[data-testid="object-row-architecture.current"]').click();
      await expectCount(page, '[data-testid="selected-object"]', 1);
      await expectCount(page, '[data-testid="selected-object-back"]', 1);
      await expectCount(page, '[data-testid="selected-object-graph"]', 1);
      await expect(page.locator('[data-testid="schema-context-toggle"]').isHidden()).resolves.toBe(true);
      await expectText(page, '[data-testid="incoming-relations"]', "related_to");
      await expectCount(page, '[data-testid="relation-graph"]', 0);
      await page.locator('[data-testid="selected-object-back"]').click();
      await expectCount(page, '[data-testid="selected-object"]', 0);
      await expectCount(page, '[data-testid="object-row-architecture.current"]', 1);

      await page.setViewportSize({ width: 1024, height: 760 });
      await page.locator('[data-testid="object-row-architecture.current"]').click();
      await expectCount(page, '[data-testid="selected-object"]', 1);
      await expectCount(page, '[data-testid="selected-object-back"]', 1);
      await expectCount(page, '[data-testid="selected-object-graph"]', 1);
      await expect(page.locator('[data-testid="schema-context-toggle"]').isHidden()).resolves.toBe(true);
      await expect(page.locator('[data-testid="object-row-architecture.current"]').isHidden()).resolves.toBe(true);
      await page.locator('[data-testid="selected-object-graph"]').click();
      await expectText(page, '[data-testid="graph-view"]', "Graph");
      await expectText(page, '[data-testid="graph-inspector"]', "Current Architecture");

      expect(consoleErrors()).toEqual([]);
    } finally {
      await browser?.close();
      await started.data.close();
    }
  });

  it("deletes project memory from the projects page and hides delete controls in demo mode", async () => {
    const assets = await stat(join(viewerAssetsDir, "index.html"));

    expect(assets.isFile()).toBe(true);

    const projectRoot = await createInitializedProject("memory-viewer-delete-project-");
    await writeProjectFile(projectRoot, "src/app.ts", "export const kept = true;\n");
    const memoryHome = await createTempRoot("memory-viewer-delete-home-");
    const started = await startViewerServer({
      cwd: projectRoot,
      assetsDir: viewerAssetsDir,
      memoryHome,
      token: "viewer-delete-token"
    });

    expect(started.ok).toBe(true);
    if (!started.ok) {
      throw new Error(started.error.message);
    }

    let browser: Browser | null = null;

    try {
      const projectsResponse = await fetch(`${started.data.url.replace(/\?.*$/, "")}api/projects?token=viewer-delete-token`);
      const projectsEnvelope = await projectsResponse.json() as {
        ok: true;
        data: { projects: Array<{ registry_id: string; project: { id: string } }> };
      };
      const project = projectsEnvelope.data.projects[0];

      expect(project).toBeDefined();
      if (project === undefined) {
        throw new Error("Expected a registered project for deletion test.");
      }

      browser = await chromium.launch();
      const page = await browser.newPage();
      const consoleErrors = collectPageErrors(page);

      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(started.data.url, { waitUntil: "domcontentloaded" });
      await page.locator('[data-testid="projects-view"]').waitFor();

      await page.getByTestId(`project-delete-${project.registry_id}`).click();
      await expectCount(page, `[data-testid="project-delete-confirm-${project.registry_id}"]`, 1);
      await expect(page.getByTestId(`project-delete-submit-${project.registry_id}`).isDisabled()).resolves.toBe(true);
      await expectText(page, '[data-testid="project-list"]', "Source files");

      await page.getByTestId(`project-delete-confirm-${project.registry_id}`).fill(project.project.id);
      await expect(page.getByTestId(`project-delete-submit-${project.registry_id}`).isEnabled()).resolves.toBe(true);
      await page.getByTestId(`project-delete-submit-${project.registry_id}`).click();

      await page.waitForFunction(
        (testId) => document.querySelector(`[data-testid="${testId}"]`) === null,
        `project-card-${project.registry_id}`
      );
      await expectText(page, '[data-testid="project-delete-status"]', "Deleted .memory");
      await expect(pathExists(join(projectRoot, ".memory"))).resolves.toBe(false);
      await expect(readFile(join(projectRoot, "src/app.ts"), "utf8"))
        .resolves.toBe("export const kept = true;\n");
      expect(consoleErrors()).toEqual([]);
    } finally {
      await browser?.close();
      await started.data.close();
    }

    const demoProjectRoot = await createInitializedProject("memory-viewer-demo-delete-project-");
    const demoHome = await createTempRoot("memory-viewer-demo-delete-home-");
    const demoStarted = await startViewerServer({
      cwd: demoProjectRoot,
      assetsDir: viewerAssetsDir,
      memoryHome: demoHome,
      token: "demo"
    });

    expect(demoStarted.ok).toBe(true);
    if (!demoStarted.ok) {
      throw new Error(demoStarted.error.message);
    }

    try {
      browser = await chromium.launch();
      const page = await browser.newPage();

      await page.goto(demoStarted.data.url, { waitUntil: "domcontentloaded" });
      await page.locator('[data-testid="projects-view"]').waitFor();
      await expect(page.getByText("Delete memory").count()).resolves.toBe(0);
    } finally {
      await browser?.close();
      await demoStarted.data.close();
    }
  });
});

async function assertSelectedObject(page: Page, title: string, id: string): Promise<void> {
  await expectText(page, '[data-testid="selected-object"]', title);
  await expectText(page, '[data-testid="selected-object"]', id);
}

async function assertMarkdownIsSafe(page: Page): Promise<void> {
  const markdown = page.locator('[data-testid="markdown-view"]');

  await expectText(page, '[data-testid="markdown-view"]', "<script>window.__MEMORY_HTML_EXECUTED = true</script>");
  await expectText(page, '[data-testid="markdown-view"]', "<img src=x onerror=\"window.__MEMORY_HTML_EXECUTED = true\">");
  await expectCount(page, '[data-testid="markdown-view"] script', 0);
  await expectCount(page, '[data-testid="markdown-view"] img', 0);
  await expect(markdown.textContent()).resolves.toContain("Verify search works");
}

async function openSidebar(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.locator('[data-testid="viewer-sidebar-drawer"]').waitFor();
}

async function expectSidebarClosed(page: Page): Promise<void> {
  await expectCount(page, '[data-testid="viewer-sidebar-drawer"]', 0);
  await expectCount(page, '[data-testid="sidebar-backdrop"]', 0);
}

async function setViewerSearch(page: Page, query: string): Promise<void> {
  await openSidebar(page);
  await page.fill('[data-testid="viewer-search"]', query);
  await page.getByRole("button", { name: "Close menu" }).click();
  await expectSidebarClosed(page);
}

async function expectText(page: Page, selector: string, expected: string): Promise<void> {
  await page.locator(selector).waitFor();
  await expect(page.locator(selector).textContent()).resolves.toContain(expected);
}

async function expectNoText(page: Page, selector: string, expected: string): Promise<void> {
  await page.locator(selector).waitFor();
  await expect(page.locator(selector).textContent()).resolves.not.toContain(expected);
}

async function expectCount(page: Page, selector: string, expected: number): Promise<void> {
  await expect(page.locator(selector).count()).resolves.toBe(expected);
}

async function objectRowIds(page: Page): Promise<string[]> {
  return page.locator('[data-testid^="object-row-"]').evaluateAll((elements) =>
    elements.map((element) =>
      element.getAttribute("data-testid")?.replace(/^object-row-/, "") ?? ""
    )
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function collectPageErrors(page: Page): () => string[] {
  const errors: string[] = [];

  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });

  return () => errors;
}

async function writeViewerFixtures(projectRoot: string): Promise<void> {
  await writeMemoryObject(projectRoot, {
    id: "constraint.viewer-markdown",
    type: "constraint",
    status: "active",
    title: "Viewer Markdown Safety",
    bodyPath: "memory/constraints/viewer-markdown.md",
    body: [
      "# Viewer Markdown Safety",
      "",
      "Client-side body text includes <script>window.__MEMORY_HTML_EXECUTED = true</script> and <img src=x onerror=\"window.__MEMORY_HTML_EXECUTED = true\"> as inert text.",
      "",
      "- Verify search works",
      "- Keep raw HTML inert",
      ""
    ].join("\n"),
    tags: ["viewer", "security"],
    facets: {
      category: "business-rule",
      applies_to: ["viewer/src/App.svelte"],
      load_modes: ["review"]
    },
    updatedAt: FIXED_TIMESTAMP_NEXT_MINUTE
  });
  await writeMemoryObject(projectRoot, {
    id: "decision.viewer-shell",
    type: "decision",
    status: "active",
    title: "Viewer Shell Layout",
    bodyPath: "memory/decisions/viewer-shell.md",
    body: "# Viewer Shell Layout\n\nThe shell shows a searchable object list and direct relation context.\n",
    tags: ["viewer", "ui"],
    facets: {
      category: "decision-rationale",
      applies_to: ["viewer/src/App.svelte"]
    },
    updatedAt: FIXED_TIMESTAMP_NEXT_MINUTE
  });
  await writeMemoryObject(projectRoot, {
    id: "fact.billing-context",
    type: "fact",
    status: "stale",
    title: "Billing Context",
    bodyPath: "memory/facts/billing-context.md",
    body: "# Billing Context\n\nThis fixture proves unrelated memory can be filtered away.\n",
    tags: ["billing"],
    facets: {
      category: "debugging-fact"
    },
    updatedAt: FIXED_TIMESTAMP
  });
  await writeMemoryObject(projectRoot, {
    id: "note.viewer-empty",
    type: "note",
    status: "active",
    title: "Viewer Empty Neighborhood",
    bodyPath: "memory/notes/viewer-empty.md",
    body: "# Viewer Empty Neighborhood\n\nThis fixture has no direct relation neighborhood.\n",
    tags: ["viewer", "empty"],
    updatedAt: FIXED_TIMESTAMP
  });
  await writeMemoryObject(projectRoot, {
    id: "gotcha.webhook-duplicates",
    type: "gotcha",
    status: "active",
    title: "Webhook Duplicates",
    bodyPath: "memory/gotchas/webhook-duplicates.md",
    body: "# Webhook Duplicates\n\nNever assume webhook delivery is unique.\n",
    tags: ["viewer", "webhook"],
    facets: {
      category: "gotcha"
    },
    updatedAt: FIXED_TIMESTAMP
  });
  await writeMemoryObject(projectRoot, {
    id: "workflow.release-checklist",
    type: "workflow",
    status: "active",
    title: "Release Checklist",
    bodyPath: "memory/workflows/release-checklist.md",
    body: "# Release Checklist\n\nRun pnpm test before publishing.\n",
    tags: ["viewer", "release"],
    facets: {
      category: "workflow",
      load_modes: ["coding", "review"]
    },
    updatedAt: FIXED_TIMESTAMP
  });
  await writeMemoryObject(projectRoot, {
    id: "source.agent-integration",
    type: "source",
    status: "active",
    title: "Source: docs/agent-integration.md",
    bodyPath: "memory/sources/agent-integration.md",
    body: "# Source: docs/agent-integration.md\n\nViewer source fixture for agent guidance provenance.\n",
    tags: ["viewer", "source", "guidance"],
    facets: {
      category: "source",
      applies_to: ["docs/agent-integration.md"],
      load_modes: ["onboarding"]
    },
    evidence: [{ kind: "file", id: "docs/agent-integration.md" }],
    origin: {
      kind: "file",
      locator: "docs/agent-integration.md",
      captured_at: FIXED_TIMESTAMP,
      media_type: "text/markdown"
    },
    updatedAt: FIXED_TIMESTAMP
  });
  await writeMemoryObject(projectRoot, {
    id: "synthesis.agent-guidance",
    type: "synthesis",
    status: "active",
    title: "Agent Guidance Synthesis",
    bodyPath: "memory/syntheses/agent-guidance.md",
    body:
      "# Agent Guidance Synthesis\n\nThis synthesis explains agent guidance provenance for source-backed viewer tests.\n",
    tags: ["viewer", "synthesis", "guidance"],
    facets: {
      category: "agent-guidance",
      applies_to: ["docs/agent-integration.md"],
      load_modes: ["coding", "onboarding"]
    },
    evidence: [{ kind: "source", id: "source.agent-integration" }],
    updatedAt: FIXED_TIMESTAMP_NEXT_MINUTE
  });
  await writeMemoryObject(projectRoot, {
    id: "fact.viewer-unrelated-source",
    type: "fact",
    status: "active",
    title: "Unrelated Source",
    bodyPath: "memory/facts/viewer-unrelated-source.md",
    body: "# Unrelated Source\n\nThis fixture must not appear in another object's selected graph.\n",
    tags: ["viewer", "unrelated"],
    updatedAt: FIXED_TIMESTAMP
  });
  await writeMemoryObject(projectRoot, {
    id: "fact.viewer-unrelated-target",
    type: "fact",
    status: "active",
    title: "Unrelated Target",
    bodyPath: "memory/facts/viewer-unrelated-target.md",
    body: "# Unrelated Target\n\nThis fixture is linked only to the unrelated source.\n",
    tags: ["viewer", "unrelated"],
    updatedAt: FIXED_TIMESTAMP
  });
  await writeRelation(projectRoot, {
    id: "rel.viewer-shell-requires-markdown",
    from: "decision.viewer-shell",
    predicate: "requires",
    to: "constraint.viewer-markdown",
    status: "active"
  });
  await writeRelation(projectRoot, {
    id: "rel.viewer-unrelated-affects-target",
    from: "fact.viewer-unrelated-source",
    predicate: "affects",
    to: "fact.viewer-unrelated-target",
    status: "active"
  });
  await writeRelation(projectRoot, {
    id: "rel.synthesis-agent-guidance-derived-from-source-agent-integration",
    from: "synthesis.agent-guidance",
    predicate: "derived_from",
    to: "source.agent-integration",
    status: "active"
  });
  await writeRelation(projectRoot, {
    id: "rel.source-agent-integration-supports-synthesis-agent-guidance",
    from: "source.agent-integration",
    predicate: "supports",
    to: "synthesis.agent-guidance",
    status: "active"
  });
  await writeRelation(projectRoot, {
    id: "rel.gotcha-webhook-duplicates-challenges-synthesis-agent-guidance",
    from: "gotcha.webhook-duplicates",
    predicate: "challenges",
    to: "synthesis.agent-guidance",
    status: "active"
  });
}

async function writeMemoryObject(projectRoot: string, fixture: MemoryFixture): Promise<void> {
  const storage = await readStorageOrThrow(projectRoot);
  const timestamp = fixture.updatedAt ?? FIXED_TIMESTAMP;
  const sidecarWithoutHash = {
    id: fixture.id,
    type: fixture.type,
    status: fixture.status,
    title: fixture.title,
    body_path: fixture.bodyPath,
    scope: {
      kind: "project",
      project: storage.config.project.id,
      branch: null,
      task: null
    },
    tags: fixture.tags,
    ...(fixture.facets === undefined ? {} : { facets: fixture.facets }),
    ...(fixture.evidence === undefined ? {} : { evidence: fixture.evidence }),
    ...(fixture.origin === undefined ? {} : { origin: fixture.origin }),
    source: {
      kind: "agent"
    },
    created_at: timestamp,
    updated_at: timestamp
  } satisfies Omit<MemoryObjectSidecar, "content_hash">;
  const sidecar: MemoryObjectSidecar = {
    ...sidecarWithoutHash,
    content_hash: computeObjectContentHash(sidecarWithoutHash, fixture.body)
  };

  await writeProjectFile(projectRoot, `.memory/${fixture.bodyPath}`, fixture.body);
  await writeJsonProjectFile(
    projectRoot,
    `.memory/${fixture.bodyPath.replace(/\.md$/, ".json")}`,
    sidecar
  );
}

async function writeRelation(projectRoot: string, fixture: RelationFixture): Promise<void> {
  const relationWithoutHash = {
    id: fixture.id,
    from: fixture.from,
    predicate: fixture.predicate,
    to: fixture.to,
    status: fixture.status,
    confidence: "high",
    evidence: [
      {
        kind: "memory",
        id: fixture.from
      }
    ],
    created_at: FIXED_TIMESTAMP_NEXT_MINUTE,
    updated_at: FIXED_TIMESTAMP_NEXT_MINUTE
  } satisfies Omit<MemoryRelation, "content_hash">;
  const relation: MemoryRelation = {
    ...relationWithoutHash,
    content_hash: computeRelationContentHash(relationWithoutHash)
  };

  await writeJsonProjectFile(
    projectRoot,
    `.memory/relations/${fixture.id.replace(/^rel\./, "")}.json`,
    relation
  );
}

async function rebuildProjectIndex(projectRoot: string): Promise<void> {
  const output = createCapturedOutput();
  const exitCode = await main(["node", "memory", "rebuild", "--json"], {
    ...output.writers,
    cwd: projectRoot
  });

  expect(exitCode).toBe(0);
  expect(output.stderr()).toBe("");
}

async function createInitializedProject(prefix: string): Promise<string> {
  const projectRoot = await createTempRoot(prefix);
  const output = createCapturedOutput();
  const exitCode = await main(["node", "memory", "init", "--json"], {
    ...output.writers,
    cwd: projectRoot
  });

  expect(exitCode).toBe(0);
  expect(output.stderr()).toBe("");

  return projectRoot;
}

async function readStorageOrThrow(projectRoot: string) {
  const storage = await readCanonicalStorage(projectRoot);

  expect(storage.ok).toBe(true);
  if (!storage.ok) {
    throw new Error(storage.error.message);
  }

  return storage.data;
}

async function writeProjectFile(
  projectRoot: string,
  relativePath: string,
  contents: string
): Promise<void> {
  const target = join(projectRoot, relativePath);

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}

async function writeJsonProjectFile(
  projectRoot: string,
  relativePath: string,
  value: unknown
): Promise<void> {
  await writeProjectFile(projectRoot, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const resolvedRoot = await realpath(root);

  tempRoots.push(resolvedRoot);
  return resolvedRoot;
}

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
