import { describe, expect, it } from "vitest";

import {
  DEFAULT_HOST_ADAPTER_PROFILE_ID,
  getDefaultHostAdapterProfiles,
  isHostAdapterProfileId,
  selectHostAdapterProfile,
  type HostAdapterProfile
} from "../../../src/data-access/index.js";

describe("data-access adapter profiles", () => {
  it("maps the local MCP profile to the Memory-specific data-access operations", () => {
    const profile = selectHostAdapterProfile("local-mcp");

    expect(profile).toMatchObject({
      id: "local-mcp",
      status: "active"
    });
    expect(mappingByToolName(profile)).toEqual({
      search_memory: "search",
      inspect_memory: "inspect",
      save_memory: "save"
    });
  });

  it("maps the future generic profile to search and inspect only", () => {
    const profile = selectHostAdapterProfile("future-generic");

    expect(profile).toMatchObject({
      id: "future-generic",
      status: "inactive"
    });
    expect(mappingByToolName(profile)).toEqual({
      search: "search",
      fetch: "inspect"
    });
  });

  it("keeps future generic names inactive unless explicitly selected", () => {
    expect(DEFAULT_HOST_ADAPTER_PROFILE_ID).toBe("local-mcp");

    const defaultProfiles = getDefaultHostAdapterProfiles();
    const defaultToolNames = defaultProfiles.flatMap((profile) =>
      profile.tools.map((tool) => tool.toolName)
    );

    expect(defaultProfiles.map((profile) => profile.id)).toEqual(["local-mcp"]);
    expect(defaultToolNames).toEqual([
      "search_memory",
      "inspect_memory",
      "save_memory"
    ]);
    expect(defaultToolNames).not.toContain("search");
    expect(defaultToolNames).not.toContain("fetch");
  });

  it("rejects unknown profile identifiers instead of falling back", () => {
    expect(isHostAdapterProfileId("local-mcp")).toBe(true);
    expect(isHostAdapterProfileId("future-generic")).toBe(true);
    expect(isHostAdapterProfileId("remote-cloud")).toBe(false);
    expect(() => selectHostAdapterProfile("remote-cloud")).toThrow(
      'Unsupported Memory host adapter profile "remote-cloud".'
    );
  });
});

function mappingByToolName(profile: HostAdapterProfile): Record<string, string> {
  return Object.fromEntries(
    profile.tools.map((tool) => [tool.toolName, tool.operation])
  );
}
