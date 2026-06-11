import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  dataAccessService,
  type DataAccessStatusInput
} from "../../data-access/index.js";
import {
  PROJECT_ROOT_ARGUMENT_DESCRIPTION,
  resolveMcpProjectCwd,
  type MemoryMcpContext,
  type ProjectScopedMcpArgs
} from "../context.js";
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  toMcpToolResult
} from "./shared.js";

const STATUS_MEMORY_INPUT_SCHEMA = z
  .object({
    project_root: z
      .string()
      .optional()
      .describe(PROJECT_ROOT_ARGUMENT_DESCRIPTION)
  })
  .strict();

type StatusMemoryArgs = z.infer<typeof STATUS_MEMORY_INPUT_SCHEMA> & ProjectScopedMcpArgs;

export const statusMemoryTool = {
  name: "status_memory",
  title: "Memory Status",
  description:
    "Summarize the product graph: features by stage, open questions, stale anchors, last activity, and last sync.",
  inputSchema: STATUS_MEMORY_INPUT_SCHEMA,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  call: callStatusMemoryTool
};

async function callStatusMemoryTool(
  context: MemoryMcpContext,
  args: StatusMemoryArgs
): Promise<CallToolResult> {
  const result = await dataAccessService.status(parseStatusMemoryArgs(context, args));

  return toMcpToolResult(result);
}

function parseStatusMemoryArgs(
  context: MemoryMcpContext,
  args: StatusMemoryArgs
): DataAccessStatusInput {
  return {
    target: {
      kind: "cwd",
      cwd: resolveMcpProjectCwd(context, args)
    }
  };
}
