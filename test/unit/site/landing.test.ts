import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildSitemapXml,
  buildStructuredData,
  llmsTxt,
  mainSiteUrl,
  robotsTxt,
  siteName,
  staticSitePaths
} from "../../../site/src/seo.js";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ");
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, " ");
}

describe("site landing page", () => {
  it("states the sharpened value proposition and primary actions", async () => {
    const landing = await readFile(resolve(repoRoot, "site/src/pages/index.astro"), "utf8");
    const normalizedLanding = normalizeWhitespace(landing);
    const heroIdentityStart = landing.indexOf('class="hero-identity"');
    const heroIdentityEnd = landing.indexOf("</p>", heroIdentityStart);
    const heroIdentity = normalizeWhitespace(stripTags(landing.slice(heroIdentityStart, heroIdentityEnd)));

    expect(landing).toContain("aictx/memory");
    expect(landing).toContain('href="https://github.com/aictx/memory"');
    expect(landing).toContain('aria-label="Open the aictx/memory GitHub repository"');
    expect(landing).toContain("Your agent knows your code.");
    expect(landing).toContain("It doesn't know your product.");
    expect(heroIdentity).toContain(
      "Memory keeps the product graph of a codebase: features, decisions, status"
    );
    expect(heroIdentity).toContain(
      "Agents query it on demand and keep it current as the product changes."
    );
    expect(heroIdentity).not.toContain("Memory by Aictx is the open source npm package");
    expect(heroIdentity).not.toContain("independent and not affiliated");
    expect(landing).toMatch(/class="value-section context-section"\s+id="context"/);
    expect(landing).toContain("The loop");
    expect(landing).toContain('class="comparison comparison-why" aria-label="How Memory works"');
    expect(landing).toContain("<strong>Index once.</strong>");
    expect(landing).toContain("<strong>Query on demand.</strong>");
    expect(landing).toContain("<strong>Save and sync.</strong>");
    expect(normalizedLanding).toContain("token-budgeted subgraph");
    expect(landing).toContain("Generated product map");
    expect(landing).toContain('aria-label="Install Memory"');
    expect(landing).toContain('aria-label="Install commands"');
    expect(landing).toContain("Open viewer");
    expect(landing).not.toContain("Join discussions");
    expect(landing).toContain("Homebrew");
    expect(landing).toContain("brew install aictx/tap/memory");
    expect(landing).toContain("npm install -g @aictx/memory");
    expect(landing).toContain("Worked for 7m 18s");
    expect(landing).toContain('memory query "state of batch exports"');
    expect(landing).not.toContain("local wiki");
    expect(landing).not.toContain("context pack");
    expect(landing).not.toContain("memory load");
    expect(landing).not.toMatch(/\bfacets?\b/iu);
    expect(landing).not.toContain("memory lens");
    expect(landing).not.toContain("memory handoff");
  });

  it("keeps header and footer navigation focused", async () => {
    const layout = await readFile(resolve(repoRoot, "site/src/layouts/BaseLayout.astro"), "utf8");
    const desktopViewerIndex = layout.indexOf('href={demoViewerUrl} rel="noreferrer">Demo Viewer</a>');
    const desktopDocsIndex = layout.indexOf('href="https://docs.aictx.dev" rel="noreferrer">Docs</a>');
    const desktopUseCasesIndex = layout.indexOf('href="/use-cases/">Use Cases</a>');
    const mobileMenuStart = layout.indexOf('class="mobile-menu-panel"');
    const mobileMenuEnd = layout.indexOf('class="github-pill"');
    const mobileMenu = layout.slice(mobileMenuStart, mobileMenuEnd);
    const mobileViewerIndex = mobileMenu.indexOf('href={demoViewerUrl} rel="noreferrer">Demo Viewer</a>');
    const mobileDocsIndex = mobileMenu.indexOf('href="https://docs.aictx.dev" rel="noreferrer">Docs</a>');
    const mobileUseCasesIndex = mobileMenu.indexOf('href="/use-cases/">Use Cases</a>');

    expect(layout).toContain("Open navigation menu");
    expect(layout).toContain("Memory by Aictx - Persistent Memory for AI Coding Agents");
    expect(layout).toContain("Memory by Aictx gives AI coding agents a local wiki for repo context");
    expect(siteName).toBe("Memory by Aictx");
    expect(layout).toContain('<link rel="canonical" href={canonicalUrl} />');
    expect(layout).toContain('<meta property="og:site_name" content={siteName} />');
    expect(layout).toContain('<meta property="og:url" content={canonicalUrl} />');
    expect(layout).toContain('<meta property="og:image" content={socialImage} />');
    expect(layout).toContain('<meta property="og:image:alt" content="Memory by Aictx project memory overview" />');
    expect(layout).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(layout).toContain('<meta name="twitter:image" content={socialImage} />');
    expect(layout).toContain("const websiteJsonLd = buildStructuredData(siteUrl);");
    expect(layout).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />');
    expect(layout).toContain('<link rel="icon" href="/favicon.ico" sizes="any" />');
    expect(layout).toContain(
      '<img class="brand-mark" src="/assets/logo/memory-constellation-logo.svg" width="34" height="34" alt="" aria-hidden="true" />'
    );
    expect(layout).not.toContain('href="/#context">Context</a>');
    expect(layout).not.toContain('href="/#demo">Demo</a>');
    expect(layout).toContain('const demoViewerUrl = "https://demo.aictx.dev/?token=demo";');
    expect(layout).not.toContain('href="/#demo">Demo Viewer</a>');
    expect(desktopViewerIndex).toBeGreaterThan(-1);
    expect(desktopDocsIndex).toBeGreaterThan(-1);
    expect(desktopUseCasesIndex).toBeGreaterThan(-1);
    expect(desktopViewerIndex).toBeLessThan(desktopDocsIndex);
    expect(desktopDocsIndex).toBeLessThan(desktopUseCasesIndex);
    expect(mobileViewerIndex).toBeGreaterThan(-1);
    expect(mobileDocsIndex).toBeGreaterThan(-1);
    expect(mobileUseCasesIndex).toBeGreaterThan(-1);
    expect(mobileViewerIndex).toBeLessThan(mobileDocsIndex);
    expect(mobileDocsIndex).toBeLessThan(mobileUseCasesIndex);
    expect(layout).not.toContain('href="/#workflow">How it works</a>');
    expect(layout).not.toContain(">Demo</a>");
    expect(layout).not.toContain("Discussions");
    expect(layout).not.toContain("https://github.com/aictx/memory/discussions");
    expect(layout).toContain('<strong data-star-count="compact"></strong>');
    expect(layout).toContain("Footer navigation");
    expect(layout).toContain("<strong>Memory by Aictx</strong>");
    expect(layout).toContain("A local wiki for AI agents, kept reviewable in your repo.");
    expect(layout).toContain('<a href="mailto:michele@remics.tech">Contact us</a>');
    await expect(stat(resolve(repoRoot, "site/public/favicon.ico"))).resolves.toMatchObject({
      size: expect.any(Number)
    });
    await expect(stat(resolve(repoRoot, "docs/public/favicon.ico"))).resolves.toMatchObject({
      size: expect.any(Number)
    });
  });

  it("publishes parseable structured data for the product entity", () => {
    const structuredData = buildStructuredData(new URL(mainSiteUrl));
    const parsed = JSON.parse(JSON.stringify(structuredData)) as {
      "@context": string;
      "@graph": Array<Record<string, unknown>>;
    };
    const graphTypes = parsed["@graph"].map((item) => item["@type"]);

    expect(parsed["@context"]).toBe("https://schema.org");
    expect(graphTypes).toEqual(expect.arrayContaining(["Organization", "WebSite", "SoftwareApplication"]));
    expect(parsed["@graph"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          "@type": "SoftwareApplication",
          name: "Memory by Aictx",
          alternateName: ["Memory", "@aictx/memory"],
          codeRepository: "https://github.com/aictx/memory",
          downloadUrl: [
            "https://www.npmjs.com/package/@aictx/memory",
            "https://github.com/aictx/homebrew-tap"
          ]
        })
      ])
    );
  });

  it("uses memory.aictx.dev as the canonical site host", async () => {
    const siteConfig = await readFile(resolve(repoRoot, "site/astro.config.mjs"), "utf8");
    const wranglerConfig = await readFile(resolve(repoRoot, "wrangler.jsonc"), "utf8");
    const readme = await readFile(resolve(repoRoot, "README.md"), "utf8");

    expect(siteConfig).toContain('site: "https://memory.aictx.dev"');
    expect(wranglerConfig).toContain('"pattern": "memory.aictx.dev"');
    expect(wranglerConfig).toContain('"custom_domain": true');
    expect(readme).toContain('href="https://memory.aictx.dev"');
    expect(readme).toContain("website-memory.aictx.dev");
  });

  it("publishes crawler and agent-readable source surfaces", async () => {
    const robotsEndpoint = await readFile(resolve(repoRoot, "site/src/pages/robots.txt.ts"), "utf8");
    const sitemapEndpoint = await readFile(resolve(repoRoot, "site/src/pages/sitemap.xml.ts"), "utf8");
    const llmsEndpoint = await readFile(resolve(repoRoot, "site/src/pages/llms.txt.ts"), "utf8");
    const docsRobots = await readFile(resolve(repoRoot, "docs/public/robots.txt"), "utf8");
    const sitemap = buildSitemapXml([...staticSitePaths, "/blog/example-post/"]);

    expect(robotsEndpoint).toContain("robotsTxt");
    expect(sitemapEndpoint).toContain('getCollection("blog")');
    expect(sitemapEndpoint).toContain("buildSitemapXml(paths)");
    expect(llmsEndpoint).toContain("llmsTxt");
    expect(robotsTxt).toContain("User-agent: *");
    expect(robotsTxt).toContain("Allow: /");
    expect(robotsTxt).toContain("Sitemap: https://memory.aictx.dev/sitemap.xml");
    expect(docsRobots).toContain("Sitemap: https://docs.aictx.dev/sitemap-index.xml");
    expect(llmsTxt).toContain("# Memory by Aictx");
    expect(llmsTxt).toContain("Package: https://www.npmjs.com/package/@aictx/memory");
    expect(llmsTxt).toContain("Homebrew: brew install aictx/tap/memory");
    expect(llmsTxt).toContain("CLI: memory");
    expect(llmsTxt).toContain("MCP server: memory-mcp");
    expect(llmsTxt).toContain("Memory by Aictx gives AI coding agents a local wiki for repo context.");
    expect(llmsTxt).toContain(
      "It stores durable project memory as reviewable local files agents can load before work and update after meaningful changes."
    );
    expect(llmsTxt).toContain("local wiki for AI agents");
    expect(llmsTxt).toContain("auto-maintained project memory");
    expect(llmsTxt).not.toContain("not affiliated");
    expect(llmsTxt).not.toContain("sponsored by");
    expect(llmsTxt).not.toContain("endorsed by");
    expect(sitemap).toContain("<loc>https://memory.aictx.dev/</loc>");
    expect(sitemap).toContain("<loc>https://memory.aictx.dev/blog/</loc>");
    expect(sitemap).toContain("<loc>https://memory.aictx.dev/use-cases/</loc>");
    expect(sitemap).toContain("<loc>https://memory.aictx.dev/blog/example-post/</loc>");
  });

  it("keeps public identity copy calm and factual", async () => {
    const files = await Promise.all(
      [
        "README.md",
        "site/src/pages/index.astro",
        "site/src/seo.ts",
        "docs/src/content/docs/index.md"
      ].map(async (path) => readFile(resolve(repoRoot, path), "utf8"))
    );
    const publicCopy = files.join("\n").toLowerCase();

    expect(publicCopy).toContain("memory by aictx");
    expect(publicCopy).toContain("@aictx/memory");
    expect(publicCopy).toContain("auto-maintained");
    expect(publicCopy).not.toContain("not affiliated");
    expect(publicCopy).not.toContain("sponsored by");
    expect(publicCopy).not.toContain("endorsed by");
    expect(publicCopy).not.toMatch(/\bscam\w*\b/);
    expect(publicCopy).not.toMatch(/\bcopying\b|\bcopied\b/);
    expect(publicCopy).not.toMatch(/\boriginal\b/);
  });

  it("frames the demo as a product-graph inspection surface", async () => {
    const landing = await readFile(resolve(repoRoot, "site/src/pages/index.astro"), "utf8");

    expect(landing).toContain("Inspect the product graph.");
    expect(landing).toContain("Browse a local memory database in the viewer");
    expect(landing).toContain("memory graph with relation overview");
    expect(landing).not.toContain("Browse the local handbook");
  });

  it("places context, focused loading, and viewer proof in that order", async () => {
    const landing = await readFile(resolve(repoRoot, "site/src/pages/index.astro"), "utf8");
    const contextIndex = landing.indexOf('id="context"');
    const beforeAfterIndex = landing.indexOf('id="before-after"');
    const demoIndex = landing.indexOf('id="demo"');

    expect(contextIndex).toBeGreaterThan(-1);
    expect(beforeAfterIndex).toBeGreaterThan(-1);
    expect(demoIndex).toBeGreaterThan(-1);
    expect(contextIndex).toBeLessThan(beforeAfterIndex);
    expect(beforeAfterIndex).toBeLessThan(demoIndex);
  });
});
