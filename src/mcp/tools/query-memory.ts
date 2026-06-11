import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  dataAccessService,
  type DataAccessQueryInput
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

const QUERY_MEMORY_INPUT_SCHEMA = z
  .object({
    question: z.string().describe("Question to answer from project memory."),
    budget: z
      .number()
      .optional()
      .describe("Optional token budget for the rendered result."),
    project_root: z
      .string()
      .optional()
      .describe(PROJECT_ROOT_ARGUMENT_DESCRIPTION)
  })
  .strict();

type QueryMemoryArgs = z.infer<typeof QUERY_MEMORY_INPUT_SCHEMA> & ProjectScopedMcpArgs;

export const queryMemoryTool = {
  name: "query_memory",
  title: "Query Memory",
  description:
    "Query local Memory and return a token-budgeted markdown subgraph of matching memory.",
  inputSchema: QUERY_MEMORY_INPUT_SCHEMA,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  call: callQueryMemoryTool
};

async function callQueryMemoryTool(
  context: MemoryMcpContext,
  args: QueryMemoryArgs
): Promise<CallToolResult> {
  const result = await dataAccessService.query(parseQueryMemoryArgs(context, args));

  return toMcpToolResult(result);
}

function parseQueryMemoryArgs(
  context: MemoryMcpContext,
  args: QueryMemoryArgs
): DataAccessQueryInput {
  const options: DataAccessQueryInput = {
    target: {
      kind: "cwd",
      cwd: resolveMcpProjectCwd(context, args)
    },
    question: args.question
  };

  if (args.budget !== undefined) {
    options.budget = args.budget;
  }

  return options;
}
