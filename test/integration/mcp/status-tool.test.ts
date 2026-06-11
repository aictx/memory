import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupParityTempRoots,
  createInitializedParityRepo,
  parseParityCliEnvelope,
  parseParityToolEnvelope,
  runParityCli,
  startParityMcpClient
} from "./parity-fixtures.js";

interface StatusStageSummary {
  count: number;
  titles: string[];
}

interface StatusEnvelope {
  ok: true;
  data: {
    project: {
      id: string;
      name: string;
    };
    features_by_stage: Record<string, StatusStageSummary>;
    open_questions: Array<{ id: string; title: string }>;
    stale: Array<{ id: string; title: string; orphaned_anchors: string[] }>;
    last_activity: string | null;
    last_sync: unknown;
  };
  warnings: string[];
  meta: Record<string, unknown>;
}

afterEach(async () => {
  await cleanupParityTempRoots();
});

describe("memory MCP status_memory tool", () => {
  it("returns status_memory data matching CLI status JSON", async () => {
    const repo = await createInitializedParityRepo("memory-mcp-status-");

    const saved = await runParityCli(["node", "memory", "save", "--stdin", "--json"], repo, {
      stdin: Readable.from([
        JSON.stringify({
          task: "Status parity graph",
          nodes: [
            {
              kind: "feature",
              title: "Status parity feature",
              body: "# Status parity feature\n\nBuilding feature for status parity.\n",
              stage: "building",
              anchors: ["src.ts"]
            },
            {
              kind: "feature",
              title: "Stale anchored feature",
              body: "# Stale anchored feature\n\nAnchor points at a removed path.\n",
              stage: "shipped",
              anchors: ["src/removed/"]
            },
            {
              kind: "question",
              title: "Status parity question",
              body: "# Status parity question\n\nStill open.\n"
            }
          ]
        })
      ])
    });
    expect(saved.exitCode).toBe(0);

    const cliEnvelope = parseParityCliEnvelope<StatusEnvelope>(
      await runParityCli(["node", "memory", "status", "--json"], repo)
    );
    const started = await startParityMcpClient(repo);

    try {
      const result = await started.client.callTool({
        name: "status_memory",
        arguments: {}
      });
      const mcpEnvelope = parseParityToolEnvelope<StatusEnvelope>(result);

      expect(mcpEnvelope).toEqual(cliEnvelope);
      expect(mcpEnvelope.data.features_by_stage).toMatchObject({
        building: { count: 1, titles: ["Status parity feature"] },
        shipped: { count: 1, titles: ["Stale anchored feature"] }
      });
      expect(mcpEnvelope.data.open_questions).toEqual([
        expect.objectContaining({ title: "Status parity question" })
      ]);
      expect(mcpEnvelope.data.stale).toEqual([
        expect.objectContaining({
          title: "Stale anchored feature",
          orphaned_anchors: ["src/removed/"]
        })
      ]);
      expect(mcpEnvelope.data.last_sync).toBeNull();
    } finally {
      await started.close();
    }

    expect(started.stderr()).toBe("");
  });

  it("targets status_memory with explicit project_root from a global MCP launch", async () => {
    const repo = await createInitializedParityRepo("memory-mcp-status-global-");
    const elsewhere = await createInitializedParityRepo("memory-mcp-status-elsewhere-");
    const started = await startParityMcpClient(elsewhere);

    try {
      const result = await started.client.callTool({
        name: "status_memory",
        arguments: {
          project_root: repo
        }
      });
      const mcpEnvelope = parseParityToolEnvelope<StatusEnvelope>(result);
      const cliEnvelope = parseParityCliEnvelope<StatusEnvelope>(
        await runParityCli(["node", "memory", "status", "--json"], repo)
      );

      expect(mcpEnvelope.data).toEqual(cliEnvelope.data);
      expect((mcpEnvelope.meta as { project_root?: string }).project_root).toBe(repo);
    } finally {
      await started.close();
    }

    expect(started.stderr()).toBe("");
  });
});
