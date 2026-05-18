import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import fg from "fast-glob";

import type { ProjectFileChange } from "../core/git.js";
import { generateObjectId, generateRelationId } from "../core/ids.js";
import type {
  Evidence,
  FacetCategory,
  ObjectFacets,
  ObjectId,
  ObjectStatus,
  ObjectType,
  Predicate,
  RelationConfidence,
  RelationId,
  RelationStatus,
  Source,
  SourceOrigin
} from "../core/types.js";
import type { CanonicalStorageSnapshot } from "../storage/read.js";
import type { StoredMemoryObject } from "../storage/objects.js";
import type { StoredMemoryRelation } from "../storage/relations.js";
import { fileSourceOrigin } from "../storage/source-origin.js";
import type {
  RememberMemoryInput,
  RememberMemoryKind
} from "../remember/types.js";
import type { AuditFinding, AuditRule } from "./audit.js";

export type SuggestMode = "from_diff" | "bootstrap" | "after_task";

export interface SuggestReviewPacket {
  mode: SuggestMode;
  changed_files: string[];
  related_memory_ids: ObjectId[];
  possible_stale_ids: ObjectId[];
  recommended_memory: ObjectType[];
  recommended_evidence?: Evidence[];
  recommended_relations?: SuggestedRelation[];
  recommended_facets?: FacetCategory[];
  recommended_actions?: SuggestedMemoryAction[];
  repair_candidates?: MemoryRepairCandidate[];
  save_decision_checklist?: string[];
  remember_template?: RememberMemoryInput;
  task?: string;
  agent_checklist: string[];
}

export type SuggestedMemoryActionType =
  | "save_nothing"
  | "update_existing"
  | "mark_stale"
  | "supersede_existing"
  | "create_memory"
  | "create_relation";

export interface SuggestedMemoryAction {
  rank: number;
  action: SuggestedMemoryActionType;
  confidence: RelationConfidence;
  reason: string;
  guidance: string;
  target_id?: ObjectId;
  memory_kind?: RememberMemoryKind;
  category?: FacetCategory;
  evidence?: Evidence[];
  remember_template?: RememberMemoryInput;
}

export interface SuggestedRelation {
  from: ObjectId;
  predicate: Predicate;
  to: ObjectId;
  reason: string;
}

export interface MemoryRepairCandidate {
  target_id: ObjectId;
  rule: AuditRule;
  confidence: RelationConfidence;
  suggested_action: SuggestedMemoryActionType;
  reason: string;
  evidence: Evidence[];
}

export interface BuildSuggestFromDiffPacketOptions {
  changedFiles: readonly string[];
  storage: CanonicalStorageSnapshot;
}

export interface BuildSuggestBootstrapPacketOptions {
  projectRoot: string;
  storage: CanonicalStorageSnapshot;
}

export interface BuildSuggestAfterTaskPacketOptions {
  task: string;
  changedFiles: readonly string[];
  storage: CanonicalStorageSnapshot;
  auditFindings?: readonly AuditFinding[];
  gitFileChanges?: readonly ProjectFileChange[];
}

export type BootstrapPatchChange =
  | {
      op: "update_object";
      id: ObjectId;
      body?: string;
      tags?: string[];
      facets?: ObjectFacets;
      evidence?: Evidence[];
      origin?: SourceOrigin;
      source?: Source;
    }
  | {
      op: "create_object";
      id: ObjectId;
      type: ObjectType;
      title: string;
      body: string;
      tags?: string[];
      facets?: ObjectFacets;
      evidence?: Evidence[];
      origin?: SourceOrigin;
      source?: Source;
    }
  | {
      op: "create_relation";
      id?: RelationId;
      from: ObjectId;
      predicate: Predicate;
      to: ObjectId;
      status?: RelationStatus;
      confidence?: RelationConfidence;
      evidence?: Evidence[];
    };

export interface BootstrapMemoryPatch {
  source: Source;
  changes: BootstrapPatchChange[];
}

export interface SuggestBootstrapPatchProposal {
  proposed: boolean;
  patch: BootstrapMemoryPatch | null;
  packet: SuggestReviewPacket;
  reason: string | null;
}

const FROM_DIFF_RECOMMENDED_MEMORY: ObjectType[] = [
  "synthesis",
  "decision",
  "constraint",
  "gotcha",
  "workflow",
  "fact"
];
const BOOTSTRAP_RECOMMENDED_MEMORY: ObjectType[] = [
  "project",
  "architecture",
  "source",
  "synthesis",
  "workflow",
  "constraint",
  "gotcha",
  "decision"
];
const AFTER_TASK_RECOMMENDED_MEMORY: ObjectType[] = [
  "synthesis",
  "decision",
  "constraint",
  "gotcha",
  "workflow",
  "fact",
  "question"
];
const RECOMMENDED_FACETS: FacetCategory[] = [
  "decision-rationale",
  "convention",
  "gotcha",
  "workflow",
  "debugging-fact",
  "source",
  "product-intent",
  "feature-map",
  "roadmap",
  "agent-guidance",
  "testing",
  "file-layout",
  "stack",
  "abandoned-attempt",
  "open-question",
  "domain",
  "bounded-context",
  "capability",
  "business-rule"
];
const AGENT_CHECKLIST = [
  "Create memory only for durable future value.",
  "Prefer updating, marking stale, or superseding existing memory over creating duplicates.",
  "Use current code, tests, manifests, and user instructions as evidence.",
  "Right-size memory: atomic for precise claims, source for provenance, synthesis for compact area-level understanding.",
  "Treat failure, confusion, user correction, and memory conflicts as signals to repair durable memory.",
  "Save nothing if the work produced no durable future value."
] as const;
const BOOTSTRAP_PRODUCT_FEATURE_CHECKLIST_ITEM =
  "During setup, capture explicit product features in a maintained feature-map synthesis backed by source records; mark removed or replaced feature memories stale or superseded.";
const AGENT_GUIDANCE_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
const MEMORY_MEMORY_START_MARKER = "<!-- memory:start -->";
const MEMORY_MEMORY_END_MARKER = "<!-- memory:end -->";
const SAVE_DECISION_CHECKLIST = [
  "Save memory only when the task produced durable future value.",
  "Prefer updating, marking stale, or superseding related memory over creating duplicates.",
  "Choose the right layer: atomic memory for precise claims, source records for provenance, synthesis records for compact area-level summaries.",
  "Back durable synthesis memory with source evidence or source provenance relations when possible.",
  "Add facets.category and evidence when creating or updating durable memory.",
  "Use facets.applies_to for relevant files, subsystems, commands, or configs.",
  "Use unresolved-conflict questions when current evidence cannot resolve contradictory active memory.",
  "Record abandoned approaches as active abandoned-attempt memory only when future agents should avoid retrying them."
] as const;
const STALE_CANDIDATE_STATUSES = new Set<ObjectStatus>([
  "active",
  "open",
  "closed"
]);
const BOOTSTRAP_FILE_LIMIT = 40;
const BOOTSTRAP_PRODUCT_FEATURE_LIMIT = 8;
const BOOTSTRAP_DOC_FEATURE_FILE_LIMIT = 8;
const POST_TASK_SCRIPT_PRIORITY = [
  "typecheck",
  "lint",
  "check",
  "test:local",
  "test",
  "test:package",
  "build"
] as const;
const POST_TASK_SCRIPT_NAMES = new Set<string>(POST_TASK_SCRIPT_PRIORITY);
const BOOTSTRAP_IGNORE = [
  ".memory/**",
  ".git/**",
  ".cache/**",
  ".next/**",
  ".svelte-kit/**",
  ".turbo/**",
  ".vite/**",
  "build/**",
  "coverage/**",
  "dist/**",
  "dist-types/**",
  "node_modules/**",
  "out/**",
  "target/**",
  "temp/**",
  "tmp/**"
] as const;
const BOOTSTRAP_PATTERNS = [
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig*.json",
  "vite.config.*",
  "vitest.config.*",
  "next.config.*",
  "svelte.config.*",
  "eslint.config.*",
  "src/**/*.{ts,tsx,js,jsx,svelte,md}",
  "app/**/*.{ts,tsx,js,jsx,svelte,md}",
  "pages/**/*.{ts,tsx,js,jsx,svelte,md}",
  "routes/**/*.{ts,tsx,js,jsx,svelte,md}",
  "lib/**/*.{ts,tsx,js,jsx,svelte,md}",
  "test/**/*.{ts,tsx,js,jsx,svelte,md}",
  "tests/**/*.{ts,tsx,js,jsx,svelte,md}",
  "docs/**/*.{md,mdx}",
  "specs/**/*.{md,mdx}"
] as const;
const TOKEN_STOP_WORDS = new Set([
  "memory",
  "app",
  "cli",
  "cmd",
  "command",
  "config",
  "dist",
  "doc",
  "docs",
  "index",
  "json",
  "lib",
  "lock",
  "main",
  "memory",
  "node",
  "package",
  "readme",
  "src",
  "test",
  "tests",
  "tsx",
  "types"
]);
const BOOTSTRAP_PATCH_SOURCE: Source = {
  kind: "cli",
  task: "Proposed bootstrap memory patch from deterministic repository analysis"
};
const BOOTSTRAP_NO_PATCH_REASON =
  "No high-confidence bootstrap memory patch could be generated from deterministic repository evidence.";
const LOCK_FILE_MANAGERS = [
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "package-lock.json", manager: "npm" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "bun.lock", manager: "bun" },
  { file: "bun.lockb", manager: "bun" }
] as const;
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const CURRENT_ARCHITECTURE_ID: ObjectId = "architecture.current";
const PROJECT_ARCHITECTURE_PREDICATE: Predicate = "related_to";
const PROJECT_FEATURE_PREDICATE: Predicate = "implements";
const BOOTSTRAP_HUB_RELATIONS = [
  {
    id: "synthesis.product-intent",
    type: "synthesis",
    title: "Product intent",
    predicate: "summarizes"
  },
  {
    id: "synthesis.feature-map",
    type: "synthesis",
    title: "Feature map",
    predicate: "documents"
  },
  {
    id: "synthesis.repository-map",
    type: "synthesis",
    title: "Repository map",
    predicate: "documents"
  },
  {
    id: "synthesis.stack-and-tooling",
    type: "synthesis",
    title: "Stack and tooling",
    predicate: "documents"
  },
  {
    id: "synthesis.conventions-quality",
    type: "synthesis",
    title: "Conventions and quality bar",
    predicate: "documents"
  },
  {
    id: "synthesis.agent-guidance",
    type: "synthesis",
    title: "Agent guidance",
    predicate: "documents"
  },
  {
    id: "workflow.package-scripts",
    type: "workflow",
    title: "Package scripts",
    predicate: "supports"
  },
  {
    id: "workflow.post-task-verification",
    type: "workflow",
    title: "Post-task verification",
    predicate: "supports"
  },
  {
    id: "constraint.node-engine",
    type: "constraint",
    title: "Node engine requirement",
    predicate: "affects"
  },
  {
    id: "constraint.package-manager",
    type: "constraint",
    title: "Package manager",
    predicate: "affects"
  },
  {
    id: "constraint.code-conventions",
    type: "constraint",
    title: "Code conventions",
    predicate: "affects"
  }
] satisfies Array<{
  id: ObjectId;
  type: ObjectType;
  title: string;
  predicate: Predicate;
}>;

export function buildSuggestFromDiffPacket(
  options: BuildSuggestFromDiffPacketOptions
): SuggestReviewPacket {
  const changedFiles = uniqueSorted(options.changedFiles);
  const related = relatedMemoryIds(options.storage, changedFiles);
  const possibleStale = possibleStaleIds(options.storage, changedFiles);

  return {
    mode: "from_diff",
    changed_files: changedFiles,
    related_memory_ids: related,
    possible_stale_ids: possibleStale,
    recommended_memory: [...FROM_DIFF_RECOMMENDED_MEMORY],
    recommended_evidence: recommendedFileEvidence(changedFiles),
    recommended_relations: recommendedRelations(options.storage, changedFiles),
    agent_checklist: [...AGENT_CHECKLIST]
  };
}

export function buildSuggestAfterTaskPacket(
  options: BuildSuggestAfterTaskPacketOptions
): SuggestReviewPacket {
  const changedFiles = uniqueSorted(options.changedFiles);
  const repairCandidates = repairCandidatesForAfterTask({
    storage: options.storage,
    changedFiles,
    auditFindings: options.auditFindings ?? [],
    gitFileChanges: options.gitFileChanges ?? []
  });
  const related = uniqueSorted([
    ...relatedMemoryIds(options.storage, changedFiles),
    ...repairCandidates.map((candidate) => candidate.target_id)
  ]);
  const possibleStale = uniqueSorted([
    ...possibleStaleIds(options.storage, changedFiles),
    ...repairCandidates
      .filter((candidate) => candidateSuggestsStale(candidate))
      .map((candidate) => candidate.target_id)
  ]);
  const recommendedRelationsForChanges = recommendedRelations(options.storage, changedFiles);
  const recommendedMemory = recommendedMemoryForTask(options.task, changedFiles);
  const recommendedFacets = recommendedFacetsForTask(options.task, changedFiles, options.storage);
  const recommendedEvidence = recommendedFileEvidence(changedFiles);

  return {
    mode: "after_task",
    task: options.task,
    changed_files: changedFiles,
    related_memory_ids: related,
    possible_stale_ids: possibleStale,
    recommended_memory: recommendedMemory,
    recommended_evidence: recommendedEvidence,
    recommended_relations: recommendedRelationsForChanges,
    recommended_facets: recommendedFacets,
    recommended_actions: recommendedActionsForAfterTask({
      task: options.task,
      changedFiles,
      relatedMemoryIds: related,
      possibleStaleIds: possibleStale,
      recommendedEvidence,
      recommendedRelations: recommendedRelationsForChanges,
      repairCandidates,
      hasRelatedMemoryConflict: activeConflictsTouchRelatedMemory(options.storage, changedFiles)
    }),
    ...(repairCandidates.length === 0 ? {} : { repair_candidates: repairCandidates }),
    save_decision_checklist: [...SAVE_DECISION_CHECKLIST],
    remember_template: rememberTemplateForAfterTask({
      task: options.task,
      changedFiles,
      relatedMemoryIds: related,
      possibleStaleIds: possibleStale,
      recommendedMemory,
      recommendedEvidence,
      recommendedRelations: recommendedRelationsForChanges,
      recommendedFacets
    }),
    agent_checklist: [...AGENT_CHECKLIST]
  };
}

