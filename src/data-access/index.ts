export {
  DEFAULT_HOST_ADAPTER_PROFILE_ID,
  getDefaultHostAdapterProfiles,
  HOST_ADAPTER_PROFILE_IDS,
  isHostAdapterProfileId,
  selectHostAdapterProfile,
  type DataAccessOperationName,
  type HostAdapterProfile,
  type HostAdapterProfileId,
  type HostAdapterProfileStatus,
  type HostAdapterToolMapping
} from "./adapter-profiles.js";

export {
  createDataAccessService,
  dataAccessService,
  type DataAccessDiffInput,
  type DataAccessInspectInput,
  type DataAccessProjectTarget,
  type DataAccessQueryInput,
  type DataAccessSaveInput,
  type DataAccessService,
  type DataAccessStatusInput
} from "./service.js";

export type {
  AppResult,
  DiffMemoryData,
  InspectMemoryData,
  MemoryRelationSummary,
  SaveMemoryData,
  StatusData,
  StatusFeatureStageSummary,
  StatusOpenQuestion,
  StatusStaleAnchors,
  StatusSyncState
} from "../app/operations.js";

export type { QueryMemoryData } from "../query/render.js";
