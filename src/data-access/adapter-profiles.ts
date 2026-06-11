export const HOST_ADAPTER_PROFILE_IDS = [
  "local-mcp",
  "future-generic"
] as const;

export type HostAdapterProfileId = (typeof HOST_ADAPTER_PROFILE_IDS)[number];

export type DataAccessOperationName =
  | "search"
  | "inspect"
  | "diff"
  | "save";

export type HostAdapterProfileStatus = "active" | "inactive";

export interface HostAdapterToolMapping {
  readonly toolName: string;
  readonly operation: DataAccessOperationName;
}

export interface HostAdapterProfile {
  readonly id: HostAdapterProfileId;
  readonly status: HostAdapterProfileStatus;
  readonly description: string;
  readonly tools: readonly HostAdapterToolMapping[];
}

export const DEFAULT_HOST_ADAPTER_PROFILE_ID: HostAdapterProfileId = "local-mcp";

const HOST_ADAPTER_PROFILE_ID_SET: ReadonlySet<string> = new Set(
  HOST_ADAPTER_PROFILE_IDS
);

const HOST_ADAPTER_PROFILES = {
  "local-mcp": {
    id: "local-mcp",
    status: "active",
    description: "Default local MCP profile with Memory-specific tool names.",
    tools: [
      {
        toolName: "search_memory",
        operation: "search"
      },
      {
        toolName: "inspect_memory",
        operation: "inspect"
      },
      {
        toolName: "save_memory",
        operation: "save"
      }
    ]
  },
  "future-generic": {
    id: "future-generic",
    status: "inactive",
    description:
      "Inactive future host profile for generic search/fetch adapter names.",
    tools: [
      {
        toolName: "search",
        operation: "search"
      },
      {
        toolName: "fetch",
        operation: "inspect"
      }
    ]
  }
} as const satisfies Record<HostAdapterProfileId, HostAdapterProfile>;

export function getDefaultHostAdapterProfiles(): readonly HostAdapterProfile[] {
  return [HOST_ADAPTER_PROFILES[DEFAULT_HOST_ADAPTER_PROFILE_ID]];
}

export function selectHostAdapterProfile(profileId?: string): HostAdapterProfile {
  const resolvedProfileId = profileId ?? DEFAULT_HOST_ADAPTER_PROFILE_ID;

  if (!isHostAdapterProfileId(resolvedProfileId)) {
    throw new Error(
      `Unsupported Memory host adapter profile "${resolvedProfileId}". Supported profiles: ${HOST_ADAPTER_PROFILE_IDS.join(", ")}.`
    );
  }

  return HOST_ADAPTER_PROFILES[resolvedProfileId];
}

export function isHostAdapterProfileId(value: string): value is HostAdapterProfileId {
  return HOST_ADAPTER_PROFILE_ID_SET.has(value);
}