export async function buildSuggestBootstrapPacket(
  options: BuildSuggestBootstrapPacketOptions
): Promise<SuggestReviewPacket> {
  const changedFiles = await bootstrapCandidateFiles(options.projectRoot);
  const analysis = await analyzeBootstrapRepository(options.projectRoot, changedFiles);

  return buildBootstrapPacketFromAnalysis(options.storage, changedFiles, analysis);
}

function buildBootstrapPacketFromAnalysis(
  storage: CanonicalStorageSnapshot,
  changedFiles: readonly string[],
  analysis: BootstrapAnalysis
): SuggestReviewPacket {
  const hasProductFeatures = hasProductFeatureBootstrapSignal(analysis);
  const recommendedFacets = bootstrapRecommendedFacets(analysis);

  return {
    mode: "bootstrap",
    changed_files: [...changedFiles],
    related_memory_ids: relatedMemoryIds(storage, changedFiles),
    possible_stale_ids: possibleStaleIds(storage, changedFiles),
    recommended_memory: recommendedBootstrapMemory(hasProductFeatures),
    ...(recommendedFacets.length === 0 ? {} : { recommended_facets: recommendedFacets }),
    agent_checklist: [...AGENT_CHECKLIST, BOOTSTRAP_PRODUCT_FEATURE_CHECKLIST_ITEM]
  };
}

export async function buildSuggestBootstrapPatchProposal(
  options: BuildSuggestBootstrapPacketOptions
): Promise<SuggestBootstrapPatchProposal> {
  const changedFiles = await bootstrapCandidateFiles(options.projectRoot);
  const analysis = await analyzeBootstrapRepository(options.projectRoot, changedFiles);
  const packet = buildBootstrapPacketFromAnalysis(options.storage, changedFiles, analysis);
  const changes = await buildBootstrapPatchChanges(options.projectRoot, options.storage, analysis);

  if (changes.length === 0) {
    return {
      proposed: false,
      patch: null,
      packet,
      reason: BOOTSTRAP_NO_PATCH_REASON
    };
  }

  return {
    proposed: true,
    patch: {
      source: BOOTSTRAP_PATCH_SOURCE,
      changes
    },
    packet,
    reason: null
  };
}

export async function bootstrapCandidateFiles(projectRoot: string): Promise<string[]> {
  const files = await fg([...BOOTSTRAP_PATTERNS], {
    cwd: projectRoot,
    dot: true,
    ignore: [...BOOTSTRAP_IGNORE],
    onlyFiles: true,
    unique: true
  });

  return uniqueSorted(files)
    .sort(compareBootstrapCandidates)
    .slice(0, BOOTSTRAP_FILE_LIMIT);
}

interface BootstrapAnalysis {
  files: Set<string>;
  readme: ReadmeInfo | null;
  agentGuidance: AgentGuidanceInfo[];
  packageJson: PackageJsonInfo | null;
  packageManager: PackageManagerInfo | null;
  productFeatures: ProductFeatureInfo[];
}

interface ReadmeInfo {
  title: string | null;
  summary: string | null;
  features: ProductFeatureInfo[];
}

interface AgentGuidanceInfo {
  path: string;
  conventionStatements: string[];
  verificationCommands: VerificationCommandInfo[];
}

interface VerificationCommandInfo {
  command: string;
  description: string;
  evidence: Evidence[];
}

interface ProductFeatureInfo {
  title: string;
  description: string;
  evidence: Evidence[];
  appliesTo: string[];
  tags: string[];
}

interface PackageJsonInfo {
  name: string | null;
  description: string | null;
  type: string | null;
  packageManager: string | null;
  nodeEngine: string | null;
  scripts: Record<string, string>;
  bin: Record<string, string>;
  devDependencies: Set<string>;
  dependencies: Set<string>;
}

interface PackageManagerInfo {
  manager: string;
  source: string;
  spec: string | null;
}

async function analyzeBootstrapRepository(
  projectRoot: string,
  changedFiles: readonly string[]
): Promise<BootstrapAnalysis> {
  const packageJson = await readPackageJson(projectRoot);
  const readme = await readReadme(projectRoot);
  const agentGuidance = await readAgentGuidance(projectRoot);
  const packageManager = await detectPackageManager(projectRoot, packageJson);
  const codeFeatures = await codeProductFeatures(projectRoot, changedFiles, packageJson);
  const documentedFeatures = await documentedProductFeatures(projectRoot, changedFiles);

  return {
    files: new Set(changedFiles),
    readme,
    agentGuidance,
    packageJson,
    packageManager,
    productFeatures: uniqueProductFeatures([
      ...(readme?.features ?? []),
      ...codeFeatures,
      ...documentedFeatures
    ])
  };
}

async function buildBootstrapPatchChanges(
  projectRoot: string,
  storage: CanonicalStorageSnapshot,
  analysis: BootstrapAnalysis
): Promise<BootstrapPatchChange[]> {
  const changes: BootstrapPatchChange[] = [];
  const projectObject = objectById(storage, storage.config.project.id);
  const architectureObject = objectById(storage, "architecture.current");
  const standaloneObjects = bootstrapStandaloneObjectChanges(storage, analysis);
  const preliminarySourcesByPath = sourceIdsByPathForPaths(
    storage,
    bootstrapPotentialSourcePaths(analysis)
  );
  const syntheses = bootstrapSyntheses(analysis, preliminarySourcesByPath);
  const referencedSourcePaths = referencedBootstrapSourcePaths(syntheses, standaloneObjects);

  if (projectObject !== null && isInitialProjectPlaceholder(projectObject)) {
    const body = projectBootstrapBody(projectObject, analysis);

    if (body !== null) {
      changes.push({
        op: "update_object",
        id: projectObject.sidecar.id,
        body,
        tags: mergeTags(projectObject.sidecar.tags, ["project"]),
        source: BOOTSTRAP_PATCH_SOURCE
      });
    }
  }

  if (architectureObject !== null && isInitialArchitecturePlaceholder(architectureObject)) {
    const body = architectureBootstrapBody(architectureObject, analysis);

    if (body !== null) {
      changes.push({
        op: "update_object",
        id: architectureObject.sidecar.id,
        body,
        tags: mergeTags(architectureObject.sidecar.tags, ["architecture"]),
        source: BOOTSTRAP_PATCH_SOURCE
      });
    }
  }

  const projectArchitectureRelation = projectArchitectureRelationChange(storage);

  if (projectArchitectureRelation !== null) {
    changes.push(projectArchitectureRelation);
  }

  const bootstrapSources = await sourceRecordChanges(
    projectRoot,
    storage,
    analysis,
    referencedSourcePaths
  );
  changes.push(...bootstrapSources.changes);
  changes.push(...synthesisRecordChanges(storage, bootstrapSyntheses(analysis, bootstrapSources.byPath)));
  changes.push(...standaloneObjects);
  changes.push(
    ...standaloneSourceRelationChanges(storage, standaloneObjects, bootstrapSources.byPath)
  );
  changes.push(...bootstrapHubRelationChanges(storage, changes));

  return changes;
}

function recommendedBootstrapMemory(hasProductFeatures: boolean): ObjectType[] {
  return hasProductFeatures
    ? uniqueObjectTypes([...BOOTSTRAP_RECOMMENDED_MEMORY, "synthesis"])
    : [...BOOTSTRAP_RECOMMENDED_MEMORY];
}

function bootstrapStandaloneObjectChanges(
  storage: CanonicalStorageSnapshot,
  analysis: BootstrapAnalysis
): BootstrapPatchChange[] {
  return [
    packageScriptsWorkflow(storage, analysis),
    postTaskVerificationWorkflow(storage, analysis),
    codeConventionsConstraint(storage, analysis),
    nodeEngineConstraint(storage, analysis),
    packageManagerConstraint(storage, analysis)
  ].filter((change): change is BootstrapPatchChange => change !== null);
}

function recommendedMemoryForTask(task: string, changedFiles: readonly string[]): ObjectType[] {
  const recommended = isProductFeatureTask(task, changedFiles)
    ? uniqueObjectTypes([...AFTER_TASK_RECOMMENDED_MEMORY, "synthesis"])
    : [...AFTER_TASK_RECOMMENDED_MEMORY];

  return hasWorkflowSignal(task)
    ? uniqueObjectTypes(["workflow", ...recommended])
    : recommended;
}

function recommendedFacetsForTask(
  task: string,
  changedFiles: readonly string[],
  storage: CanonicalStorageSnapshot
): FacetCategory[] {
  const recommended = new Set<FacetCategory>();
  const taskText = task.toLowerCase();

  if (hasWorkflowSignal(task) && (!hasDebuggingSignal(taskText) || hasProcedureSignal(taskText))) {
    recommended.add("workflow");
  }

  if (/\b(test|spec|vitest|coverage)\b/u.test(taskText) || changedFiles.some(isTestPath)) {
    recommended.add("testing");
  }

  if (changedFiles.some(isConfigOrManifestPath)) {
    recommended.add("stack");
    recommended.add("convention");
  }

  if (changedFiles.some(isDocsOrArchitecturePath) || /\b(architecture|design|schema)\b/u.test(taskText)) {
    recommended.add("architecture");
    recommended.add("decision-rationale");
  }

  if (isProductFeatureTask(task, changedFiles)) {
    recommended.add("product-feature");
    recommended.add("capability");
  }

  if (/\b(domain|bounded context|subsystem|product area|business rule)\b/u.test(taskText)) {
    recommended.add("domain");
    recommended.add("bounded-context");
    recommended.add("business-rule");
  }

  for (const facet of RECOMMENDED_FACETS) {
    recommended.add(facet);
  }

  if (hasConflictSignal(taskText) || activeConflictsTouchRelatedMemory(storage, changedFiles)) {
    recommended.add("unresolved-conflict");
  }

  return [...recommended];
}

interface RememberTemplateForAfterTaskOptions {
  task: string;
  changedFiles: readonly string[];
  relatedMemoryIds: readonly ObjectId[];
  possibleStaleIds: readonly ObjectId[];
  recommendedMemory: readonly ObjectType[];
  recommendedEvidence: readonly Evidence[];
  recommendedRelations: readonly SuggestedRelation[];
  recommendedFacets: readonly FacetCategory[];
}

interface RecommendedActionsForAfterTaskOptions {
  task: string;
  changedFiles: readonly string[];
  relatedMemoryIds: readonly ObjectId[];
  possibleStaleIds: readonly ObjectId[];
  recommendedEvidence: readonly Evidence[];
  recommendedRelations: readonly SuggestedRelation[];
  repairCandidates: readonly MemoryRepairCandidate[];
  hasRelatedMemoryConflict: boolean;
}

function rememberTemplateForAfterTask(
  options: RememberTemplateForAfterTaskOptions
): RememberMemoryInput {
  const kind = firstRememberMemoryKind(options.recommendedMemory) ?? "fact";
  const category = firstRememberFacet(options.recommendedFacets);
  const appliesTo = options.changedFiles.length === 0 ? [] : [...options.changedFiles];
  const evidence = [...options.recommendedEvidence];

  return {
    task: options.task,
    memories: [
      {
        kind,
        title: "",
        body: "",
        ...(appliesTo.length === 0 ? {} : { applies_to: appliesTo }),
        ...(category === undefined ? {} : { category }),
        ...(evidence.length === 0 ? {} : { evidence })
      }
    ],
    updates: options.relatedMemoryIds.map((id) => ({
      id,
      body: "",
      ...(appliesTo.length === 0 ? {} : { applies_to: appliesTo }),
      ...(category === undefined ? {} : { category }),
      ...(evidence.length === 0 ? {} : { evidence })
    })),
    stale: options.possibleStaleIds.map((id) => ({
      id,
      reason: ""
    })),
    relations: options.recommendedRelations.map((relation) => ({
      from: relation.from,
      predicate: relation.predicate,
      to: relation.to,
      confidence: "medium",
      ...(evidence.length === 0 ? {} : { evidence })
    }))
  };
}

