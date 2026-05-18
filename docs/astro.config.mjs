import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLlmsTxt from "starlight-llms-txt";

export default defineConfig({
  site: "https://docs.aictx.dev",
  integrations: [
    starlight({
      title: "Memory",
      description:
        "Local-first persistent project memory for AI coding agents and assistants.",
      customCss: ["./src/styles/memory.css"],
      head: [
        {
          tag: "link",
          attrs: {
            rel: "icon",
            href: "/favicon.ico",
            sizes: "any",
            type: "image/x-icon"
          }
        }
      ],
      editLink: {
        baseUrl: "https://github.com/aictx/memory/edit/main/docs/"
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/aictx/memory"
        }
      ],
      sidebar: [
        {
          label: "Start Here",
          items: [
            "getting-started",
            "capabilities",
            "mental-model",
            "specializing-memory",
            "memory-recipes",
            "demand-driven-memory",
            "wiki-workflow"
          ]
        },
        {
          label: "Use Memory",
          items: [
            "cli",
            "mcp",
            "agent-integration",
            "agent-recipes",
            "plugin-publishing",
            "viewer",
            "troubleshooting"
          ]
        },
        {
          label: "Reference",
          items: ["reference"]
        }
      ],
      plugins: [starlightLlmsTxt()]
    })
  ]
});
