export const mainSiteUrl = "https://memory.aictx.dev";
export const docsSiteUrl = "https://docs.aictx.dev";
export const siteName = "Memory by Aictx";
export const socialImagePath = "/assets/readme-value-header.png";
export const staticSitePaths = ["/"] as const;

export const robotsTxt = `User-agent: *
Content-Signal: search=yes, ai-input=yes, ai-train=yes
Allow: /

Sitemap: ${mainSiteUrl}/sitemap.xml
`;

export const llmsTxt = `# Memory by Aictx

Memory by Aictx keeps the product graph of a codebase: features with their lifecycle stage, decisions with their reasons, gotchas, and open questions — anchored to the code paths they describe.
AI coding agents build the graph once at init, query it on demand mid-task, and keep it current with diff-driven sync as the product changes.
Everything stays local: plain files under .memory/ with a SQLite full-text index. No embeddings, no cloud account, no model API.
It is distributed through the open source npm package @aictx/memory and the Homebrew formula aictx/tap/memory, then runs through the memory CLI and optional memory-mcp server.

Canonical public surfaces:
- Website: ${mainSiteUrl}
- Documentation: ${docsSiteUrl}
- Getting started: ${docsSiteUrl}/getting-started/
- Mental model: ${docsSiteUrl}/mental-model/
- Agent integration: ${docsSiteUrl}/agent-integration/
- MCP guide: ${docsSiteUrl}/mcp/
- Repository: https://github.com/aictx/memory
- Package: https://www.npmjs.com/package/@aictx/memory
- Homebrew: brew install aictx/tap/memory
- CLI: memory
- MCP server: memory-mcp

Positioning:
- product graph for AI coding agents
- features, decisions, gotchas, and open questions anchored to code paths
- feature lifecycle stage the repo cannot express: shipped, building, paused, dead
- memory init builds the graph once from an indexing brief
- memory query answers product questions with a token-budgeted subgraph
- memory save records product-meaningful changes and refreshes the product map
- memory sync verifies code anchors and reports exactly what went stale
- generated product map kept in AGENTS.md and CLAUDE.md marker sections
- local viewer for projects, nodes, and the relation graph
- local-first, git-native, reviewable plain files under .memory/
`;

export function socialImageUrl(siteUrl: URL): string {
  return new URL(socialImagePath, siteUrl).toString();
}

export function buildStructuredData(siteUrl: URL): object {
  const organizationId = new URL("/#organization", siteUrl).toString();
  const softwareId = new URL("/#software", siteUrl).toString();

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": organizationId,
        name: "Aictx",
        url: new URL("/", siteUrl).toString(),
        logo: new URL("/assets/logo/memory-constellation-logo.svg", siteUrl).toString(),
        sameAs: [
          "https://github.com/aictx/memory",
          "https://www.npmjs.com/package/@aictx/memory",
          "https://github.com/aictx/homebrew-tap"
        ]
      },
      {
        "@type": "WebSite",
        name: siteName,
        alternateName: "Memory",
        url: new URL("/", siteUrl).toString(),
        publisher: {
          "@id": organizationId
        }
      },
      {
        "@type": "SoftwareApplication",
        "@id": softwareId,
        name: siteName,
        alternateName: ["Memory", "@aictx/memory"],
        keywords:
          "product graph for AI coding agents, AI agent project memory, persistent memory for AI coding agents, feature lifecycle tracking, decision log, MCP memory server, local-first developer tools",
        applicationCategory: "DeveloperApplication",
        operatingSystem: "macOS, Linux, Windows",
        description:
          "Memory by Aictx keeps the product graph of a codebase — features, decisions, and status, anchored to the code and queryable by AI coding agents.",
        url: new URL("/", siteUrl).toString(),
        codeRepository: "https://github.com/aictx/memory",
        downloadUrl: [
          "https://www.npmjs.com/package/@aictx/memory",
          "https://github.com/aictx/homebrew-tap"
        ],
        publisher: {
          "@id": organizationId
        }
      }
    ]
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildSitemapXml(paths: readonly string[]): string {
  const urls = paths.map((path) => new URL(path, mainSiteUrl).toString()).sort();

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((url) => `  <url><loc>${escapeXml(url)}</loc></url>`).join("\n")}
</urlset>
`;
}