function recommendedActionsForAfterTask(
  options: RecommendedActionsForAfterTaskOptions
): SuggestedMemoryAction[] {
  const actions: SuggestedMemoryAction[] = [];
  const taskText = options.task.toLowerCase();
  const appliesTo = appliesToForChangedFiles(options.changedFiles);
  const evidence = [...options.recommendedEvidence];
  const hasStaleOrConflictSignal =
    hasStaleSignal(taskText) || hasConflictSignal(taskText) || options.hasRelatedMemoryConflict;
  const createRecommendation = createMemoryRecommendationForTask(options.task, options.changedFiles);
  const shouldCreateConflictQuestion =
    hasStaleOrConflictSignal && options.possibleStaleIds.length === 0;
  const hasDurableSignals =
    hasStaleOrConflictSignal ||
    createRecommendation !== null ||
    hasDebuggingSignal(taskText) ||
    hasArchitectureSignal(options.task, options.changedFiles);

  if (
    options.changedFiles.length === 0 &&
    options.relatedMemoryIds.length === 0 &&
    !hasDurableSignals
  ) {
    actions.push({
      rank: 0,
      action: "save_nothing",
      confidence: "high",
      reason: "No changed files, related memory, or durable task signals were detected.",
      guidance: "Report that no Memory changed instead of inventing a memory entry."
    });
  }

  for (const candidate of options.repairCandidates.slice(0, 8)) {
    const action = memoryActionForRepairCandidate({
      task: options.task,
      changedFiles: options.changedFiles,
      candidate,
      fallbackEvidence: evidence
    });

    if (!hasEquivalentAction(actions, action)) {
      actions.push(action);
    }
  }

  if (hasStaleOrConflictSignal) {
    for (const id of options.possibleStaleIds.slice(0, 5)) {
      actions.push({
        rank: 0,
        action: "mark_stale",
        confidence: "high",
        target_id: id,
        reason: "The task mentions stale, corrected, or conflicting memory and this related memory may need repair.",
        guidance: "Use this when current evidence shows the target memory is wrong or no longer useful.",
        remember_template: {
          task: options.task,
          stale: [{ id, reason: "" }]
        }
      });
      actions.push({
        rank: 0,
        action: "supersede_existing",
        confidence: "medium",
        target_id: id,
        reason: "The task may replace an older memory with a newer durable claim.",
        guidance:
          "Use this only after creating or selecting the replacement memory, then fill superseded_by with that memory id."
      });
    }
  }

  for (const id of options.relatedMemoryIds.slice(0, 5)) {
    const action: SuggestedMemoryAction = {
      rank: 0,
      action: "update_existing",
      confidence: "high",
      target_id: id,
      reason: "Existing memory overlaps the changed files; updating it avoids creating a near-duplicate.",
      guidance: "Prefer this when the work refined an existing durable claim instead of adding a separate one.",
      ...(evidence.length === 0 ? {} : { evidence }),
      remember_template: {
        task: options.task,
        updates: [
          {
            id,
            body: "",
            ...(appliesTo.length === 0 ? {} : { applies_to: appliesTo }),
            ...(evidence.length === 0 ? {} : { evidence })
          }
        ]
      }
    };

    if (!hasEquivalentAction(actions, action)) {
      actions.push(action);
    }
  }

  if (shouldCreateConflictQuestion) {
    actions.push(createMemoryAction({
      task: options.task,
      kind: "question",
      category: "unresolved-conflict",
      confidence: "high",
      evidence,
      appliesTo,
      reason: "The task mentions stale, corrected, or conflicting memory but no specific stale target was detected.",
      guidance:
        "Use this only when current evidence cannot resolve the contradiction and future agents need the open question."
    }));
  }

  if (
    createRecommendation !== null &&
    !(
      shouldCreateConflictQuestion &&
      createRecommendation.kind === "question" &&
      createRecommendation.category === "unresolved-conflict"
    )
  ) {
    actions.push(createMemoryAction({
      task: options.task,
      kind: createRecommendation.kind,
      category: createRecommendation.category,
      confidence: createRecommendation.confidence,
      evidence,
      appliesTo,
      reason: createRecommendation.reason,
      guidance: createRecommendation.guidance
    }));
  }

  for (const relation of options.recommendedRelations.slice(0, 5)) {
    actions.push({
      rank: 0,
      action: "create_relation",
      confidence: "medium",
      target_id: relation.to,
      reason: relation.reason,
      guidance: `Create a ${relation.predicate} relation only if the link is durable and useful for future agents.`,
      ...(evidence.length === 0 ? {} : { evidence }),
      remember_template: {
        task: options.task,
        relations: [
          {
            from: relation.from,
            predicate: relation.predicate,
            to: relation.to,
            confidence: "medium",
            ...(evidence.length === 0 ? {} : { evidence })
          }
        ]
      }
    });
  }

  if (actions.every((action) => action.action !== "save_nothing")) {
    actions.push({
      rank: 0,
      action: "save_nothing",
      confidence: hasDurableSignals || options.changedFiles.length > 0 ? "medium" : "high",
      reason: "Saving memory is optional; many tasks produce no durable future value.",
      guidance:
        "Choose this when Git history, existing memory, or the final response already captures everything future agents need."
    });
  }

  return rankSuggestedMemoryActions(actions);
}

function memoryActionForRepairCandidate(input: {
  task: string;
  changedFiles: readonly string[];
  candidate: MemoryRepairCandidate;
  fallbackEvidence: readonly Evidence[];
}): SuggestedMemoryAction {
  const evidence = input.candidate.evidence.length === 0
    ? [...input.fallbackEvidence]
    : [...input.candidate.evidence];
  const appliesTo = appliesToForRepairCandidate(input.candidate, input.changedFiles);

  if (input.candidate.suggested_action === "mark_stale") {
    return {
      rank: 0,
      action: "mark_stale",
      confidence: input.candidate.confidence,
      target_id: input.candidate.target_id,
      reason: input.candidate.reason,
      guidance: "Use this only when current evidence confirms the target memory is wrong or no longer useful.",
      ...(evidence.length === 0 ? {} : { evidence }),
      remember_template: {
        task: input.task,
        stale: [{ id: input.candidate.target_id, reason: "" }]
      }
    };
  }

  if (input.candidate.suggested_action === "supersede_existing") {
    return {
      rank: 0,
      action: "supersede_existing",
      confidence: input.candidate.confidence,
      target_id: input.candidate.target_id,
      reason: input.candidate.reason,
      guidance:
        "Use this when a replacement memory already exists or will be created in the same repair.",
      ...(evidence.length === 0 ? {} : { evidence })
    };
  }

  if (input.candidate.suggested_action === "create_memory") {
    return createMemoryAction({
      task: input.task,
      kind: "question",
      category: "unresolved-conflict",
      confidence: input.candidate.confidence,
      evidence,
      appliesTo,
      reason: input.candidate.reason,
      guidance:
        "Use this only when current code and evidence cannot resolve the conflict during this task."
    });
  }

  return {
    rank: 0,
    action: "update_existing",
    confidence: input.candidate.confidence,
    target_id: input.candidate.target_id,
    reason: input.candidate.reason,
    guidance:
      "Review the advisory evidence and update the target memory with the current verified claim.",
    ...(evidence.length === 0 ? {} : { evidence }),
    remember_template: {
      task: input.task,
      updates: [
        {
          id: input.candidate.target_id,
          body: "",
          ...(appliesTo.length === 0 ? {} : { applies_to: appliesTo }),
          ...(evidence.length === 0 ? {} : { evidence })
        }
      ]
    }
  };
}

function appliesToForRepairCandidate(
  candidate: MemoryRepairCandidate,
  changedFiles: readonly string[]
): string[] {
  const evidenceFiles = candidate.evidence
    .filter((item) => item.kind === "file")
    .map((item) => item.id);

  return uniqueSorted([...changedFiles, ...evidenceFiles]);
}

function hasEquivalentAction(
  actions: readonly SuggestedMemoryAction[],
  candidate: SuggestedMemoryAction
): boolean {
  return actions.some(
    (action) =>
      action.action === candidate.action &&
      action.target_id === candidate.target_id &&
      action.memory_kind === candidate.memory_kind &&
      action.category === candidate.category
  );
}

function createMemoryAction(input: {
  task: string;
  kind: RememberMemoryKind;
  category: FacetCategory;
  confidence: RelationConfidence;
  reason: string;
  guidance: string;
  evidence: readonly Evidence[];
  appliesTo: readonly string[];
}): SuggestedMemoryAction {
  return {
    rank: 0,
    action: "create_memory",
    confidence: input.confidence,
    memory_kind: input.kind,
    category: input.category,
    reason: input.reason,
    guidance: input.guidance,
    ...(input.evidence.length === 0 ? {} : { evidence: [...input.evidence] }),
    remember_template: {
      task: input.task,
      memories: [
        {
          kind: input.kind,
          title: "",
          body: "",
          category: input.category,
          ...(input.appliesTo.length === 0 ? {} : { applies_to: [...input.appliesTo] }),
          ...(input.evidence.length === 0 ? {} : { evidence: [...input.evidence] })
        }
      ]
    }
  };
}

function rankSuggestedMemoryActions(
  actions: readonly SuggestedMemoryAction[]
): SuggestedMemoryAction[] {
  return actions.map((action, index) => ({ ...action, rank: index + 1 }));
}

function appliesToForChangedFiles(changedFiles: readonly string[]): string[] {
  return changedFiles.length === 0 ? [] : [...changedFiles];
}

function createMemoryRecommendationForTask(
  task: string,
  changedFiles: readonly string[]
): {
  kind: RememberMemoryKind;
  category: FacetCategory;
  confidence: RelationConfidence;
  reason: string;
  guidance: string;
} | null {
  const taskText = task.toLowerCase();

  if (hasWorkflowSignal(task) && (!hasDebuggingSignal(taskText) || hasProcedureSignal(taskText))) {
    return {
      kind: "workflow",
      category: "workflow",
      confidence: "high",
      reason: "The task describes a reusable procedure, runbook, command sequence, or verification routine.",
      guidance: "Save a workflow only when future agents should repeat the procedure."
    };
  }

  if (hasConflictSignal(taskText)) {
    return {
      kind: "question",
      category: "unresolved-conflict",
      confidence: "high",
      reason: "The task mentions conflicting or ambiguous memory that may need an explicit unresolved question.",
      guidance: "Use this only when current code and evidence cannot settle the conflict."
    };
  }

  if (hasDebuggingSignal(taskText)) {
    return {
      kind: "gotcha",
      category: "gotcha",
      confidence: "high",
      reason: "The task describes debugging, failure, or a repeated trap future agents should avoid.",
      guidance: "Save the gotcha as a concise failure mode with the current workaround or correction."
    };
  }

  if (isProductFeatureTask(task, changedFiles)) {
    return {
      kind: "synthesis",
      category: "feature-map",
      confidence: "medium",
      reason: "The task appears to change user-facing product capability or feature-map context.",
      guidance: "Update an existing feature-map synthesis when possible; create one only for a new durable area summary."
    };
  }

  if (hasArchitectureSignal(task, changedFiles)) {
    return {
      kind: "decision",
      category: "decision-rationale",
      confidence: "medium",
      reason: "The task touches architecture, schema, docs, or design rationale.",
      guidance: "Save a decision only when the work established a durable architectural choice."
    };
  }

  return null;
}

function firstRememberMemoryKind(values: readonly ObjectType[]): RememberMemoryKind | null {
  for (const value of values) {
    if (
      value === "source" ||
      value === "synthesis" ||
      value === "decision" ||
      value === "constraint" ||
      value === "fact" ||
      value === "gotcha" ||
      value === "workflow" ||
      value === "question" ||
      value === "concept" ||
      value === "note"
    ) {
      return value;
    }
  }

  return null;
}

function firstRememberFacet(values: readonly FacetCategory[]): FacetCategory | undefined {
  return values[0];
}

function hasConflictSignal(taskText: string): boolean {
  return /\b(conflicts?|contradictions?|contradictory|stale|corrections?|corrected|wrong assumptions?|ambiguous|ambiguity)\b/u.test(
    taskText
  );
}

function hasStaleSignal(taskText: string): boolean {
  return /\b(stale|outdated|obsolete|supersed(?:e|ed|es|ing)|replaced?|retired|deprecated)\b/u.test(
    taskText
  );
}

function hasDebuggingSignal(taskText: string): boolean {
  return /\b(debug|debugging|failure|failed|bug|regression|broken|trap|gotcha|workaround|root cause)\b/u.test(
    taskText
  );
}

function hasProcedureSignal(taskText: string): boolean {
  return /\b(how[-\s]?to|procedure|procedures|checklist|runbook|setup|onboarding|release|migration|migrate|maintenance|verification|verify|smoke test|recovery|recover|restore|command sequence|commands|routine|workflow)\b/u.test(
    taskText
  );
}

function hasArchitectureSignal(task: string, changedFiles: readonly string[]): boolean {
  return (
    /\b(architecture|architectural|design|schema|data model|interface|api contract|rationale)\b/u.test(
      task.toLowerCase()
    ) || changedFiles.some(isDocsOrArchitecturePath)
  );
}

function hasWorkflowSignal(task: string): boolean {
  return /\b(how[-\s]?to|procedure|procedures|checklist|runbook|setup|onboarding|release|migration|migrate|debugging|debug|maintenance|verification|verify|smoke test|recovery|recover|restore|command sequence|commands|routine|workflow)\b/u.test(
    task.toLowerCase()
  );
}

function activeConflictsTouchRelatedMemory(
  storage: CanonicalStorageSnapshot,
  changedFiles: readonly string[]
): boolean {
  const related = new Set(relatedMemoryIds(storage, changedFiles));

  if (related.size === 0) {
    return false;
  }

  return storage.relations.some(
    (relation) =>
      relation.relation.status === "active" &&
      (relation.relation.predicate === "conflicts_with" ||
        relation.relation.predicate === "challenges") &&
      (related.has(relation.relation.from) || related.has(relation.relation.to))
  );
}

function isTestPath(path: string): boolean {
  return /(?:^|\/)(test|tests|__tests__)\/|\.test\.|\.spec\./u.test(path);
}

function isConfigOrManifestPath(path: string): boolean {
  return /(?:^|\/)(package\.json|pnpm-lock\.yaml|tsconfig[^/]*\.json|vite\.config\.|vitest\.config\.|next\.config\.|svelte\.config\.)/u.test(
    path
  );
}

function isDocsOrArchitecturePath(path: string): boolean {
  return path.startsWith("docs/") || /\.mdx?$/u.test(path);
}

function isProductFeatureTask(task: string, changedFiles: readonly string[]): boolean {
  const taskText = task.toLowerCase();

  return (
    /\b(features?|capabilit(?:y|ies)|product|user-facing|ux|ui|routes?|pages?|screens?)\b/u.test(
      taskText
    ) ||
    changedFiles.some((file) =>
      /(?:^|\/)(app|pages|routes)\/|(?:^|\/)(components|viewer)\/|(?:^|\/)README\.md$/u.test(
        file
      )
    )
  );
}

function projectBootstrapBody(
  object: StoredMemoryObject,
  analysis: BootstrapAnalysis
): string | null {
  const purpose = analysis.packageJson?.description ?? analysis.readme?.summary;

  if (purpose === undefined || purpose === null || purpose === "") {
    return null;
  }

  const lines = [`# ${object.sidecar.title}`, "", purpose];

  if (analysis.packageJson?.name !== null && analysis.packageJson?.name !== undefined) {
    lines.push("", `Package: \`${analysis.packageJson.name}\`.`);
  }

  return `${lines.join("\n")}\n`;
}

function architectureBootstrapBody(
  object: StoredMemoryObject,
  analysis: BootstrapAnalysis
): string | null {
  const signals = architectureSignals(analysis);

  if (signals.length < 2) {
    return null;
  }

  return [`# ${object.sidecar.title}`, "", ...signals.map((signal) => `- ${signal}`), ""].join(
    "\n"
  );
}

function architectureSignals(analysis: BootstrapAnalysis): string[] {
  const signals: string[] = [];
  const files = analysis.files;
  const packageJson = analysis.packageJson;

  if (hasAnyPrefix(files, ["src/"])) {
    signals.push("Primary source files are under `src/`.");
  }

  if (hasAnyPrefix(files, ["app/"])) {
    signals.push("Application entrypoints are under `app/`.");
  }

  if (hasAnyPrefix(files, ["lib/"])) {
    signals.push("Reusable library code is under `lib/`.");
  }

  if (hasTypeScriptSignal(files)) {
    signals.push("The codebase uses TypeScript.");
  }

  if (packageJson?.type === "module") {
    signals.push("The package is configured as an ESM package with `type: module`.");
  }

  if (hasConfig(files, "next")) {
    signals.push("Next.js configuration is present.");
  }

  if (hasConfig(files, "vite")) {
    signals.push("Vite configuration is present.");
  }

  if (hasConfig(files, "svelte")) {
    signals.push("Svelte configuration is present.");
  }

  if (hasVitestSignal(files, packageJson)) {
    signals.push("Vitest is the configured test runner.");
  } else if (hasAnyPrefix(files, ["test/", "tests/"])) {
    signals.push("Tests are kept under `test/` or `tests/`.");
  }

  return signals;
}

