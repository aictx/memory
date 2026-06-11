import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://memory.aictx.dev",
  // Retired v1 secondary pages; keep previously published URLs alive.
  redirects: {
    "/use-cases/": "/",
    "/blog/": "/",
    "/blog/keeping-agents-md-and-claude-md-small/": "/",
    "/blog/talking-to-chatgpt-about-a-project-without-handing-it-the-repo/": "/",
    "/blog/watching-multiple-agent-built-projects-with-memory/": "/",
    "/persistent-memory-ai-coding-agents/": "/",
    "/mcp-memory-server/": "/",
    "/claude-code-memory/": "/",
    "/codex-memory/": "/",
    "/cursor-memory/": "/"
  },
  vite: {
    plugins: [tailwindcss()]
  }
});
