import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  FEATURE_STAGES,
  PREDICATES,
  RELATION_CONFIDENCES
} from "../../core/types.js";
import { dataAccessService } from "../../data-access/index.js";
import { SAVE_NODE_KINDS } from "../../save/types.js";
import {
  PROJECT_ROOT_ARGUMENT_DESCRIPTION,
  resolveMcpProjectCwd,
  type MemoryMcpContext,
  type ProjectScopedMcpArgs
} from "../context.js";
import {
  toMcpToolResult,
  WRITE_TOOL_ANNOTATIONS
} from "./shared.js";
import {
  resolveWriteQueueKey,
  serializeProjectWrite
} from "./write-queue.js";

const OBJECT_ID_SCHEMA = z
  .string()
  .regex(/^[a-z][a-z0-9_]*\.[a-z0-9][a-z0-9-]*$/u);
const ANCHORS_SCHEMA = z
  .array(z.string().min(1))
  .describe("Repo-relative glob strings linking this node to code, e.g. src/index/ or src/**/*.ts.");
const UNIQUE_NON_EMPTY_STRINGS_SCHEMA = z.array(z.string().min(1)).refine(hasUniqueItems);
const EVIDENCE_SCHEMA = z.array(
  z
    .object({
      kind: z.enum(["memory", "relation", "file", "commit", "task", "source"]),
      id: z.string().min(1)
    })
    .strict()
);
const RELATED_SCHEMA = z
  .object({
    predicate: z.enum(PREDICATES),
    to: OBJECT_ID_SCHEMA,
    confidence: z.enum(RELATION_CONFIDENCES).optional()
  })
  .strict();
const NODE_SCHEMA = z
  .object({
    id: OBJECT_ID_SCHEMA.optional().describe(
      "Existing object id to update, or an explicit id for a new object."
    ),
    kind: z.enum(SAVE_NODE_KINDS).optional().describe("Required when creating a node."),
    title: z.string().min(1).optional().describe("Required when creating a node."),
    body: z.string().min(1).optional().describe("Required when creating a node."),
    stage: z.enum(FEATURE_STAGES).optional().describe("Feature-only lifecycle stage."),
    anchors: ANCHORS_SCHEMA.optional(),
    tags: UNIQUE_NON_EMPTY_STRINGS_SCHEMA.optional(),
    evidence: EVIDENCE_SCHEMA.optional(),
    related: z.array(RELATED_SCHEMA).optional()
  })
  .strict();
const STALE_SCHEMA = z
  .object({
    id: OBJECT_ID_SCHEMA,
    reason: z.string().min(1)
  })
  .strict();
const SUPERSEDE_SCHEMA = z
  .object({
    id: OBJECT_ID_SCHEMA,
    superseded_by: OBJECT_ID_SCHEMA,
    reason: z.string().min(1)
  })
  .strict();
const DELETE_SCHEMA = z
  .object({
    id: OBJECT_ID_SCHEMA,
    reason: z.string().min(1)
  })
  .strict();
const SAVE_MEMORY_INPUT_SCHEMA = z
  .object({
    task: z.string().min(1).describe("Task or reason for this durable memory update."),
    nodes: z.array(NODE_SCHEMA).optional(),
    stale: z.array(STALE_SCHEMA).optional(),
    supersede: z.array(SUPERSEDE_SCHEMA).optional(),
    delete: z.array(DELETE_SCHEMA).optional(),
    project_root: z
      .string()
      .optional()
      .describe(PROJECT_ROOT_ARGUMENT_DESCRIPTION)
  })
  .strict();

type SaveMemoryArgs = z.infer<typeof SAVE_MEMORY_INPUT_SCHEMA> & ProjectScopedMcpArgs;

export const saveMemoryTool = {
  name: "save_memory",
  title: "Save Memory",
  description:
    "Save durable project memory from intent-first agent input: create or update feature/decision/gotcha/question nodes, mark stale, supersede, or delete.",
  inputSchema: SAVE_MEMORY_INPUT_SCHEMA,
  annotations: WRITE_TOOL_ANNOTATIONS,
  call: callSaveMemoryTool
};

async function callSaveMemoryTool(
  context: MemoryMcpContext,
  args: SaveMemoryArgs
): Promise<CallToolResult> {
  const cwd = resolveMcpProjectCwd(context, args);
  const projectKey = await resolveWriteQueueKey(cwd);
  const { project_root: _projectRoot, ...input } = args;

  return serializeProjectWrite(projectKey, async () => {
    const result = await dataAccessService.save({
      target: {
        kind: "cwd",
        cwd
      },
      input
    });

    return toMcpToolResult(result);
  });
}

function hasUniqueItems(items: readonly string[]): boolean {
  return new Set(items).size === items.length;
}