interface RepositoryMapEntry {
  label: string;
  description: string;
  paths: string[];
}

function repositoryMapEntries(analysis: BootstrapAnalysis): RepositoryMapEntry[] {
  const files = analysis.files;
  const entries: RepositoryMapEntry[] = [];

  pushRepositoryEntry(entries, files, "Source", "Primary implementation code.", ["src/"]);
  pushRepositoryEntry(entries, files, "Application routes", "Application routes or framework entrypoints.", [
    "app/",
    "pages/",
    "routes/"
  ]);
  pushRepositoryEntry(entries, files, "Reusable library", "Reusable library code and shared modules.", [
    "lib/"
  ]);
  pushRepositoryEntry(entries, files, "Tests", "Automated tests and test fixtures.", [
    "test/",
    "tests/",
    "__tests__/"
  ]);
  pushRepositoryEntry(entries, files, "Documentation", "Human and agent-facing project documentation.", [
    "docs/",
    "specs/"
  ]);
  pushRepositoryEntry(entries, files, "Viewer", "Local viewer or user interface code.", ["viewer/"]);
  pushRepositoryEntry(entries, files, "Integrations", "Agent, editor, or external integration templates.", [
    "integrations/"
  ]);
  pushRepositoryEntry(entries, files, "Scripts", "Project automation and maintenance scripts.", [
    "scripts/"
  ]);

  const manifestPaths = [...files].filter(isManifestOrConfig).sort();

  if (manifestPaths.length > 0) {
    entries.push({
      label: "Manifests and config",
      description: manifestPaths.slice(0, 8).map((path) => `\`${path}\``).join(", "),
      paths: manifestPaths
    });
  }

  return entries;
}

function pushRepositoryEntry(
  entries: RepositoryMapEntry[],
  files: Set<string>,
  label: string,
  description: string,
  prefixes: readonly string[]
): void {
  const paths = [...files].filter((file) => prefixes.some((prefix) => file.startsWith(prefix))).sort();

  if (paths.length === 0) {
    return;
  }

  entries.push({
    label,
    description,
    paths: paths.slice(0, 8)
  });
}

function stackToolingSignals(analysis: BootstrapAnalysis): string[] {
  const signals: string[] = [];
  const files = analysis.files;
  const packageJson = analysis.packageJson;

  if (packageJson?.name !== null && packageJson?.name !== undefined) {
    signals.push(`Package name: \`${packageJson.name}\`.`);
  }

  if (packageJson?.type === "module") {
    signals.push("The package is configured as an ESM package with `type: module`.");
  }

  if (analysis.packageManager !== null) {
    signals.push(
      analysis.packageManager.spec === null
        ? `Package manager is inferred as ${analysis.packageManager.manager} from \`${analysis.packageManager.source}\`.`
        : `Package manager is declared as \`${analysis.packageManager.spec}\`.`
    );
  }

  if (packageJson?.nodeEngine !== null && packageJson?.nodeEngine !== undefined) {
    signals.push(`Node.js engine constraint: \`${packageJson.nodeEngine}\`.`);
  }

  if (hasTypeScriptSignal(files)) {
    signals.push("TypeScript configuration is present.");
  }

  for (const framework of detectedFrameworkSignals(files, packageJson)) {
    signals.push(framework);
  }

  if (hasVitestSignal(files, packageJson)) {
    signals.push("Vitest is available for tests.");
  }

  const scripts = Object.keys(packageJson?.scripts ?? {})
    .sort(comparePostTaskScriptNames)
    .slice(0, 8);

  if (scripts.length > 0) {
    signals.push(`Useful package scripts include ${scripts.map((script) => `\`${script}\``).join(", ")}.`);
  }

  return uniqueSorted(signals);
}

function detectedFrameworkSignals(
  files: Set<string>,
  packageJson: PackageJsonInfo | null
): string[] {
  const dependencies = new Set([
    ...(packageJson?.dependencies ?? []),
    ...(packageJson?.devDependencies ?? [])
  ]);
  const signals: string[] = [];

  if (hasConfig(files, "next") || dependencies.has("next")) {
    signals.push("Next.js is present.");
  }

  if (hasConfig(files, "svelte") || dependencies.has("svelte")) {
    signals.push("Svelte tooling is present.");
  }

  if (hasConfig(files, "vite") || dependencies.has("vite")) {
    signals.push("Vite tooling is present.");
  }

  if (dependencies.has("commander")) {
    signals.push("Commander is used for CLI command handling.");
  }

  return signals;
}

function projectArchitectureRelationChange(
  storage: CanonicalStorageSnapshot
): BootstrapPatchChange | null {
  const projectObject = objectById(storage, storage.config.project.id);
  const architectureObject = objectById(storage, CURRENT_ARCHITECTURE_ID);

  if (projectObject === null || architectureObject === null) {
    return null;
  }

  if (
    hasEquivalentRelation(
      storage,
      projectObject.sidecar.id,
      PROJECT_ARCHITECTURE_PREDICATE,
      architectureObject.sidecar.id
    )
  ) {
    return null;
  }

  return {
    op: "create_relation",
    id: generateRelationId({
      from: projectObject.sidecar.id,
      predicate: PROJECT_ARCHITECTURE_PREDICATE,
      to: architectureObject.sidecar.id,
      existingIds: storage.relations.map((relation) => relation.relation.id)
    }),
    from: projectObject.sidecar.id,
    predicate: PROJECT_ARCHITECTURE_PREDICATE,
    to: architectureObject.sidecar.id,
    status: "active",
    confidence: "high"
  };
}

function hasEquivalentRelation(
  storage: CanonicalStorageSnapshot,
  from: ObjectId,
  predicate: Predicate,
  to: ObjectId
): boolean {
  return storage.relations.some(
    (relation) =>
      relation.relation.from === from &&
      relation.relation.predicate === predicate &&
      relation.relation.to === to
  );
}

interface BootstrapSourceRecords {
  changes: BootstrapPatchChange[];
  byPath: Map<string, ObjectId>;
}

function sourceIdsByPathForPaths(
  storage: CanonicalStorageSnapshot,
  paths: readonly string[]
): Map<string, ObjectId> {
  const byPath = new Map<string, ObjectId>();

  for (const path of paths) {
    const title = `Source: ${path}`;
    const existing = similarObject(storage, "source", sourceIdForPath(path), title);
    byPath.set(path, existing?.sidecar.id ?? sourceIdForPath(path));
  }

  return byPath;
}

async function sourceRecordChanges(
  projectRoot: string,
  storage: CanonicalStorageSnapshot,
  analysis: BootstrapAnalysis,
  paths: readonly string[]
): Promise<BootstrapSourceRecords> {
  const changes: BootstrapPatchChange[] = [];
  const byPath = new Map<string, ObjectId>();

  for (const path of paths) {
    const title = `Source: ${path}`;
    const id = sourceIdForPath(path);
    const existing = similarObject(storage, "source", id, title);
    const sourceId = existing?.sidecar.id ?? id;
    const origin = await fileSourceOrigin({ projectRoot, locator: path });

    byPath.set(path, sourceId);

    if (existing !== undefined) {
      if (existing.sidecar.origin === undefined) {
        changes.push({
          op: "update_object",
          id: sourceId,
          origin
        });
      }
      continue;
    }

    changes.push({
      op: "create_object",
      id,
      type: "source",
      title,
      body: sourceBody(path, analysis),
      tags: ["source"],
      facets: {
        category: "source",
        applies_to: [path],
        load_modes: ["onboarding", "architecture"]
      },
      evidence: [{ kind: "file", id: path }],
      origin
    });
  }

  return { changes, byPath };
}

function synthesisRecordChanges(
  storage: CanonicalStorageSnapshot,
  syntheses: readonly BootstrapSynthesis[]
): BootstrapPatchChange[] {
  const changes: BootstrapPatchChange[] = [];
  const existingRelationIds = new Set(storage.relations.map((relation) => relation.relation.id));

  for (const synthesis of syntheses) {
    const existing = similarObject(storage, "synthesis", synthesis.id, synthesis.title);
    const synthesisId = existing?.sidecar.id ?? synthesis.id;

    if (existing === undefined) {
      changes.push({
        op: "create_object",
        id: synthesis.id,
        type: "synthesis",
        title: synthesis.title,
        body: synthesis.body,
        tags: synthesis.tags,
        facets: synthesis.facets,
        evidence: synthesis.evidence
      });
    } else if (shouldRepairBootstrapSynthesis(existing, synthesis)) {
      changes.push({
        op: "update_object",
        id: existing.sidecar.id,
        body: synthesis.body,
        tags: mergeTags(existing.sidecar.tags, synthesis.tags),
        facets: synthesis.facets,
        evidence: synthesis.evidence
      });
    }

    for (const sourceId of synthesis.sourceIds) {
      if (hasEquivalentRelation(storage, synthesisId, "derived_from", sourceId)) {
        continue;
      }

      const relationId = generateRelationId({
        from: synthesisId,
        predicate: "derived_from",
        to: sourceId,
        existingIds: existingRelationIds
      });
      existingRelationIds.add(relationId);
      changes.push({
        op: "create_relation",
        id: relationId,
        from: synthesisId,
        predicate: "derived_from",
        to: sourceId,
        status: "active",
        confidence: "high",
        evidence: [{ kind: "source", id: sourceId }]
      });
    }
  }

  return changes;
}

function standaloneSourceRelationChanges(
  storage: CanonicalStorageSnapshot,
  objectChanges: readonly BootstrapPatchChange[],
  sourcesByPath: ReadonlyMap<string, ObjectId>
): BootstrapPatchChange[] {
  const changes: BootstrapPatchChange[] = [];
  const existingRelationIds = relationIdsFromStorageAndChanges(storage, objectChanges);

  for (const change of objectChanges) {
    if (change.op === "create_relation") {
      continue;
    }

    const sourceIds = sourceIdsForEvidence(sourcesByPath, change.evidence ?? []);

    for (const sourceId of sourceIds) {
      if (
        relationExistsInStorageOrChanges(
          storage,
          [...objectChanges, ...changes],
          change.id,
          "derived_from",
          sourceId
        )
      ) {
        continue;
      }

      const relationId = generateRelationId({
        from: change.id,
        predicate: "derived_from",
        to: sourceId,
        existingIds: existingRelationIds
      });
      existingRelationIds.add(relationId);
      changes.push({
        op: "create_relation",
        id: relationId,
        from: change.id,
        predicate: "derived_from",
        to: sourceId,
        status: "active",
        confidence: "high",
        evidence: [{ kind: "source", id: sourceId }]
      });
    }
  }

  return changes;
}

function bootstrapHubRelationChanges(
  storage: CanonicalStorageSnapshot,
  existingChanges: readonly BootstrapPatchChange[]
): BootstrapPatchChange[] {
  const projectObject = objectById(storage, storage.config.project.id);

  if (projectObject === null) {
    return [];
  }

  const changes: BootstrapPatchChange[] = [];
  const existingRelationIds = relationIdsFromStorageAndChanges(storage, existingChanges);

  for (const spec of BOOTSTRAP_HUB_RELATIONS) {
    const from = bootstrapHubObjectId(storage, existingChanges, spec);

    if (
      from === null ||
      relationExistsInStorageOrChanges(
        storage,
        [...existingChanges, ...changes],
        from,
        spec.predicate,
        projectObject.sidecar.id
      )
    ) {
      continue;
    }

    const relationId = generateRelationId({
      from,
      predicate: spec.predicate,
      to: projectObject.sidecar.id,
      existingIds: existingRelationIds
    });
    existingRelationIds.add(relationId);
    changes.push({
      op: "create_relation",
      id: relationId,
      from,
      predicate: spec.predicate,
      to: projectObject.sidecar.id,
      status: "active",
      confidence: "high",
      evidence: [
        { kind: "memory", id: from },
        { kind: "memory", id: projectObject.sidecar.id }
      ]
    });
  }

  return changes;
}

function bootstrapHubObjectId(
  storage: CanonicalStorageSnapshot,
  changes: readonly BootstrapPatchChange[],
  spec: (typeof BOOTSTRAP_HUB_RELATIONS)[number]
): ObjectId | null {
  if (
    changes.some((change) => change.op !== "create_relation" && change.id === spec.id)
  ) {
    return spec.id;
  }

  return similarObject(storage, spec.type, spec.id, spec.title)?.sidecar.id ?? null;
}

function relationExistsInStorageOrChanges(
  storage: CanonicalStorageSnapshot,
  changes: readonly BootstrapPatchChange[],
  from: ObjectId,
  predicate: Predicate,
  to: ObjectId
): boolean {
  return (
    hasEquivalentRelation(storage, from, predicate, to) ||
    changes.some(
      (change) =>
        change.op === "create_relation" &&
        change.from === from &&
        change.predicate === predicate &&
        change.to === to
    )
  );
}

function relationIdsFromStorageAndChanges(
  storage: CanonicalStorageSnapshot,
  changes: readonly BootstrapPatchChange[]
): Set<RelationId> {
  return new Set([
    ...storage.relations.map((relation) => relation.relation.id),
    ...changes.flatMap((change) =>
      change.op === "create_relation" && change.id !== undefined ? [change.id] : []
    )
  ]);
}

function shouldRepairBootstrapSynthesis(
  existing: StoredMemoryObject,
  synthesis: BootstrapSynthesis
): boolean {
  if (existing.body === synthesis.body) {
    return false;
  }

  const prose = existing.body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join(" ")
    .trim();

  if (prose === "") {
    return true;
  }

  const normalized = prose.toLowerCase();

  return [
    "memory starts here",
    "project-level memory",
    "not enough information",
    "waiting for the right information"
  ].some((placeholder) => normalized.includes(placeholder));
}

interface BootstrapSynthesis {
  id: ObjectId;
  title: string;
  body: string;
  tags: string[];
  facets: ObjectFacets;
  evidence: Evidence[];
  sourcePaths: string[];
  sourceIds: ObjectId[];
}

function bootstrapSyntheses(
  analysis: BootstrapAnalysis,
  sourcesByPath: ReadonlyMap<string, ObjectId>
): BootstrapSynthesis[] {
  return [
    productIntentSynthesis(analysis, sourcesByPath),
    featureMapSynthesis(analysis, sourcesByPath),
    repositoryMapSynthesis(analysis, sourcesByPath),
    stackToolingSynthesis(analysis, sourcesByPath),
    conventionsQualitySynthesis(analysis, sourcesByPath),
    agentGuidanceSynthesis(analysis, sourcesByPath)
  ].filter((synthesis): synthesis is BootstrapSynthesis => synthesis !== null);
}

function productIntentSynthesis(
  analysis: BootstrapAnalysis,
  sourcesByPath: ReadonlyMap<string, ObjectId>
): BootstrapSynthesis | null {
  const purpose = analysis.packageJson?.description ?? analysis.readme?.summary;

  if (purpose === undefined || purpose === null || purpose === "") {
    return null;
  }

  const sourceIds = sourceIdsForPaths(sourcesByPath, ["README.md", "package.json"]);
  const sourcePaths = sourcePathsForIds(sourcesByPath, ["README.md", "package.json"]);

  return {
    id: "synthesis.product-intent",
    title: "Product intent",
    body: [
      "# Product intent",
      "",
      purpose,
      "",
      "Maintain this synthesis when the project's purpose, user promise, or product direction changes.",
      ""
    ].join("\n"),
    tags: ["synthesis", "product-intent"],
    facets: {
      category: "product-intent",
      load_modes: ["coding", "architecture", "onboarding"]
    },
    evidence: sourceEvidence(sourceIds),
    sourcePaths,
    sourceIds
  };
}

function featureMapSynthesis(
  analysis: BootstrapAnalysis,
  sourcesByPath: ReadonlyMap<string, ObjectId>
): BootstrapSynthesis | null {
  const features = analysis.productFeatures.slice(0, BOOTSTRAP_PRODUCT_FEATURE_LIMIT);

  if (features.length === 0) {
    return null;
  }

  const featureEvidence = features.flatMap((feature) => feature.evidence);
  const sourceIds = sourceIdsForEvidence(sourcesByPath, featureEvidence);
  const sourcePaths = sourcePathsForEvidence(sourcesByPath, featureEvidence);

  return {
    id: "synthesis.feature-map",
    title: "Feature map",
    body: [
      "# Feature map",
      "",
      "Current product capabilities inferred from durable repository evidence:",
      ...features.map((feature) => `- ${feature.title}: ${feature.description}`),
      "",
      "Update this synthesis when features are added, removed, renamed, or replaced.",
      ""
    ].join("\n"),
    tags: ["synthesis", "features"],
    facets: {
      category: "feature-map",
      applies_to: uniqueSorted(features.flatMap((feature) => feature.appliesTo)),
      load_modes: ["coding", "onboarding"]
    },
    evidence: sourceEvidence(sourceIds),
    sourcePaths,
    sourceIds
  };
}

function repositoryMapSynthesis(
  analysis: BootstrapAnalysis,
  sourcesByPath: ReadonlyMap<string, ObjectId>
): BootstrapSynthesis | null {
  const entries = repositoryMapEntries(analysis);

  if (entries.length === 0) {
    return null;
  }

  const appliesTo = uniqueSorted(entries.flatMap((entry) => entry.paths));
  const sourceIds = sourceIdsForPaths(sourcesByPath, ["README.md", "package.json"]);
  const sourcePaths = sourcePathsForIds(sourcesByPath, ["README.md", "package.json"]);

  return {
    id: "synthesis.repository-map",
    title: "Repository map",
    body: [
      "# Repository map",
      "",
      "Important repository areas inferred from durable files:",
      ...entries.map((entry) => `- ${entry.label}: ${entry.description}`),
      "",
      "Update this synthesis when major directories, packages, generated assets, or entrypoints move.",
      ""
    ].join("\n"),
    tags: ["synthesis", "repository-map"],
    facets: {
      category: "file-layout",
      applies_to: appliesTo,
      load_modes: ["coding", "architecture", "onboarding"]
    },
    evidence: [...sourceEvidence(sourceIds), ...appliesTo.slice(0, 12).map((path) => ({ kind: "file" as const, id: path }))],
    sourcePaths,
    sourceIds
  };
}

function stackToolingSynthesis(
  analysis: BootstrapAnalysis,
  sourcesByPath: ReadonlyMap<string, ObjectId>
): BootstrapSynthesis | null {
  const signals = stackToolingSignals(analysis);

  if (signals.length === 0) {
    return null;
  }

  const sourcePaths = uniqueSorted([
    "package.json",
    ...(analysis.packageManager === null ? [] : [analysis.packageManager.source])
  ]).filter((path) => analysis.files.has(path));
  const sourceIds = sourceIdsForPaths(sourcesByPath, sourcePaths);
  const appliesTo = uniqueSorted([
    ...sourcePaths,
    ...[...analysis.files].filter(isManifestOrConfig)
  ]);

  return {
    id: "synthesis.stack-and-tooling",
    title: "Stack and tooling",
    body: [
      "# Stack and tooling",
      "",
      "Tooling and runtime signals inferred from manifests and config:",
      ...signals.map((signal) => `- ${signal}`),
      "",
      "Update this synthesis when the language stack, runtime constraints, package manager, or verification tooling changes.",
      ""
    ].join("\n"),
    tags: ["synthesis", "stack", "tooling"],
    facets: {
      category: "stack",
      applies_to: appliesTo,
      load_modes: ["coding", "debugging", "review", "architecture", "onboarding"]
    },
    evidence: [...sourceEvidence(sourceIds), ...appliesTo.slice(0, 12).map((path) => ({ kind: "file" as const, id: path }))],
    sourcePaths,
    sourceIds
  };
}

function conventionsQualitySynthesis(
  analysis: BootstrapAnalysis,
  sourcesByPath: ReadonlyMap<string, ObjectId>
): BootstrapSynthesis | null {
  const statements = uniqueSorted(
    analysis.agentGuidance.flatMap((guidance) => guidance.conventionStatements)
  ).slice(0, 8);
  const commands = postTaskVerificationCommands(analysis).slice(0, 6);

  if (statements.length === 0 && commands.length === 0) {
    return null;
  }

  const paths = uniqueSorted([
    ...analysis.agentGuidance.map((guidance) => guidance.path),
    ...(analysis.packageJson === null ? [] : ["package.json"])
  ]);
  const sourceIds = sourceIdsForPaths(sourcesByPath, paths);

  return {
    id: "synthesis.conventions-quality",
    title: "Conventions and quality bar",
    body: [
      "# Conventions and quality bar",
      "",
      ...(statements.length === 0
        ? []
        : ["Project-specific conventions:", ...statements.map((statement) => `- ${statement}`), ""]),
      ...(commands.length === 0
        ? []
        : ["Verification expectations:", ...commands.map((command) => `- ${command.command}: ${command.description}`), ""]),
      "Update this synthesis when explicit repo conventions, review expectations, or completion checks change.",
      ""
    ].join("\n"),
    tags: ["synthesis", "convention", "quality"],
    facets: {
      category: "convention",
      applies_to: paths,
      load_modes: ["coding", "review", "onboarding"]
    },
    evidence: [...sourceEvidence(sourceIds), ...paths.map((path) => ({ kind: "file" as const, id: path }))],
    sourcePaths: paths,
    sourceIds
  };
}

function agentGuidanceSynthesis(
  analysis: BootstrapAnalysis,
  sourcesByPath: ReadonlyMap<string, ObjectId>
): BootstrapSynthesis | null {
  if (analysis.agentGuidance.length === 0) {
    return null;
  }

  const paths = analysis.agentGuidance.map((guidance) => guidance.path);
  const sourceIds = sourceIdsForPaths(sourcesByPath, paths);

  return {
    id: "synthesis.agent-guidance",
    title: "Agent guidance",
    body: [
      "# Agent guidance",
      "",
      "Project-specific operating rules for AI coding agents are maintained in:",
      ...paths.map((path) => `- \`${path}\``),
      "",
      "Keep this synthesis focused on where agent instructions live and when they should be consulted. Coding conventions and verification commands from those files are represented in separate convention and workflow memory.",
      "",
      "Update this synthesis when agent instruction files are added, removed, renamed, or replaced.",
      ""
    ].join("\n"),
    tags: ["synthesis", "agents", "guidance"],
    facets: {
      category: "agent-guidance",
      applies_to: paths,
      load_modes: ["coding", "review", "onboarding"]
    },
    evidence: sourceEvidence(sourceIds),
    sourcePaths: paths,
    sourceIds
  };
}

