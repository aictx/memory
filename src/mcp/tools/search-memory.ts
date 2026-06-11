import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  dataAccessService,
  type DataAccessSearchInput
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

const SEARCH_MEMORY_INPUT_SCHEMA = z
  .object({
    query: z.string().describe("Search query."),
    limit: z
      .number()
      .optional()
      .describe("Optional maximum number of matches to return."),
    project_root: z
      .string()
      .optional()
      .describe(PROJECT_ROOT_ARGUMENT_DESCRIPTION)
  })
  .strict();

type SearchMemoryArgs = z.infer<typeof SEARCH_MEMORY_INPUT_SCHEMA> & ProjectScopedMcpArgs;

export const searchMemoryTool = {
  name: "search_memory",
  title: "Search Memory",
  description: "Search local Memory using the generated SQLite index.",
  inputSchema: SEARCH_MEMORY_INPUT_SCHEMA,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  call: callSearchMemoryTool
};

async function callSearchMemoryTool(
  context: MemoryMcpContext,
  args: SearchMemoryArgs
): Promise<CallToolResult> {
  const result = await dataAccessService.search(parseSearchMemoryArgs(context, args));

  return toMcpToolResult(result);
}

function parseSearchMemoryArgs(
  context: MemoryMcpContext,
  args: SearchMemoryArgs
): DataAccessSearchInput {
  const options: DataAccessSearchInput = {
    target: {
      kind: "cwd",
      cwd: resolveMcpProjectCwd(context, args)
    },
    query: args.query
  };

  if (args.limit !== undefined) {
    options.limit = args.limit;
  }

  return options;
}