function bootstrapPotentialSourcePaths(analysis: BootstrapAnalysis): string[] {
  return uniqueSorted([
    ...(analysis.readme === null ? [] : ["README.md"]),
    ...(analysis.packageJson === null ? [] : ["package.json"]),
    ...(analysis.packageManager === null ? [] : [analysis.packageManager.source]),
    ...analysis.agentGuidance.map((guidance) => guidance.path),
    ...analysis.productFeatures.flatMap((feature) =>
      feature.evidence.filter((item) => item.kind === "file").map((item) => item.id)
    )
  ]).slice(0, 10);
}

function referencedBootstrapSourcePaths(
  syntheses: readonly BootstrapSynthesis[],
  objectChanges: readonly BootstrapPatchChange[]
): string[] {
  return uniqueSorted([
    ...syntheses.flatMap((synthesis) => synthesis.sourcePaths),
    ...objectChanges.flatMap(fileEvidencePathsFromChange)
  ]);
}

function fileEvidencePathsFromChange(change: BootstrapPatchChange): string[] {
  if (change.op === "create_relation") {
    return [];
  }

  return (change.evidence ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.id);
}

function sourceBody(path: string, analysis: BootstrapAnalysis): string {
  const details = sourceDetails(path, analysis);

  return [
    `# Source: ${path}`,
    "",
    `This source records that durable Memory can be derived from \`${path}\`.`,
    ...(details.length === 0 ? [] : ["", "Captured signals:", ...details.map((detail) => `- ${detail}`)]),
    ""
  ].join("\n");
}

function sourceDetails(path: string, analysis: BootstrapAnalysis): string[] {
  if (path === "README.md") {
    return [
      ...(analysis.readme?.title === null || analysis.readme?.title === undefined
        ? []
        : [`README title: ${analysis.readme.title}`]),
      ...(analysis.readme?.summary === null || analysis.readme?.summary === undefined
        ? []
        : [`README summary: ${analysis.readme.summary}`])
    ];
  }

  if (path === "package.json") {
    return [
      ...(analysis.packageJson?.name === null || analysis.packageJson?.name === undefined
        ? []
        : [`Package name: ${analysis.packageJson.name}`]),
      ...(analysis.packageJson?.description === null || analysis.packageJson?.description === undefined
        ? []
        : [`Package description: ${analysis.packageJson.description}`])
    ];
  }

  if (analysis.agentGuidance.some((guidance) => guidance.path === path)) {
    return ["Agent guidance file with conventions or verification workflows."];
  }

  return [];
}

function sourceIdForPath(path: string): ObjectId {
  const slug = path
    .toLowerCase()
    .replace(/\.(?:md|mdx)$/u, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

  return `source.${slug === "" ? "record" : slug}` as ObjectId;
}

function sourceIdsForPaths(
  sourcesByPath: ReadonlyMap<string, ObjectId>,
  paths: readonly string[]
): ObjectId[] {
  return uniqueSorted(paths.map((path) => sourcesByPath.get(path)).filter(isString));
}

function sourcePathsForIds(
  sourcesByPath: ReadonlyMap<string, ObjectId>,
  paths: readonly string[]
): string[] {
  return uniqueSorted(paths.filter((path) => sourcesByPath.has(path)));
}

function sourceIdsForEvidence(
  sourcesByPath: ReadonlyMap<string, ObjectId>,
  evidence: readonly Evidence[]
): ObjectId[] {
  const paths = evidence
    .filter((item) => item.kind === "file")
    .map((item) => item.id)
    .filter((path) => sourcesByPath.has(path));

  return sourceIdsForPaths(sourcesByPath, paths);
}

function sourcePathsForEvidence(
  sourcesByPath: ReadonlyMap<string, ObjectId>,
  evidence: readonly Evidence[]
): string[] {
  return uniqueSorted(
    evidence
      .filter((item) => item.kind === "file")
      .map((item) => item.id)
      .filter((path) => sourcesByPath.has(path))
  );
}

function sourceEvidence(sourceIds: readonly ObjectId[]): Evidence[] {
  return sourceIds.map((id) => ({ kind: "source", id }));
}

function packageScriptsWorkflow(
  storage: CanonicalStorageSnapshot,
  analysis: BootstrapAnalysis
): BootstrapPatchChange | null {
  const scripts = analysis.packageJson?.scripts ?? {};
  const entries = Object.entries(scripts)
    .filter(([, value]) => value.trim() !== "")
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 8);

  if (
    entries.length === 0 ||
    hasSimilarObject(storage, "workflow", "workflow.package-scripts", "Package scripts")
  ) {
    return null;
  }

  return {
    op: "create_object",
    id: "workflow.package-scripts",
    type: "workflow",
    title: "Package scripts",
    body: [
      "# Package scripts",
      "",
      "Use the package scripts in `package.json` for repeated project workflows:",
      ...entries.map(([name, value]) => `- \`${name}\`: \`${value}\``),
      ""
    ].join("\n"),
    tags: ["package", "workflow"],
    facets: {
      category: "workflow",
      applies_to: ["package.json"],
      load_modes: ["coding", "debugging", "onboarding"]
    },
    evidence: [{ kind: "file", id: "package.json" }]
  };
}

function postTaskVerificationWorkflow(
  storage: CanonicalStorageSnapshot,
  analysis: BootstrapAnalysis
): BootstrapPatchChange | null {
  if (
    hasSimilarObject(
      storage,
      "workflow",
      "workflow.post-task-verification",
      "Post-task verification"
    )
  ) {
    return null;
  }

  const commands = postTaskVerificationCommands(analysis).slice(0, 8);

  if (commands.length === 0) {
    return null;
  }

  const appliesTo = uniqueSorted(
    commands.flatMap((command) => command.evidence.map((evidence) => evidence.id))
  );

  return {
    op: "create_object",
    id: "workflow.post-task-verification",
    type: "workflow",
    title: "Post-task verification",
    body: [
      "# Post-task verification",
      "",
      "After meaningful code changes, prefer these repo verification commands when relevant:",
      ...commands.map((command) => `- \`${command.command}\`: ${command.description}`),
      ""
    ].join("\n"),
    tags: ["verification", "testing", "workflow"],
    facets: {
      category: "testing",
      applies_to: appliesTo,
      load_modes: ["coding", "debugging", "review"]
    },
    evidence: appliesTo.map((path) => ({ kind: "file", id: path }))
  };
}

function postTaskVerificationCommands(analysis: BootstrapAnalysis): VerificationCommandInfo[] {
  const commands: VerificationCommandInfo[] = [];
  const scripts = analysis.packageJson?.scripts ?? {};
  const manager = analysis.packageManager?.manager ?? "npm";
  const scriptNames = Object.keys(scripts)
    .filter((name) => isPostTaskScriptName(name))
    .sort(comparePostTaskScriptNames);

  for (const name of scriptNames) {
    const script = scripts[name];

    if (script === undefined) {
      continue;
    }

    commands.push({
      command: packageScriptCommand(manager, name),
      description: `package.json script \`${name}\`: \`${script}\``,
      evidence: [{ kind: "file", id: "package.json" }]
    });
  }

  for (const guidance of analysis.agentGuidance) {
    commands.push(...guidance.verificationCommands);
  }

  return uniqueVerificationCommands(commands);
}

function isPostTaskScriptName(name: string): boolean {
  return POST_TASK_SCRIPT_NAMES.has(name) || /^(?:test|lint|typecheck|check)(?::|$)/u.test(name);
}

function comparePostTaskScriptNames(left: string, right: string): number {
  const leftPriority = postTaskScriptPriority(left);
  const rightPriority = postTaskScriptPriority(right);

  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }

  return left.localeCompare(right);
}

function postTaskScriptPriority(name: string): number {
  const directIndex = POST_TASK_SCRIPT_PRIORITY.indexOf(
    name as (typeof POST_TASK_SCRIPT_PRIORITY)[number]
  );

  if (directIndex !== -1) {
    return directIndex;
  }

  if (name.startsWith("typecheck")) {
    return 0;
  }

  if (name.startsWith("lint")) {
    return 1;
  }

  if (name.startsWith("check")) {
    return 2;
  }

  if (name.startsWith("test")) {
    return 3;
  }

  return POST_TASK_SCRIPT_PRIORITY.length;
}

function packageScriptCommand(manager: string, name: string): string {
  return `${manager} run ${name}`;
}

function uniqueVerificationCommands(
  commands: readonly VerificationCommandInfo[]
): VerificationCommandInfo[] {
  const seen = new Set<string>();
  const unique: VerificationCommandInfo[] = [];

  for (const command of commands) {
    const normalized = command.command.toLowerCase();

    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    unique.push(command);
  }

  return unique;
}

function codeConventionsConstraint(
  storage: CanonicalStorageSnapshot,
  analysis: BootstrapAnalysis
): BootstrapPatchChange | null {
  if (
    hasSimilarObject(storage, "constraint", "constraint.code-conventions", "Code conventions")
  ) {
    return null;
  }

  const statements = uniqueSorted(
    analysis.agentGuidance.flatMap((guidance) => guidance.conventionStatements)
  ).slice(0, 8);

  if (statements.length === 0) {
    return null;
  }

  const appliesTo = analysis.agentGuidance
    .filter((guidance) => guidance.conventionStatements.length > 0)
    .map((guidance) => guidance.path)
    .sort();

  return {
    op: "create_object",
    id: "constraint.code-conventions",
    type: "constraint",
    title: "Code conventions",
    body: [
      "# Code conventions",
      "",
      "Follow these explicit repo instructions from agent guidance files:",
      ...statements.map((statement) => `- ${statement}`),
      ""
    ].join("\n"),
    tags: ["convention", "code-style", "agents"],
    facets: {
      category: "convention",
      applies_to: appliesTo,
      load_modes: ["coding", "review"]
    },
    evidence: appliesTo.map((path) => ({ kind: "file", id: path }))
  };
}

function nodeEngineConstraint(
  storage: CanonicalStorageSnapshot,
  analysis: BootstrapAnalysis
): BootstrapPatchChange | null {
  const nodeEngine = analysis.packageJson?.nodeEngine;

  if (
    nodeEngine === undefined ||
    nodeEngine === null ||
    nodeEngine === "" ||
    hasSimilarObject(storage, "constraint", "constraint.node-engine", "Node engine requirement")
  ) {
    return null;
  }

  return {
    op: "create_object",
    id: "constraint.node-engine",
    type: "constraint",
    title: "Node engine requirement",
    body: [
      "# Node engine requirement",
      "",
      `The package declares Node.js \`${nodeEngine}\` in \`package.json\` engines.`,
      ""
    ].join("\n"),
    tags: ["node", "runtime"],
    facets: {
      category: "stack",
      applies_to: ["package.json"],
      load_modes: ["coding", "debugging", "onboarding"]
    },
    evidence: [{ kind: "file", id: "package.json" }]
  };
}

function packageManagerConstraint(
  storage: CanonicalStorageSnapshot,
  analysis: BootstrapAnalysis
): BootstrapPatchChange | null {
  const packageManager = analysis.packageManager;

  if (
    packageManager === null ||
    hasSimilarObject(storage, "constraint", "constraint.package-manager", "Package manager")
  ) {
    return null;
  }

  return {
    op: "create_object",
    id: "constraint.package-manager",
    type: "constraint",
    title: "Package manager",
    body: [
      "# Package manager",
      "",
      packageManager.spec === null
        ? `Use ${packageManager.manager} for dependency workflows; this is inferred from \`${packageManager.source}\`.`
        : `Use \`${packageManager.spec}\` for dependency workflows; this is declared in \`${packageManager.source}\`.`,
      ""
    ].join("\n"),
    tags: [packageManager.manager, "dependencies"],
    facets: {
      category: "stack",
      applies_to: [packageManager.source],
      load_modes: ["coding", "debugging", "onboarding"]
    },
    evidence: [{ kind: "file", id: packageManager.source }]
  };
}

function productFeatureConcepts(
  storage: CanonicalStorageSnapshot,
  analysis: BootstrapAnalysis
): BootstrapPatchChange[] {
  const features = analysis.productFeatures;

  if (features.length === 0) {
    return [];
  }

  const existingIds = new Set(storage.objects.map((object) => object.sidecar.id));
  const existingRelationIds = new Set(storage.relations.map((relation) => relation.relation.id));
  const projectObject = objectById(storage, storage.config.project.id);
  const changes: BootstrapPatchChange[] = [];

  for (const feature of features.slice(0, BOOTSTRAP_PRODUCT_FEATURE_LIMIT)) {
    const title = `Feature: ${feature.title}`;
    const baseId = generateObjectId({
      type: "concept",
      title
    });
    const existingFeature = similarObject(storage, "concept", baseId, title);
    const featureId =
      existingFeature?.sidecar.id ??
      generateObjectId({
        type: "concept",
        title,
        existingIds
      });

    if (existingFeature === undefined) {
      existingIds.add(featureId);

      changes.push({
        op: "create_object",
        id: featureId,
        type: "concept",
        title,
        body: [`# ${title}`, "", feature.description, ""].join("\n"),
        tags: feature.tags,
        facets: {
          category: "product-feature",
          applies_to: feature.appliesTo,
          load_modes: ["coding", "onboarding"]
        },
        evidence: feature.evidence
      });
    }

    if (
      projectObject === null ||
      hasEquivalentRelation(
        storage,
        projectObject.sidecar.id,
        PROJECT_FEATURE_PREDICATE,
        featureId
      )
    ) {
      continue;
    }

    const relationId = generateRelationId({
      from: projectObject.sidecar.id,
      predicate: PROJECT_FEATURE_PREDICATE,
      to: featureId,
      existingIds: existingRelationIds
    });
    existingRelationIds.add(relationId);

    changes.push({
      op: "create_relation",
      id: relationId,
      from: projectObject.sidecar.id,
      predicate: PROJECT_FEATURE_PREDICATE,
      to: featureId,
      status: "active",
      confidence: "high",
      evidence: feature.evidence
    });
  }

  return changes;
}

function hasProductFeatureBootstrapSignal(analysis: BootstrapAnalysis): boolean {
  return (
    analysis.productFeatures.length > 0 ||
    [...analysis.files].some((file) =>
      routeProductFeature(file) !== null ||
      /(?:^src\/cli\/commands\/.*\.ts$|^src\/cli\/main\.ts$)/u.test(file)
    )
  );
}

function bootstrapRecommendedFacets(analysis: BootstrapAnalysis): FacetCategory[] {
  const facets: FacetCategory[] = [];

  if (hasProductFeatureBootstrapSignal(analysis)) {
    facets.push("product-feature");
  }

  if (postTaskVerificationCommands(analysis).length > 0) {
    facets.push("testing");
  }

  if (analysis.agentGuidance.some((guidance) => guidance.conventionStatements.length > 0)) {
    facets.push("convention");
  }

  return facets;
}

async function readReadme(projectRoot: string): Promise<ReadmeInfo | null> {
  const contents = await readUtf8IfExists(projectRoot, "README.md");

  if (contents === null) {
    return null;
  }

  const lines = contents.split(/\r\n|\n|\r/u);
  const title = lines
    .map((line) => /^#\s+(.+?)\s*$/u.exec(line)?.[1]?.trim() ?? null)
    .find((value): value is string => value !== null && value !== "");
  const summary = firstReadmeParagraph(lines);

  return {
    title: title ?? null,
    summary,
    features: markdownProductFeatures(lines, "README.md")
  };
}

async function readAgentGuidance(projectRoot: string): Promise<AgentGuidanceInfo[]> {
  const guidance: AgentGuidanceInfo[] = [];

  for (const path of AGENT_GUIDANCE_FILES) {
    const raw = await readUtf8IfExists(projectRoot, path);

    if (raw === null) {
      continue;
    }

    const contents = stripMemoryMemoryBlocks(raw);
    const conventionStatements = extractConventionStatements(contents);
    const verificationCommands = extractVerificationCommands(contents, path);

    if (conventionStatements.length === 0 && verificationCommands.length === 0) {
      continue;
    }

    guidance.push({
      path,
      conventionStatements,
      verificationCommands
    });
  }

  return guidance;
}

function stripMemoryMemoryBlocks(contents: string): string {
  let remaining = contents;

  for (;;) {
    const start = remaining.indexOf(MEMORY_MEMORY_START_MARKER);

    if (start === -1) {
      return remaining;
    }

    const end = remaining.indexOf(MEMORY_MEMORY_END_MARKER, start);

    if (end === -1) {
      return remaining.slice(0, start);
    }

    remaining = `${remaining.slice(0, start)}${remaining.slice(
      end + MEMORY_MEMORY_END_MARKER.length
    )}`;
  }
}

function extractConventionStatements(contents: string): string[] {
  const statements: string[] = [];
  let inFence = false;
  let inConventionSection = false;

  for (const line of contents.split(/\r\n|\n|\r/u)) {
    const trimmed = line.trim();

    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }

    if (inFence || trimmed === "") {
      continue;
    }

    const heading = /^#{1,6}\s+(.+?)\s*$/u.exec(trimmed);

    if (heading !== null) {
      inConventionSection = isConventionHeading(heading[1] ?? "");
      continue;
    }

    const bullet = /^(?:[-*+]\s+|\d+\.\s+)(.+?)\s*$/u.exec(trimmed);
    const candidate = cleanMarkdownText((bullet?.[1] ?? trimmed).replace(/^\[[ xX]\]\s+/u, ""));

    if (
      candidate === "" ||
      containsVerificationCommand(candidate) ||
      (!inConventionSection && !isStrongConventionStatement(candidate))
    ) {
      continue;
    }

    statements.push(truncateSentence(candidate, 180));

    if (statements.length >= 12) {
      break;
    }
  }

  return uniqueSorted(statements);
}

function isConventionHeading(value: string): boolean {
  return /\b(?:code\s+)?(?:conventions?|style|standards?|guidelines?|instructions?)\b/iu.test(
    cleanMarkdownText(value)
  );
}

function isStrongConventionStatement(value: string): boolean {
  return (
    /\b(?:prefer|use|avoid|do not|don't|never|must|should|keep|write|default to)\b/iu.test(
      value
    ) &&
    /\b(?:code|TypeScript|JavaScript|tests?|lint|format|style|components?|files?|imports?|errors?|comments?|ASCII|schema|API)\b/iu.test(
      value
    )
  );
}

function extractVerificationCommands(
  contents: string,
  path: string
): VerificationCommandInfo[] {
  const commands: VerificationCommandInfo[] = [];
  let inFence = false;

  for (const line of contents.split(/\r\n|\n|\r/u)) {
    const trimmed = line.trim();

    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }

    const candidates = [
      ...[...trimmed.matchAll(/`([^`]+)`/gu)].map((match) => match[1] ?? ""),
      ...(inFence ? [trimmed] : [])
    ];

    for (const candidate of candidates.flatMap(splitShellCommands)) {
      const command = cleanCommand(candidate);

      if (command === "" || !isVerificationCommand(command)) {
        continue;
      }

      commands.push({
        command,
        description: `explicitly documented in \`${path}\``,
        evidence: [{ kind: "file", id: path }]
      });
    }
  }

  return uniqueVerificationCommands(commands);
}

function splitShellCommands(value: string): string[] {
  return value
    .split(/\s+(?:&&|\|\|)\s+/u)
    .map((command) => command.trim())
    .filter((command) => command !== "");
}

function cleanCommand(value: string): string {
  return value
    .replace(/^\$\s*/u, "")
    .replace(/^[#>-]\s*/u, "")
    .replace(/[.;,]\s*$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function isVerificationCommand(value: string): boolean {
  return /^(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:typecheck|lint|test|check|build)(?::[a-z0-9:_-]+)?\b|(?:tsc|svelte-check|vitest|eslint|biome|prettier)\b)/iu.test(
    value
  );
}

function containsVerificationCommand(value: string): boolean {
  return /(?:^|\b)(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:typecheck|lint|test|check|build)(?::[a-z0-9:_-]+)?\b|(?:tsc|svelte-check|vitest|eslint|biome|prettier)\b)/iu.test(
    value
  );
}

function markdownProductFeatures(
  lines: readonly string[],
  relativePath: string
): ProductFeatureInfo[] {
  const features: ProductFeatureInfo[] = [];
  let inFence = false;
  let inFeatureSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }

    if (inFence) {
      continue;
    }

    const heading = /^#{1,6}\s+(.+?)\s*$/u.exec(trimmed);

    if (heading !== null) {
      inFeatureSection = isProductFeatureHeading(heading[1] ?? "");
      continue;
    }

    if (!inFeatureSection) {
      continue;
    }

    const bullet = /^(?:[-*+]\s+|\d+\.\s+)(.+?)\s*$/u.exec(trimmed);

    if (bullet === null) {
      continue;
    }

    const description = cleanMarkdownText((bullet[1] ?? "").replace(/^\[[ xX]\]\s+/u, ""));

    if (description === "") {
      continue;
    }

    const title = featureTitle(description);
    features.push({
      title,
      description,
      evidence: [{ kind: "file", id: relativePath }],
      appliesTo: [relativePath],
      tags: productFeatureTags(title)
    });

    if (features.length >= BOOTSTRAP_PRODUCT_FEATURE_LIMIT) {
      return features;
    }
  }

  return features;
}

function isProductFeatureHeading(value: string): boolean {
  return /\b(features?|capabilit(?:y|ies)|functionality|what it does)\b/iu.test(
    cleanMarkdownText(value)
  );
}

function featureTitle(description: string): string {
  const splitTitle = /^(.{1,80}?)(?::\s+| - | -- )/u.exec(description)?.[1]?.trim();
  const title = splitTitle === undefined ? truncateSentence(description, 80) : splitTitle;

  return title.replace(/[.:;,\s]+$/u, "");
}

function productFeatureTags(title: string): string[] {
  return uniqueSorted(["feature", "product", ...[...tokenize(title)].slice(0, 4)]);
}

async function documentedProductFeatures(
  projectRoot: string,
  changedFiles: readonly string[]
): Promise<ProductFeatureInfo[]> {
  const features: ProductFeatureInfo[] = [];
  const docs = changedFiles
    .filter((file) => file.startsWith("docs/") && /\.mdx?$/u.test(file))
    .slice(0, BOOTSTRAP_DOC_FEATURE_FILE_LIMIT);

  for (const file of docs) {
    const contents = await readUtf8IfExists(projectRoot, file);

    if (contents === null) {
      continue;
    }

    features.push(...markdownProductFeatures(contents.split(/\r\n|\n|\r/u), file));

    if (features.length >= BOOTSTRAP_PRODUCT_FEATURE_LIMIT) {
      return features.slice(0, BOOTSTRAP_PRODUCT_FEATURE_LIMIT);
    }
  }

  return features;
}

async function codeProductFeatures(
  projectRoot: string,
  changedFiles: readonly string[],
  packageJson: PackageJsonInfo | null
): Promise<ProductFeatureInfo[]> {
  const features: ProductFeatureInfo[] = [
    ...packageBinProductFeatures(packageJson),
    ...(await cliCommandProductFeatures(projectRoot, changedFiles)),
    ...routeProductFeatures(changedFiles)
  ];

  return features.slice(0, BOOTSTRAP_PRODUCT_FEATURE_LIMIT);
}

function packageBinProductFeatures(packageJson: PackageJsonInfo | null): ProductFeatureInfo[] {
  if (packageJson === null) {
    return [];
  }

  return Object.entries(packageJson.bin)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, target]) => ({
      title: `CLI binary ${name}`,
      description: `The \`${name}\` executable is published by \`package.json\` and points to \`${target}\`.`,
      evidence: [{ kind: "file", id: "package.json" }],
      appliesTo: ["package.json"],
      tags: productFeatureTags(`CLI binary ${name}`)
    }));
}

async function cliCommandProductFeatures(
  projectRoot: string,
  changedFiles: readonly string[]
): Promise<ProductFeatureInfo[]> {
  const features: ProductFeatureInfo[] = [];
  const commandFiles = changedFiles.filter((file) =>
    /(?:^src\/cli\/commands\/.*\.ts$|^src\/cli\/main\.ts$)/u.test(file)
  );

  for (const file of commandFiles) {
    const contents = await readUtf8IfExists(projectRoot, file);

    if (contents === null) {
      continue;
    }

    for (const command of extractCliCommandDescriptions(contents)) {
      features.push({
        title: `CLI command ${command.name}`,
        description: `The \`${command.name}\` CLI command ${lowercaseFirst(
          ensureTerminalPeriod(command.description)
        )}`,
        evidence: [{ kind: "file", id: file }],
        appliesTo: [file],
        tags: productFeatureTags(`CLI command ${command.name}`)
      });

      if (features.length >= BOOTSTRAP_PRODUCT_FEATURE_LIMIT) {
        return features;
      }
    }
  }

  return features;
}

function extractCliCommandDescriptions(
  contents: string
): Array<{ name: string; description: string }> {
  const descriptions: Array<{ name: string; description: string }> = [];
  const commandPattern =
    /\.command\(\s*["`]([^"`]+?)["`]\s*\)[\s\S]{0,320}?\.description\(\s*["`]([^"`]+?)["`]\s*\)/gu;

  for (const match of contents.matchAll(commandPattern)) {
    const rawName = match[1]?.trim() ?? "";
    const description = cleanMarkdownText(match[2] ?? "");
    const name = rawName.split(/\s+/u)[0]?.trim();

    if (name === undefined || name === "" || description === "") {
      continue;
    }

    descriptions.push({ name, description });
  }

  return descriptions;
}

function routeProductFeatures(changedFiles: readonly string[]): ProductFeatureInfo[] {
  return changedFiles
    .map(routeProductFeature)
    .filter((feature): feature is ProductFeatureInfo => feature !== null);
}

function routeProductFeature(file: string): ProductFeatureInfo | null {
  const route = routePath(file);

  if (route === null) {
    return null;
  }

  return {
    title: `Route ${route}`,
    description: `The \`${route}\` route surface is implemented by \`${file}\`.`,
    evidence: [{ kind: "file", id: file }],
    appliesTo: [file],
    tags: productFeatureTags(`Route ${route}`)
  };
}

function routePath(file: string): string | null {
  const appMatch = /^app\/(.+?)\/page\.(?:tsx?|jsx?|svelte)$/u.exec(file);

  if (appMatch !== null) {
    return normalizeRoutePath(appMatch[1] ?? "");
  }

  if (/^app\/page\.(?:tsx?|jsx?|svelte)$/u.test(file)) {
    return "/";
  }

  const pagesMatch = /^pages\/(.+?)\.(?:tsx?|jsx?|svelte)$/u.exec(file);

  if (pagesMatch !== null) {
    return normalizeRoutePath(pagesMatch[1] ?? "");
  }

  const svelteKitMatch = /^src\/routes\/(.+?)\/\+page\.svelte$/u.exec(file);

  if (svelteKitMatch !== null) {
    return normalizeRoutePath(svelteKitMatch[1] ?? "");
  }

  if (file === "src/routes/+page.svelte" || file === "routes/+page.svelte") {
    return "/";
  }

  const topLevelSvelteKitMatch = /^routes\/(.+?)\/\+page\.svelte$/u.exec(file);

  if (topLevelSvelteKitMatch !== null) {
    return normalizeRoutePath(topLevelSvelteKitMatch[1] ?? "");
  }

  const routesMatch = /^routes\/(.+?)\.(?:tsx?|jsx?|svelte)$/u.exec(file);

  if (routesMatch !== null) {
    return normalizeRoutePath(routesMatch[1] ?? "");
  }

  return null;
}

function normalizeRoutePath(value: string): string {
  const withoutIndex = value.replace(/(?:^|\/)index$/u, "");
  const segments = withoutIndex
    .split("/")
    .filter((segment) => segment !== "" && !/^\(.+\)$/u.test(segment));

  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function uniqueProductFeatures(features: readonly ProductFeatureInfo[]): ProductFeatureInfo[] {
  const seen = new Set<string>();
  const unique: ProductFeatureInfo[] = [];

  for (const feature of features) {
    const key = feature.title.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(feature);

    if (unique.length >= BOOTSTRAP_PRODUCT_FEATURE_LIMIT) {
      return unique;
    }
  }

  return unique;
}

async function readPackageJson(projectRoot: string): Promise<PackageJsonInfo | null> {
  const contents = await readUtf8IfExists(projectRoot, "package.json");

  if (contents === null) {
    return null;
  }

  try {
    return packageJsonInfo(JSON.parse(contents) as unknown);
  } catch {
    return null;
  }
}

function packageJsonInfo(value: unknown): PackageJsonInfo | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    name: stringProperty(value, "name"),
    description: stringProperty(value, "description"),
    type: stringProperty(value, "type"),
    packageManager: stringProperty(value, "packageManager"),
    nodeEngine: engineValue(value, "node"),
    scripts: stringRecordProperty(value, "scripts"),
    bin: binRecordProperty(value),
    dependencies: dependencySet(value, "dependencies"),
    devDependencies: dependencySet(value, "devDependencies")
  };
}

async function detectPackageManager(
  projectRoot: string,
  packageJson: PackageJsonInfo | null
): Promise<PackageManagerInfo | null> {
  if (packageJson?.packageManager !== null && packageJson?.packageManager !== undefined) {
    const manager = packageJson.packageManager.split("@")[0]?.trim();

    if (manager !== undefined && PACKAGE_MANAGERS.has(manager)) {
      return {
        manager,
        source: "package.json",
        spec: packageJson.packageManager
      };
    }
  }

  const presentLocks = [];

  for (const lock of LOCK_FILE_MANAGERS) {
    if (await fileExists(projectRoot, lock.file)) {
      presentLocks.push(lock);
    }
  }

  const lockManagers = new Set(presentLocks.map((lock) => lock.manager));

  if (lockManagers.size === 1 && presentLocks[0] !== undefined) {
    return {
      manager: presentLocks[0].manager,
      source: presentLocks[0].file,
      spec: null
    };
  }

  if (presentLocks.length === 0 && (await fileExists(projectRoot, "pnpm-workspace.yaml"))) {
    return {
      manager: "pnpm",
      source: "pnpm-workspace.yaml",
      spec: null
    };
  }

  return null;
}

function firstReadmeParagraph(lines: readonly string[]): string | null {
  let inFence = false;
  let afterTitle = false;
  const paragraph: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }

    if (inFence) {
      continue;
    }

    if (/^#\s+/u.test(trimmed)) {
      afterTitle = true;
      continue;
    }

    if (!afterTitle || trimmed === "") {
      if (paragraph.length > 0) {
        break;
      }
      continue;
    }

    if (/^(#{2,6}\s+|[-*]\s+|\d+\.\s+|>|!\[)/u.test(trimmed)) {
      if (paragraph.length > 0) {
        break;
      }
      continue;
    }

    paragraph.push(trimmed);
  }

  const summary = cleanMarkdownText(paragraph.join(" "));
  return summary === "" ? null : truncateSentence(summary, 240);
}

function cleanMarkdownText(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/[`*_]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function truncateSentence(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1).trimEnd()}.`;
}

function ensureTerminalPeriod(value: string): string {
  return /[.!?]$/u.test(value) ? value : `${value}.`;
}

function lowercaseFirst(value: string): string {
  const first = value[0];

  if (first === undefined) {
    return value;
  }

  return `${first.toLowerCase()}${value.slice(1)}`;
}

async function readUtf8IfExists(projectRoot: string, relativePath: string): Promise<string | null> {
  try {
    return await readFile(join(projectRoot, relativePath), "utf8");
  } catch {
    return null;
  }
}

async function fileExists(projectRoot: string, relativePath: string): Promise<boolean> {
  try {
    await access(join(projectRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}

function objectById(storage: CanonicalStorageSnapshot, id: ObjectId): StoredMemoryObject | null {
  return storage.objects.find((object) => object.sidecar.id === id) ?? null;
}

function isInitialProjectPlaceholder(object: StoredMemoryObject): boolean {
  return (
    object.sidecar.type === "project" &&
    object.sidecar.source?.kind === "system" &&
    /^# .+\n\nProject-level memory for .+\.\n?$/u.test(object.body)
  );
}

function isInitialArchitecturePlaceholder(object: StoredMemoryObject): boolean {
  return (
    object.sidecar.type === "architecture" &&
    object.sidecar.source?.kind === "system" &&
    object.body === "# Current Architecture\n\nArchitecture memory starts here.\n"
  );
}

function hasSimilarObject(
  storage: CanonicalStorageSnapshot,
  type: ObjectType,
  id: ObjectId,
  title: string
): boolean {
  return similarObject(storage, type, id, title) !== undefined;
}

function similarObject(
  storage: CanonicalStorageSnapshot,
  type: ObjectType,
  id: ObjectId,
  title: string
): StoredMemoryObject | undefined {
  const normalizedTitle = title.toLowerCase();

  return storage.objects.find(
    (object) =>
      object.sidecar.type === type &&
      (object.sidecar.id === id || object.sidecar.title.toLowerCase() === normalizedTitle)
  );
}

function mergeTags(existing: readonly string[] | undefined, additions: readonly string[]): string[] {
  return uniqueSorted([...(existing ?? []), ...additions]);
}

function hasAnyPrefix(files: Set<string>, prefixes: readonly string[]): boolean {
  for (const file of files) {
    if (prefixes.some((prefix) => file.startsWith(prefix))) {
      return true;
    }
  }

  return false;
}

function hasTypeScriptSignal(files: Set<string>): boolean {
  for (const file of files) {
    if (/^tsconfig.*\.json$/u.test(file)) {
      return true;
    }
  }

  return false;
}

function hasConfig(files: Set<string>, name: "next" | "svelte" | "vite"): boolean {
  for (const file of files) {
    if (new RegExp(`^${name}\\.config\\.`, "u").test(file)) {
      return true;
    }
  }

  return false;
}

function hasVitestSignal(
  files: Set<string>,
  packageJson: PackageJsonInfo | null
): boolean {
  for (const file of files) {
    if (/^vitest\.config\./u.test(file)) {
      return true;
    }
  }

  return (
    packageJson?.dependencies.has("vitest") === true ||
    packageJson?.devDependencies.has("vitest") === true ||
    Object.values(packageJson?.scripts ?? {}).some((script) => /\bvitest\b/u.test(script))
  );
}

function stringProperty(value: Record<string, unknown>, key: string): string | null {
  const property = value[key];
  return typeof property === "string" && property.trim() !== "" ? property.trim() : null;
}

function engineValue(value: Record<string, unknown>, key: string): string | null {
  const engines = value.engines;

  if (!isRecord(engines)) {
    return null;
  }

  return stringProperty(engines, key);
}

function stringRecordProperty(value: Record<string, unknown>, key: string): Record<string, string> {
  const property = value[key];

  if (!isRecord(property)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(property).filter(
      (entry): entry is [string, string] =>
        typeof entry[0] === "string" && typeof entry[1] === "string"
    )
  );
}

function binRecordProperty(value: Record<string, unknown>): Record<string, string> {
  const property = value.bin;

  if (typeof property === "string") {
    const name = stringProperty(value, "name");
    return name === null ? {} : { [name]: property };
  }

  if (!isRecord(property)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(property).filter(
      (entry): entry is [string, string] =>
        typeof entry[0] === "string" && typeof entry[1] === "string"
    )
  );
}

function dependencySet(value: Record<string, unknown>, key: string): Set<string> {
  const property = value[key];

  if (!isRecord(property)) {
    return new Set();
  }

  return new Set(Object.keys(property));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function relatedMemoryIds(
  storage: CanonicalStorageSnapshot,
  changedFiles: readonly string[]
): ObjectId[] {
  const ids = new Set<ObjectId>();

  for (const object of storage.objects) {
    if (objectMatchesFiles(object, changedFiles)) {
      ids.add(object.sidecar.id);
    }
  }

  for (const relation of storage.relations) {
    if (relationHasFileEvidence(relation, changedFiles)) {
      ids.add(relation.relation.from);
      ids.add(relation.relation.to);
    }
  }

  return [...ids].sort();
}

function recommendedFileEvidence(changedFiles: readonly string[]): Evidence[] {
  return uniqueSorted(changedFiles)
    .filter((file) => !file.startsWith(".memory/"))
    .slice(0, 12)
    .map((file) => ({ kind: "file", id: file }));
}

function recommendedRelations(
  storage: CanonicalStorageSnapshot,
  changedFiles: readonly string[]
): SuggestedRelation[] {
  const related = storage.objects
    .filter((object) => ["active", "open"].includes(object.sidecar.status))
    .filter((object) => objectMatchesFiles(object, changedFiles))
    .sort(compareObjectsById);
  const suggestions: SuggestedRelation[] = [];

  for (const [index, left] of related.entries()) {
    for (const right of related.slice(index + 1)) {
      if (hasAnyRelation(storage, left.sidecar.id, right.sidecar.id)) {
        continue;
      }

      const suggested = relationSuggestion(left, right);

      if (suggested !== null) {
        suggestions.push(suggested);
      }

      if (suggestions.length >= 8) {
        return suggestions;
      }
    }
  }

  return suggestions;
}

function relationSuggestion(
  left: StoredMemoryObject,
  right: StoredMemoryObject
): SuggestedRelation | null {
  const ordered = orderRelationEndpoints(left, right);

  if (ordered === null) {
    return null;
  }

  return {
    from: ordered.from.sidecar.id,
    predicate: ordered.predicate,
    to: ordered.to.sidecar.id,
    reason: "Related memory overlaps changed files but has no direct relation."
  };
}

function orderRelationEndpoints(
  left: StoredMemoryObject,
  right: StoredMemoryObject
): { from: StoredMemoryObject; predicate: Predicate; to: StoredMemoryObject } | null {
  if (left.sidecar.type === "decision" && right.sidecar.type === "constraint") {
    return { from: left, predicate: "requires", to: right };
  }

  if (right.sidecar.type === "decision" && left.sidecar.type === "constraint") {
    return { from: right, predicate: "requires", to: left };
  }

  if (left.sidecar.type === "gotcha") {
    return { from: left, predicate: "affects", to: right };
  }

  if (right.sidecar.type === "gotcha") {
    return { from: right, predicate: "affects", to: left };
  }

  if (left.sidecar.type === "architecture") {
    return { from: left, predicate: "mentions", to: right };
  }

  if (right.sidecar.type === "architecture") {
    return { from: right, predicate: "mentions", to: left };
  }

  return { from: left, predicate: "mentions", to: right };
}

function hasAnyRelation(
  storage: CanonicalStorageSnapshot,
  left: ObjectId,
  right: ObjectId
): boolean {
  return storage.relations.some(
    (relation) =>
      relation.relation.status === "active" &&
      ((relation.relation.from === left && relation.relation.to === right) ||
        (relation.relation.from === right && relation.relation.to === left))
  );
}

function possibleStaleIds(
  storage: CanonicalStorageSnapshot,
  changedFiles: readonly string[]
): ObjectId[] {
  return storage.objects
    .filter((object) => STALE_CANDIDATE_STATUSES.has(object.sidecar.status))
    .filter((object) => objectMatchesFiles(object, changedFiles))
    .map((object) => object.sidecar.id)
    .sort();
}

function repairCandidatesForAfterTask(options: {
  storage: CanonicalStorageSnapshot;
  changedFiles: readonly string[];
  auditFindings: readonly AuditFinding[];
  gitFileChanges: readonly ProjectFileChange[];
}): MemoryRepairCandidate[] {
  const candidates = new Map<string, MemoryRepairCandidate>();

  for (const finding of options.auditFindings) {
    const candidate = repairCandidateForAuditFinding(finding, options.storage);

    if (candidate === null) {
      continue;
    }

    candidates.set(repairCandidateKey(candidate), candidate);
  }

  for (const candidate of repairCandidatesForRecentFileHistory(
    options.storage,
    options.gitFileChanges
  )) {
    candidates.set(repairCandidateKey(candidate), candidate);
  }

  return [...candidates.values()].sort(compareRepairCandidates).slice(0, 12);
}

function repairCandidateForAuditFinding(
  finding: AuditFinding,
  storage: CanonicalStorageSnapshot
): MemoryRepairCandidate | null {
  if (!isCurrentMemoryId(storage, finding.memory_id)) {
    return null;
  }

  switch (finding.rule) {
    case "possibly_stale_changed_reference":
      return {
        target_id: finding.memory_id,
        rule: finding.rule,
        confidence: "medium",
        suggested_action: "update_existing",
        reason: "Audit found referenced files with repeated changes after this memory was last updated.",
        evidence: [...finding.evidence]
      };
    case "source_origin_outdated":
      return {
        target_id: finding.memory_id,
        rule: finding.rule,
        confidence: "high",
        suggested_action: "update_existing",
        reason: "Audit found source origin evidence that is missing or no longer matches the current file.",
        evidence: [...finding.evidence]
      };
    case "referenced_file_missing":
      return {
        target_id: finding.memory_id,
        rule: finding.rule,
        confidence: "high",
        suggested_action: "update_existing",
        reason: "Audit found file references that no longer exist in the working tree.",
        evidence: [...finding.evidence]
      };
    case "active_conflict_needs_resolution":
      return {
        target_id: finding.memory_id,
        rule: finding.rule,
        confidence: "high",
        suggested_action: "create_memory",
        reason:
          "Audit found an active conflict relation without evidence or a linked unresolved-conflict question.",
        evidence: [...finding.evidence]
      };
    case "supersession_chain_needs_review":
      return {
        target_id: finding.memory_id,
        rule: finding.rule,
        confidence: "medium",
        suggested_action: "supersede_existing",
        reason: "Audit found a supersession chain that should be reviewed or collapsed.",
        evidence: [...finding.evidence]
      };
    case "missing_object_evidence":
    case "missing_evidence":
    case "synthesis_missing_source_provenance":
      return {
        target_id: finding.memory_id,
        rule: finding.rule,
        confidence: "medium",
        suggested_action: "update_existing",
        reason: "Audit found weak provenance that can usually be repaired by updating evidence or relations.",
        evidence: [...finding.evidence]
      };
    default:
      return null;
  }
}

function repairCandidatesForRecentFileHistory(
  storage: CanonicalStorageSnapshot,
  gitFileChanges: readonly ProjectFileChange[]
): MemoryRepairCandidate[] {
  const candidates: MemoryRepairCandidate[] = [];
  const changesByFile = new Map<string, ProjectFileChange[]>();

  for (const change of gitFileChanges) {
    changesByFile.set(change.file, [...(changesByFile.get(change.file) ?? []), change]);
  }

  for (const object of storage.objects
    .filter((item) => STALE_CANDIDATE_STATUSES.has(item.sidecar.status))
    .sort(compareObjectsById)) {
    const updatedAt = timestampMillis(object.sidecar.updated_at);

    if (updatedAt === null) {
      continue;
    }

    for (const [file, changes] of [...changesByFile.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      if (!objectMatchesFiles(object, [file])) {
        continue;
      }

      const commits = uniqueSorted(
        changes
          .filter((change) => {
            const changedAt = timestampMillis(change.timestamp);

            return changedAt !== null && changedAt > updatedAt;
          })
          .map((change) => change.commit)
      );

      if (commits.length < 2) {
        continue;
      }

      candidates.push({
        target_id: object.sidecar.id,
        rule: "possibly_stale_changed_reference",
        confidence: "medium",
        suggested_action: "update_existing",
        reason: "Recent Git history changed files related to this memory multiple times after it was last updated.",
        evidence: [
          { kind: "file", id: file },
          ...commits.slice(0, 4).map((commit) => ({ kind: "commit", id: commit }) satisfies Evidence)
        ]
      });
      break;
    }
  }

  return candidates;
}

function candidateSuggestsStale(candidate: MemoryRepairCandidate): boolean {
  return new Set<SuggestedMemoryActionType>([
    "update_existing",
    "mark_stale",
    "supersede_existing"
  ]).has(candidate.suggested_action);
}

function isCurrentMemoryId(
  storage: CanonicalStorageSnapshot,
  id: ObjectId
): boolean {
  return storage.objects.some(
    (object) => object.sidecar.id === id && STALE_CANDIDATE_STATUSES.has(object.sidecar.status)
  );
}

function repairCandidateKey(candidate: MemoryRepairCandidate): string {
  return `${candidate.target_id}\u001f${candidate.rule}\u001f${candidate.suggested_action}`;
}

function compareRepairCandidates(
  left: MemoryRepairCandidate,
  right: MemoryRepairCandidate
): number {
  return (
    repairConfidenceRank(right.confidence) - repairConfidenceRank(left.confidence) ||
    left.target_id.localeCompare(right.target_id) ||
    left.rule.localeCompare(right.rule) ||
    left.suggested_action.localeCompare(right.suggested_action)
  );
}

function repairConfidenceRank(confidence: RelationConfidence): number {
  switch (confidence) {
    case "high":
      return 2;
    case "medium":
      return 1;
    case "low":
      return 0;
  }
}

function objectMatchesFiles(
  object: StoredMemoryObject,
  changedFiles: readonly string[]
): boolean {
  if (changedFiles.length === 0) {
    return false;
  }

  const text = objectSearchText(object);
  const objectTokens = tokenize(text);

  return changedFiles.some((file) => {
    const normalizedFile = normalizeForSearch(file);

    if (
      text.includes(normalizedFile) ||
      normalizePath(object.path) === normalizePath(file) ||
      normalizePath(object.bodyPath) === normalizePath(file)
    ) {
      return true;
    }

    for (const token of tokenize(file)) {
      if (objectTokens.has(token)) {
        return true;
      }
    }

    return false;
  });
}

function relationHasFileEvidence(
  relation: StoredMemoryRelation,
  changedFiles: readonly string[]
): boolean {
  const fileSet = new Set(changedFiles.map(normalizePath));

  return (relation.relation.evidence ?? []).some(
    (evidence) => evidence.kind === "file" && fileSet.has(normalizePath(evidence.id))
  );
}

function objectSearchText(object: StoredMemoryObject): string {
  const facets = object.sidecar.facets;

  return normalizeForSearch(
    [
      object.path,
      object.bodyPath,
      object.sidecar.id,
      object.sidecar.title,
      ...(object.sidecar.tags ?? []),
      facets?.category ?? "",
      ...(facets?.applies_to ?? []),
      ...(facets?.load_modes ?? []),
      ...(object.sidecar.evidence ?? []).map((item) => item.id),
      object.body
    ].join("\n")
  );
}

function compareObjectsById(
  left: StoredMemoryObject,
  right: StoredMemoryObject
): number {
  return left.sidecar.id.localeCompare(right.sidecar.id);
}

function tokenize(value: string): Set<string> {
  return new Set(
    normalizeForSearch(value)
      .split(/[^a-z0-9]+/u)
      .filter((token) => token.length >= 3 && !TOKEN_STOP_WORDS.has(token))
  );
}

function compareBootstrapCandidates(left: string, right: string): number {
  const priorityComparison = bootstrapPriority(left) - bootstrapPriority(right);

  if (priorityComparison !== 0) {
    return priorityComparison;
  }

  return left.localeCompare(right);
}

function bootstrapPriority(file: string): number {
  if (file === "README.md") {
    return 0;
  }

  if (file === "AGENTS.md" || file === "CLAUDE.md") {
    return 1;
  }

  if (isManifestOrConfig(file)) {
    return 2;
  }

  if (file.startsWith("docs/")) {
    return 3;
  }

  if (
    file.startsWith("src/") ||
    file.startsWith("app/") ||
    file.startsWith("pages/") ||
    file.startsWith("routes/") ||
    file.startsWith("lib/")
  ) {
    return 4;
  }

  if (file.startsWith("test/") || file.startsWith("tests/")) {
    return 5;
  }

  return 6;
}

function isManifestOrConfig(file: string): boolean {
  return (
    file === "package.json" ||
    file === "pnpm-workspace.yaml" ||
    /^tsconfig.*\.json$/u.test(file) ||
    /^(vite|vitest|next|svelte|eslint)\.config\./u.test(file)
  );
}

function normalizeForSearch(value: string): string {
  return normalizePath(value).toLowerCase();
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function timestampMillis(value: string): number | null {
  const timestamp = Date.parse(value);

  return Number.isNaN(timestamp) ? null : timestamp;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function uniqueObjectTypes(values: readonly ObjectType[]): ObjectType[] {
  return [...new Set(values)];
}
