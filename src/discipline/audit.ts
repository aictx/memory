import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveInsideRoot } from "../core/fs.js";
import type { ProjectFileChange } from "../core/git.js";
import type { Evidence, ObjectId, ObjectStatus } from "../core/types.js";
import type { StoredMemoryObject } from "../storage/objects.js";
import type { CanonicalStorageSnapshot } from "../storage/read.js";
import type { StoredMemoryRelation } from "../storage/relations.js";

export type AuditSeverity = "warning" | "info";

export type AuditRule =
  | "vague_memory"
  | "duplicate_like_title_or_tags"
  | "stale_or_superseded_cleanup"
  | "referenced_file_missing"
  | "missing_tags"
  | "missing_facets"
  | "missing_object_evidence"
  | "source_missing_origin"
  | "synthesis_missing_source_provenance"
  | "task_diary_like_memory"
  | "oversized_vague_memory"
  | "duplicate_like_facet_category"
  | "missing_evidence"
  | "manifest_version_contradiction"
  | "weakly_connected_memory"
  | "unlinked_applicability_overlap"
  | "excessive_related_to"
  | "changed_file_missing_rationale"
  | "possibly_stale_changed_reference"
  | "source_origin_outdated"
  | "active_conflict_needs_resolution"
  | "supersession_chain_needs_review";

export interface AuditFinding {
  severity: AuditSeverity;
  rule: AuditRule;
  memory_id: ObjectId;
  message: string;
  evidence: Evidence[];
}

export interface BuildAuditFindingsOptions {
  projectRoot: string;
  storage: CanonicalStorageSnapshot;
  gitFileChanges?: readonly ProjectFileChange[];
}

const VAGUE_STATUSES = new Set<ObjectStatus>(["active"]);
const CURRENT_STATUSES = new Set<ObjectStatus>(["active", "open"]);
const TAG_REQUIRED_STATUSES = new Set<ObjectStatus>(["active"]);
const INACTIVE_STATUSES = new Set<ObjectStatus>([
  "stale",
  "superseded",
  "closed"
]);
const GENERIC_TITLES = new Set([
  "context",
  "general",
  "important",
  "memory",
  "misc",
  "miscellaneous",
  "note",
  "notes",
  "placeholder",
  "tbd",
  "todo",
  "update",
  "updates",
  "wip",
  "work in progress"
]);
const VERY_SHORT_BODY_WORD_LIMIT = 8;
const OVERSIZED_BODY_WORD_LIMIT = 220;
const MINIMUM_DUPLICATE_TAG_COUNT = 3;
const RELATED_TO_WARNING_MINIMUM = 5;
const RELATED_TO_WARNING_RATIO = 0.5;
const REPEATED_CHANGE_MINIMUM = 2;
const RATIONALE_TYPES = new Set(["decision", "fact", "gotcha", "synthesis"]);
const CONFLICT_PREDICATES = new Set(["conflicts_with", "challenges"]);
const SOURCE_PROVENANCE_PREDICATES = new Set([
  "derived_from",
  "summarizes",
  "documents",
  "supports"
]);
const GENERIC_MANIFEST_APPLICABILITY = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb"
]);
const SEVERITY_ORDER = new Map<AuditSeverity, number>([
  ["warning", 0],
  ["info", 1]
]);
const FILE_REFERENCE_PATTERN =
  /(?:^|[\s([{"'`])((?:\.\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.@+-]+\.[A-Za-z0-9]+)(?=$|[\s)\]}",'`:;])/gu;
const EXPLICIT_VERSION_PATTERN =
  /\b(?:package(?:\.json)?\s+)?version\s*(?:is|=|:)?\s*["'`]?([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)/giu;

export async function buildAuditFindings(
  options: BuildAuditFindingsOptions
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];

  findings.push(...vagueMemoryFindings(options.storage.objects));
  findings.push(...duplicateLikeFindings(options.storage.objects));
  findings.push(...staleOrSupersededCleanupFindings(options.storage));
  findings.push(...missingTagFindings(options.storage.objects));
  findings.push(...missingFacetFindings(options.storage));
  findings.push(...missingObjectEvidenceFindings(options.storage));
  findings.push(...sourceMissingOriginFindings(options.storage.objects));
  findings.push(...synthesisMissingSourceProvenanceFindings(options.storage));
  findings.push(...taskDiaryLikeFindings(options.storage.objects));
  findings.push(...oversizedVagueMemoryFindings(options.storage.objects));
  findings.push(...duplicateFacetCategoryFindings(options.storage.objects));
  findings.push(...missingEvidenceFindings(options.storage.relations));
  findings.push(...weaklyConnectedMemoryFindings(options.storage));
  findings.push(...unlinkedApplicabilityOverlapFindings(options.storage));
  findings.push(...excessiveRelatedToFindings(options.storage.relations));
  findings.push(
    ...changedFileMissingRationaleFindings({
      storage: options.storage,
      gitFileChanges: options.gitFileChanges ?? []
    })
  );
  findings.push(
    ...possiblyStaleChangedReferenceFindings({
      storage: options.storage,
      gitFileChanges: options.gitFileChanges ?? []
    })
  );
  findings.push(...activeConflictNeedsResolutionFindings(options.storage));
  findings.push(...supersessionChainNeedsReviewFindings(options.storage));
  findings.push(
    ...(await referencedFileMissingFindings({
      projectRoot: options.projectRoot,
      storage: options.storage
    }))
  );
  findings.push(
    ...(await sourceOriginOutdatedFindings({
      projectRoot: options.projectRoot,
      objects: options.storage.objects
    }))
  );
  findings.push(
    ...(await manifestVersionContradictionFindings({
      projectRoot: options.projectRoot,
      objects: options.storage.objects
    }))
  );

  return findings.map(normalizeFinding).sort(compareFindings);
}

function missingFacetFindings(storage: CanonicalStorageSnapshot): AuditFinding[] {
  if (storage.config.version < 2) {
    return [];
  }

  return currentObjects(storage.objects, TAG_REQUIRED_STATUSES)
    .filter((object) => object.sidecar.facets === undefined)
    .map((object) => ({
      severity: "info",
      rule: "missing_facets",
      memory_id: object.sidecar.id,
      message: "Memory has no schema-backed facets.",
      evidence: [{ kind: "memory", id: object.sidecar.id }]
    }));
}

function missingObjectEvidenceFindings(storage: CanonicalStorageSnapshot): AuditFinding[] {
  if (storage.config.version < 2) {
    return [];
  }

  return currentObjects(storage.objects, TAG_REQUIRED_STATUSES)
    .filter((object) => ["decision", "fact", "gotcha"].includes(object.sidecar.type))
    .filter((object) => (object.sidecar.evidence ?? []).length === 0)
    .map((object) => ({
      severity: "info",
      rule: "missing_object_evidence",
      memory_id: object.sidecar.id,
      message: "Decision, fact, and gotcha memory should include object-level evidence when possible.",
      evidence: [{ kind: "memory", id: object.sidecar.id }]
    }));
}

function sourceMissingOriginFindings(objects: readonly StoredMemoryObject[]): AuditFinding[] {
  return currentObjects(objects, TAG_REQUIRED_STATUSES)
    .filter((object) => object.sidecar.type === "source" && object.sidecar.origin === undefined)
    .map((object) => ({
      severity: "warning",
      rule: "source_missing_origin",
      memory_id: object.sidecar.id,
      message: "Active source memory should include raw-source origin identity.",
      evidence: [{ kind: "memory", id: object.sidecar.id }]
    }));
}

function synthesisMissingSourceProvenanceFindings(
  storage: CanonicalStorageSnapshot
): AuditFinding[] {
  if (storage.config.version < 2) {
    return [];
  }

  const activeSourceIds = new Set(
    currentObjects(storage.objects, TAG_REQUIRED_STATUSES)
      .filter((object) => object.sidecar.type === "source")
      .map((object) => object.sidecar.id)
  );

  return currentObjects(storage.objects, TAG_REQUIRED_STATUSES)
    .filter((object) => object.sidecar.type === "synthesis")
    .filter((object) => !hasActiveSourceEvidence(object, activeSourceIds))
    .filter((object) => !hasActiveSourceProvenanceRelation(storage, object, activeSourceIds))
    .map((object) => ({
      severity: "info",
      rule: "synthesis_missing_source_provenance",
      memory_id: object.sidecar.id,
      message: "Synthesis memory should be backed by source evidence or an active source provenance relation.",
      evidence: [{ kind: "memory", id: object.sidecar.id }]
    }));
}

function hasActiveSourceEvidence(
  object: StoredMemoryObject,
  activeSourceIds: ReadonlySet<ObjectId>
): boolean {
  return (object.sidecar.evidence ?? []).some(
    (evidence) => evidence.kind === "source" && activeSourceIds.has(evidence.id)
  );
}

function hasActiveSourceProvenanceRelation(
  storage: CanonicalStorageSnapshot,
  object: StoredMemoryObject,
  activeSourceIds: ReadonlySet<ObjectId>
): boolean {
  return storage.relations.some((relation) => {
    if (
      relation.relation.status !== "active" ||
      !SOURCE_PROVENANCE_PREDICATES.has(relation.relation.predicate)
    ) {
      return false;
    }

    const fromMatches =
      relation.relation.from === object.sidecar.id && activeSourceIds.has(relation.relation.to);
    const toMatches =
      relation.relation.to === object.sidecar.id && activeSourceIds.has(relation.relation.from);

    return fromMatches || toMatches;
  });
}

function taskDiaryLikeFindings(objects: readonly StoredMemoryObject[]): AuditFinding[] {
  return currentObjects(objects, TAG_REQUIRED_STATUSES)
    .filter((object) => isTaskDiaryLike(`${object.sidecar.title}\n${object.body}`))
    .map((object) => ({
      severity: "warning",
      rule: "task_diary_like_memory",
      memory_id: object.sidecar.id,
      message: "Memory looks like a task diary instead of durable project knowledge.",
      evidence: [{ kind: "memory", id: object.sidecar.id }]
    }));
}

function oversizedVagueMemoryFindings(objects: readonly StoredMemoryObject[]): AuditFinding[] {
  return currentObjects(objects, TAG_REQUIRED_STATUSES)
    .filter((object) => wordCount(object.body) > OVERSIZED_BODY_WORD_LIMIT)
    .filter((object) => object.sidecar.facets === undefined || isGenericTitle(object.sidecar.title))
    .map((object) => ({
      severity: "info",
      rule: "oversized_vague_memory",
      memory_id: object.sidecar.id,
      message: "Memory is large and weakly categorized; split or facet it for reliable retrieval.",
      evidence: [{ kind: "memory", id: object.sidecar.id }]
    }));
}

function duplicateFacetCategoryFindings(objects: readonly StoredMemoryObject[]): AuditFinding[] {
  const duplicateEvidence = new Map<ObjectId, Evidence[]>();
  const candidates = currentObjects(objects, CURRENT_STATUSES).filter(
    (object) => object.sidecar.facets !== undefined
  );

  recordDuplicateGroups(
    duplicateEvidence,
    groupObjects(candidates, facetCategoryKey)
  );

  return [...duplicateEvidence.entries()].map(([memoryId, evidence]) => ({
    severity: "info",
    rule: "duplicate_like_facet_category",
    memory_id: memoryId,
    message: "Memory shares a facet category and applicability hints with another current memory entry.",
    evidence
  }));
}

function vagueMemoryFindings(objects: readonly StoredMemoryObject[]): AuditFinding[] {
  return currentObjects(objects, VAGUE_STATUSES)
    .filter((object) => isGenericTitle(object.sidecar.title) || isVeryShortBody(object.body))
    .map((object) => ({
      severity: "info",
      rule: "vague_memory",
      memory_id: object.sidecar.id,
      message: "Memory is too vague for reliable future use.",
      evidence: [{ kind: "memory", id: object.sidecar.id }]
    }));
}

function duplicateLikeFindings(objects: readonly StoredMemoryObject[]): AuditFinding[] {
  const duplicateEvidence = new Map<ObjectId, Evidence[]>();
  const candidates = currentObjects(objects, CURRENT_STATUSES);

  recordDuplicateGroups(
    duplicateEvidence,
    groupObjects(candidates, (object) => normalizeComparableText(object.sidecar.title))
  );
  recordDuplicateGroups(
    duplicateEvidence,
    groupObjects(candidates, duplicateTagKey)
  );

  return [...duplicateEvidence.entries()].map(([memoryId, evidence]) => ({
    severity: "warning",
    rule: "duplicate_like_title_or_tags",
    memory_id: memoryId,
    message: "Memory is duplicate-like with another current memory entry.",
    evidence
  }));
}

function staleOrSupersededCleanupFindings(
  storage: CanonicalStorageSnapshot
): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const activeRelations = storage.relations.filter(
    (relation) => relation.relation.status === "active"
  );

  for (const object of [...storage.objects].sort(compareObjectsById)) {
    if (!INACTIVE_STATUSES.has(object.sidecar.status)) {
      continue;
    }

    const activeNonSupersedesRelations = activeRelations
      .filter(
        (relation) =>
          relation.relation.predicate !== "supersedes" &&
          (relation.relation.from === object.sidecar.id ||
            relation.relation.to === object.sidecar.id)
      )
      .sort(compareRelationsById);

    if (activeNonSupersedesRelations.length > 0) {
      findings.push({
        severity: "warning",
        rule: "stale_or_superseded_cleanup",
        memory_id: object.sidecar.id,
        message: "Inactive memory is still linked by active non-supersedes relations.",
        evidence: activeNonSupersedesRelations.map((relation) => ({
          kind: "relation",
          id: relation.relation.id
        }))
      });
    }

    if (
      object.sidecar.status === "superseded" &&
      object.sidecar.superseded_by == null &&
      !hasActiveSupersedesRelation(activeRelations, object.sidecar.id)
    ) {
      findings.push({
        severity: "warning",
        rule: "stale_or_superseded_cleanup",
        memory_id: object.sidecar.id,
        message: "Superseded memory does not identify replacement memory.",
        evidence: [{ kind: "memory", id: object.sidecar.id }]
      });
    }
  }

  return findings;
}

function missingTagFindings(objects: readonly StoredMemoryObject[]): AuditFinding[] {
  return currentObjects(objects, TAG_REQUIRED_STATUSES)
    .filter(
      (object) =>
        object.sidecar.type !== "project" &&
        object.sidecar.type !== "question" &&
        (object.sidecar.tags ?? []).length === 0
    )
    .map((object) => ({
      severity: "info",
      rule: "missing_tags",
      memory_id: object.sidecar.id,
      message: "Memory has no tags.",
      evidence: [{ kind: "memory", id: object.sidecar.id }]
    }));
}

function missingEvidenceFindings(
  relations: readonly StoredMemoryRelation[]
): AuditFinding[] {
  return [...relations]
    .sort(compareRelationsById)
    .filter(
      (relation) =>
        relation.relation.status === "active" &&
        relation.relation.confidence === "high" &&
        (relation.relation.evidence ?? []).length === 0
    )
    .map((relation) => ({
      severity: "warning",
      rule: "missing_evidence",
      memory_id: relation.relation.from,
      message: "High-confidence relation is missing evidence.",
      evidence: [{ kind: "relation", id: relation.relation.id }]
    }));
}

function weaklyConnectedMemoryFindings(
  storage: CanonicalStorageSnapshot
): AuditFinding[] {
  if (storage.config.version < 2) {
    return [];
  }

  return currentObjects(storage.objects, TAG_REQUIRED_STATUSES)
    .filter((object) => RATIONALE_TYPES.has(object.sidecar.type))
    .filter((object) => (object.sidecar.evidence ?? []).length === 0)
    .filter((object) => !hasActiveRelation(storage.relations, object.sidecar.id))
    .map((object) => ({
      severity: "info",
      rule: "weakly_connected_memory",
      memory_id: object.sidecar.id,
      message: "Decision, fact, and gotcha memory should have evidence or at least one active relation.",
      evidence: [{ kind: "memory", id: object.sidecar.id }]
    }));
}

function unlinkedApplicabilityOverlapFindings(
  storage: CanonicalStorageSnapshot
): AuditFinding[] {
  if (storage.config.version < 2) {
    return [];
  }

  const findings: AuditFinding[] = [];
  const objects = currentObjects(storage.objects, CURRENT_STATUSES)
    .filter((object) => (object.sidecar.facets?.applies_to ?? []).length > 0);

  for (let leftIndex = 0; leftIndex < objects.length; leftIndex += 1) {
    const left = objects[leftIndex];

    if (left === undefined) {
      continue;
    }

    for (let rightIndex = leftIndex + 1; rightIndex < objects.length; rightIndex += 1) {
      const right = objects[rightIndex];

      if (
        right === undefined ||
        hasActiveDirectRelation(storage.relations, left.sidecar.id, right.sidecar.id)
      ) {
        continue;
      }

      const overlap = overlappingApplicability(left, right);

      if (overlap.length === 0) {
        continue;
      }

      if (isSuppressedApplicabilityOverlap(left, right, overlap)) {
        continue;
      }

      findings.push(applicabilityOverlapFinding(left, right, overlap));
    }
  }

  return findings;
}

function excessiveRelatedToFindings(
  relations: readonly StoredMemoryRelation[]
): AuditFinding[] {
  const activeRelations = relations.filter((relation) => relation.relation.status === "active");
  const relatedToRelations = activeRelations
    .filter((relation) => relation.relation.predicate === "related_to")
    .sort(compareRelationsById);

  if (
    relatedToRelations.length < RELATED_TO_WARNING_MINIMUM ||
    relatedToRelations.length / Math.max(activeRelations.length, 1) <= RELATED_TO_WARNING_RATIO
  ) {
    return [];
  }

  const firstRelation = relatedToRelations[0];

  if (firstRelation === undefined) {
    return [];
  }

  return [
    {
      severity: "info",
      rule: "excessive_related_to",
      memory_id: firstRelation.relation.from,
      message: "`related_to` is overused; prefer specific predicates when a stronger link is known.",
      evidence: relatedToRelations.map((relation) => ({
        kind: "relation",
        id: relation.relation.id
      }))
    }
  ];
}

function changedFileMissingRationaleFindings(options: {
  storage: CanonicalStorageSnapshot;
  gitFileChanges: readonly ProjectFileChange[];
}): AuditFinding[] {
  if (options.gitFileChanges.length === 0) {
    return [];
  }

  const changesByFile = groupGitChangesByFile(options.gitFileChanges);
  const rationaleObjects = activeRationaleObjects(options.storage.objects);
  const missingFiles: string[] = [];
  const missingCommits = new Set<string>();

  for (const [file, changes] of [...changesByFile.entries()].sort(compareEntriesByKey)) {
    const commitIds = uniqueSorted(changes.map((change) => change.commit));

    if (
      commitIds.length < REPEATED_CHANGE_MINIMUM ||
      rationaleObjects.some((object) => objectReferencesFile(object, file))
    ) {
      continue;
    }

    missingFiles.push(file);

    for (const commit of commitIds.slice(0, 5)) {
      missingCommits.add(commit);
    }
  }

  if (missingFiles.length === 0) {
    return [];
  }

  return [
    {
      severity: "info",
      rule: "changed_file_missing_rationale",
      memory_id: options.storage.config.project.id,
      message:
        "Multiple files have repeated recent Git changes but no active rationale memory linked to them.",
      evidence: [
        ...missingFiles.slice(0, 12).map((file) => ({ kind: "file", id: file }) satisfies Evidence),
        ...uniqueSorted([...missingCommits])
          .slice(0, 12)
          .map((commit) => ({ kind: "commit", id: commit }) satisfies Evidence)
      ]
    }
  ];
}

function possiblyStaleChangedReferenceFindings(options: {
  storage: CanonicalStorageSnapshot;
  gitFileChanges: readonly ProjectFileChange[];
}): AuditFinding[] {
  if (options.gitFileChanges.length === 0) {
    return [];
  }

  const changesByFile = groupGitChangesByFile(options.gitFileChanges);
  const findings: AuditFinding[] = [];

  for (const object of currentObjects(options.storage.objects, CURRENT_STATUSES)) {
    const objectUpdatedAt = timestampMillis(object.sidecar.updated_at);

    if (objectUpdatedAt === null) {
      continue;
    }

    const matchingEvidence: Evidence[] = [];

    for (const [file, changes] of [...changesByFile.entries()].sort(compareEntriesByKey)) {
      if (!objectReferencesFile(object, file)) {
        continue;
      }

      const laterChanges = changes.filter((change) => {
        const changedAt = timestampMillis(change.timestamp);

        return changedAt !== null && changedAt > objectUpdatedAt;
      });
      const commits = uniqueSorted(laterChanges.map((change) => change.commit));

      if (commits.length < REPEATED_CHANGE_MINIMUM) {
        continue;
      }

      matchingEvidence.push(
        { kind: "file", id: file },
        ...commits.slice(0, 4).map((commit) => ({ kind: "commit", id: commit }) satisfies Evidence)
      );
    }

    if (matchingEvidence.length === 0) {
      continue;
    }

    findings.push({
      severity: "info",
      rule: "possibly_stale_changed_reference",
      memory_id: object.sidecar.id,
      message:
        "Memory references files with repeated Git changes after this memory was last updated; review against current code before relying on it.",
      evidence: matchingEvidence
    });
  }

  return findings;
}

function activeConflictNeedsResolutionFindings(
  storage: CanonicalStorageSnapshot
): AuditFinding[] {
  const findings: AuditFinding[] = [];

  for (const relation of [...storage.relations].sort(compareRelationsById)) {
    if (
      relation.relation.status !== "active" ||
      !CONFLICT_PREDICATES.has(relation.relation.predicate) ||
      (relation.relation.evidence ?? []).length > 0 ||
      hasLinkedOpenConflictQuestion(storage, relation)
    ) {
      continue;
    }

    findings.push({
      severity: "warning",
      rule: "active_conflict_needs_resolution",
      memory_id: relation.relation.from,
      message:
        "Active conflict/challenge relation has no evidence and no linked open unresolved-conflict question.",
      evidence: [
        { kind: "relation", id: relation.relation.id },
        { kind: "memory", id: relation.relation.to }
      ]
    });
  }

  return findings;
}

function supersessionChainNeedsReviewFindings(
  storage: CanonicalStorageSnapshot
): AuditFinding[] {
  const byId = new Map(storage.objects.map((object) => [object.sidecar.id, object]));
  const findings: AuditFinding[] = [];

  for (const object of currentObjects(storage.objects, new Set<ObjectStatus>(["superseded"]))) {
    const replacements = replacementIdsForObject(storage, object.sidecar.id);

    for (const replacementId of replacements) {
      const replacement = byId.get(replacementId);

      if (replacement === undefined || !CURRENT_STATUSES.has(replacement.sidecar.status)) {
        findings.push({
          severity: "warning",
          rule: "supersession_chain_needs_review",
          memory_id: object.sidecar.id,
          message: "Superseded memory points to a missing or inactive replacement.",
          evidence: [{ kind: "memory", id: replacementId }]
        });
        continue;
      }

      const replacementReplacements = replacementIdsForObject(storage, replacementId);

      if (replacementReplacements.length > 0) {
        findings.push({
          severity: "info",
          rule: "supersession_chain_needs_review",
          memory_id: object.sidecar.id,
          message:
            "Supersession chain has multiple hops; review whether the old memory should point directly at the current replacement.",
          evidence: [
            { kind: "memory", id: replacementId },
            ...replacementReplacements
              .slice(0, 4)
              .map((id) => ({ kind: "memory", id }) satisfies Evidence)
          ]
        });
      }
    }
  }

  return findings;
}

async function referencedFileMissingFindings(options: {
  projectRoot: string;
  storage: CanonicalStorageSnapshot;
}): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const missingObjectPaths = await missingObjectFileReferenceEvidence(
    options.projectRoot,
    options.storage.objects
  );

  for (const [memoryId, evidence] of [...missingObjectPaths.entries()].sort(compareEntriesByKey)) {
    findings.push({
      severity: "warning",
      rule: "referenced_file_missing",
      memory_id: memoryId,
      message: "Memory references a file that does not exist.",
      evidence
    });
  }

  for (const relation of [...options.storage.relations].sort(compareRelationsById)) {
    const missingEvidence = await missingRelationFileEvidence(
      options.projectRoot,
      relation
    );

    if (missingEvidence.length === 0) {
      continue;
    }

    findings.push({
      severity: "warning",
      rule: "referenced_file_missing",
      memory_id: relation.relation.from,
      message: "Relation references file evidence that does not exist.",
      evidence: [{ kind: "relation", id: relation.relation.id }, ...missingEvidence]
    });
  }

  return findings;
}

async function sourceOriginOutdatedFindings(options: {
  projectRoot: string;
  objects: readonly StoredMemoryObject[];
}): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];

  for (const object of currentObjects(options.objects, CURRENT_STATUSES)) {
    if (object.sidecar.type !== "source" || object.sidecar.origin?.kind !== "file") {
      continue;
    }

    const locator = normalizeProjectFileReference(object.sidecar.origin.locator);

    if (locator === null) {
      continue;
    }

    const currentDigest = await projectFileDigest(options.projectRoot, locator);

    if (currentDigest === null) {
      findings.push({
        severity: "warning",
        rule: "source_origin_outdated",
        memory_id: object.sidecar.id,
        message:
          "Source memory origin file is missing or unreadable; review whether the source record is stale.",
        evidence: [{ kind: "file", id: locator }]
      });
      continue;
    }

    if (
      object.sidecar.origin.digest !== undefined &&
      object.sidecar.origin.digest !== currentDigest
    ) {
      findings.push({
        severity: "warning",
        rule: "source_origin_outdated",
        memory_id: object.sidecar.id,
        message:
          "Source memory origin digest no longer matches the current file; update the source record or related syntheses.",
        evidence: [{ kind: "file", id: locator }]
      });
    }
  }

  return findings;
}

async function manifestVersionContradictionFindings(options: {
  projectRoot: string;
  objects: readonly StoredMemoryObject[];
}): Promise<AuditFinding[]> {
  const packageVersion = await readPackageJsonVersion(options.projectRoot);

  if (packageVersion === null) {
    return [];
  }

  return currentObjects(options.objects, TAG_REQUIRED_STATUSES)
    .filter((object) =>
      statedVersions(`${object.sidecar.title}\n${object.body}`).some(
        (version) => version !== packageVersion
      )
    )
    .map((object) => ({
      severity: "warning",
      rule: "manifest_version_contradiction",
      memory_id: object.sidecar.id,
      message: "Memory states a package version that contradicts package.json.",
      evidence: [
        { kind: "file", id: "package.json" },
        { kind: "memory", id: object.sidecar.id }
      ]
    }));
}

function currentObjects(
  objects: readonly StoredMemoryObject[],
  statuses: ReadonlySet<ObjectStatus>
): StoredMemoryObject[] {
  return [...objects]
    .filter((object) => statuses.has(object.sidecar.status))
    .sort(compareObjectsById);
}

function isGenericTitle(title: string): boolean {
  return GENERIC_TITLES.has(normalizeComparableText(title));
}

function isVeryShortBody(body: string): boolean {
  return wordCount(stripMarkdownNoise(body)) < VERY_SHORT_BODY_WORD_LIMIT;
}

function stripMarkdownNoise(body: string): string {
  return body
    .replace(/^```[\s\S]*?```$/gmu, " ")
    .replace(/^#{1,6}\s+.+$/gmu, " ")
    .replace(/[`*_>#-]/gu, " ");
}

function wordCount(text: string): number {
  return text.split(/[^A-Za-z0-9]+/u).filter((word) => word.length > 0).length;
}

function isTaskDiaryLike(text: string): boolean {
  return /\b(i|we|agent)\s+(changed|updated|modified|fixed|implemented|ran)\b/i.test(text) ||
    /\b(tests?|typecheck|build)\s+passed\b/i.test(text) ||
    /\bchanged\s+\d+\s+files?\b/i.test(text);
}

function groupObjects(
  objects: readonly StoredMemoryObject[],
  keyForObject: (object: StoredMemoryObject) => string | null
): Map<string, StoredMemoryObject[]> {
  const groups = new Map<string, StoredMemoryObject[]>();

  for (const object of objects) {
    const key = keyForObject(object);

    if (key === null || key === "") {
      continue;
    }

    groups.set(key, [...(groups.get(key) ?? []), object]);
  }

  return groups;
}

function duplicateTagKey(object: StoredMemoryObject): string | null {
  const tags = [...(object.sidecar.tags ?? [])].sort();

  if (tags.length < MINIMUM_DUPLICATE_TAG_COUNT) {
    return null;
  }

  return `${object.sidecar.type}:${tags.join(",")}`;
}

function facetCategoryKey(object: StoredMemoryObject): string | null {
  const facets = object.sidecar.facets;

  if (facets === undefined) {
    return null;
  }

  const appliesTo = [...(facets.applies_to ?? [])].sort().join(",");

  if (appliesTo === "") {
    return null;
  }

  return `${facets.category}:${appliesTo}`;
}

function recordDuplicateGroups(
  evidenceById: Map<ObjectId, Evidence[]>,
  groups: Map<string, StoredMemoryObject[]>
): void {
  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }

    const sortedGroup = [...group].sort(compareObjectsById);

    for (const object of sortedGroup) {
      const existing = evidenceById.get(object.sidecar.id) ?? [];
      const otherObjects = sortedGroup
        .filter((other) => other.sidecar.id !== object.sidecar.id)
        .map((other) => ({ kind: "memory", id: other.sidecar.id }) satisfies Evidence);

      evidenceById.set(object.sidecar.id, [...existing, ...otherObjects]);
    }
  }
}

function hasActiveSupersedesRelation(
  activeRelations: readonly StoredMemoryRelation[],
  supersededId: ObjectId
): boolean {
  return activeRelations.some(
    (relation) =>
      relation.relation.predicate === "supersedes" && relation.relation.to === supersededId
  );
}

function hasActiveRelation(
  relations: readonly StoredMemoryRelation[],
  memoryId: ObjectId
): boolean {
  return relations.some(
    (relation) =>
      relation.relation.status === "active" &&
      (relation.relation.from === memoryId || relation.relation.to === memoryId)
  );
}

function hasActiveDirectRelation(
  relations: readonly StoredMemoryRelation[],
  leftId: ObjectId,
  rightId: ObjectId
): boolean {
  return relations.some(
    (relation) =>
      relation.relation.status === "active" &&
      ((relation.relation.from === leftId && relation.relation.to === rightId) ||
        (relation.relation.from === rightId && relation.relation.to === leftId))
  );
}

function hasLinkedOpenConflictQuestion(
  storage: CanonicalStorageSnapshot,
  conflict: StoredMemoryRelation
): boolean {
  const conflictEndpoints = new Set([conflict.relation.from, conflict.relation.to]);
  const questionIds = new Set(
    storage.objects
      .filter(
        (object) =>
          object.sidecar.type === "question" &&
          object.sidecar.status === "open" &&
          object.sidecar.facets?.category === "unresolved-conflict"
      )
      .map((object) => object.sidecar.id)
  );

  if (questionIds.size === 0) {
    return false;
  }

  return storage.relations.some((relation) => {
    if (relation.relation.status !== "active") {
      return false;
    }

    const fromQuestion = questionIds.has(relation.relation.from);
    const toQuestion = questionIds.has(relation.relation.to);

    return (
      (fromQuestion && conflictEndpoints.has(relation.relation.to)) ||
      (toQuestion && conflictEndpoints.has(relation.relation.from))
    );
  });
}

function replacementIdsForObject(
  storage: CanonicalStorageSnapshot,
  supersededId: ObjectId
): ObjectId[] {
  const ids = new Set<ObjectId>();
  const object = storage.objects.find((item) => item.sidecar.id === supersededId);

  if (object?.sidecar.superseded_by != null) {
    ids.add(object.sidecar.superseded_by);
  }

  for (const relation of storage.relations) {
    if (
      relation.relation.status === "active" &&
      relation.relation.predicate === "supersedes" &&
      relation.relation.to === supersededId
    ) {
      ids.add(relation.relation.from);
    }
  }

  return [...ids].sort();
}

function overlappingApplicability(
  left: StoredMemoryObject,
  right: StoredMemoryObject
): string[] {
  const leftValues = normalizedApplicabilityValues(left);
  const rightValues = new Set(normalizedApplicabilityValues(right));

  return leftValues.filter((value) => rightValues.has(value));
}

function normalizedApplicabilityValues(object: StoredMemoryObject): string[] {
  return uniqueSorted(
    (object.sidecar.facets?.applies_to ?? [])
      .map(normalizeApplicabilityValue)
      .filter((value) => value !== "")
  );
}

function isSuppressedApplicabilityOverlap(
  left: StoredMemoryObject,
  right: StoredMemoryObject,
  overlap: readonly string[]
): boolean {
  return (
    overlap.length > 0 &&
    overlap.every((value) => GENERIC_MANIFEST_APPLICABILITY.has(value)) &&
    (isBroadSourceOrSynthesis(left) || isBroadSourceOrSynthesis(right))
  );
}

function isBroadSourceOrSynthesis(object: StoredMemoryObject): boolean {
  return object.sidecar.type === "source" || object.sidecar.type === "synthesis";
}

function normalizeApplicabilityValue(value: string): string {
  return value.trim().replace(/\\/gu, "/").replace(/^\.\//u, "").toLowerCase();
}

function applicabilityOverlapFinding(
  object: StoredMemoryObject,
  other: StoredMemoryObject,
  overlap: readonly string[]
): AuditFinding {
  const fileEvidence = overlap
    .map(normalizeProjectFileReference)
    .filter((path): path is string => path !== null && isFileLikeApplicability(path))
    .map((path) => ({ kind: "file", id: path }) satisfies Evidence);

  return {
    severity: "info",
    rule: "unlinked_applicability_overlap",
    memory_id: object.sidecar.id,
    message: "Memory overlaps another object's applies_to facets but has no active relation to it.",
    evidence: [{ kind: "memory", id: other.sidecar.id }, ...fileEvidence]
  };
}

function isFileLikeApplicability(value: string): boolean {
  return value.includes("/") || /\.[A-Za-z0-9]+$/u.test(value);
}

function isFileLikeApplicabilityReference(value: string): boolean {
  const normalized = value.trim().replace(/\\/gu, "/");

  return !normalized.endsWith("/") && /\.[A-Za-z0-9]+$/u.test(normalized);
}

function groupGitChangesByFile(
  changes: readonly ProjectFileChange[]
): Map<string, ProjectFileChange[]> {
  const byFile = new Map<string, ProjectFileChange[]>();

  for (const change of changes) {
    const file = normalizeProjectFileReference(change.file);

    if (file === null) {
      continue;
    }

    byFile.set(file, [...(byFile.get(file) ?? []), change]);
  }

  return byFile;
}

function activeRationaleObjects(
  objects: readonly StoredMemoryObject[]
): StoredMemoryObject[] {
  return currentObjects(objects, new Set<ObjectStatus>(["active"]))
    .filter((object) => RATIONALE_TYPES.has(object.sidecar.type));
}

function objectReferencesFile(object: StoredMemoryObject, file: string): boolean {
  return objectLinkedFiles(object).some(
    (linkedFile) => file === linkedFile || file.startsWith(`${linkedFile}/`)
  );
}

function objectLinkedFiles(object: StoredMemoryObject): string[] {
  const evidenceFiles = (object.sidecar.evidence ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.id);
  const facetFiles = object.sidecar.facets?.applies_to ?? [];

  return uniqueSorted(
    [...evidenceFiles, ...facetFiles, ...extractProjectFileReferences(object.body)]
      .map(normalizeProjectFileReference)
      .filter((path): path is string => path !== null)
  );
}

async function missingObjectFileReferenceEvidence(
  projectRoot: string,
  objects: readonly StoredMemoryObject[]
): Promise<Map<ObjectId, Evidence[]>> {
  const evidenceById = new Map<ObjectId, Evidence[]>();

  for (const object of [...objects].sort(compareObjectsById)) {
    const missingPaths = await missingProjectFilePaths(
      projectRoot,
      objectFileReferences(object)
    );

    if (missingPaths.length > 0) {
      evidenceById.set(
        object.sidecar.id,
        missingPaths.map((path) => ({ kind: "file", id: path }))
      );
    }
  }

  return evidenceById;
}

function objectFileReferences(object: StoredMemoryObject): string[] {
  return uniqueSorted([
    ...extractProjectFileReferences(object.body),
    ...(object.sidecar.evidence ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.id),
    ...(object.sidecar.facets?.applies_to ?? []).filter(isFileLikeApplicabilityReference),
    ...(object.sidecar.origin?.kind === "file" ? [object.sidecar.origin.locator] : [])
  ]);
}

async function missingRelationFileEvidence(
  projectRoot: string,
  relation: StoredMemoryRelation
): Promise<Evidence[]> {
  const fileEvidence = (relation.relation.evidence ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.id);
  const missingPaths = await missingProjectFilePaths(projectRoot, fileEvidence);

  return missingPaths.map((path) => ({ kind: "file", id: path }));
}

function extractProjectFileReferences(body: string): string[] {
  return uniqueSorted(
    [...body.matchAll(FILE_REFERENCE_PATTERN)]
      .map((match) => match[1] ?? "")
      .map(normalizeProjectFileReference)
      .filter((path): path is string => path !== null)
  );
}

async function missingProjectFilePaths(
  projectRoot: string,
  rawPaths: readonly string[]
): Promise<string[]> {
  const paths = uniqueSorted(
    rawPaths
      .map(normalizeProjectFileReference)
      .filter((path): path is string => path !== null)
  );
  const missing: string[] = [];

  for (const path of paths) {
    if (!(await projectFileExists(projectRoot, path))) {
      missing.push(path);
    }
  }

  return missing;
}

function normalizeProjectFileReference(value: string): string | null {
  const normalized = value.trim().replace(/\\/gu, "/").replace(/^\.\//u, "");

  if (
    normalized === "" ||
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.includes("://") ||
    normalized.startsWith(".memory/")
  ) {
    return null;
  }

  return normalized;
}

async function projectFileExists(projectRoot: string, path: string): Promise<boolean> {
  const resolved = resolveInsideRoot(projectRoot, path);

  if (!resolved.ok) {
    return false;
  }

  try {
    const stats = await lstat(resolved.data);

    return stats.isFile();
  } catch {
    return false;
  }
}

async function projectFileDigest(projectRoot: string, path: string): Promise<string | null> {
  const resolved = resolveInsideRoot(projectRoot, path);

  if (!resolved.ok) {
    return null;
  }

  try {
    const bytes = await readFile(resolved.data);

    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  } catch {
    return null;
  }
}

function timestampMillis(value: string): number | null {
  const timestamp = Date.parse(value);

  return Number.isNaN(timestamp) ? null : timestamp;
}

async function readPackageJsonVersion(projectRoot: string): Promise<string | null> {
  const packageJsonPath = join(projectRoot, "package.json");

  try {
    await access(packageJsonPath, constants.R_OK);
    const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as unknown;

    return isRecord(parsed) && typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

function statedVersions(text: string): string[] {
  return uniqueSorted(
    [...text.matchAll(EXPLICIT_VERSION_PATTERN)]
      .map((match) => match[1] ?? "")
      .filter((version) => version.length > 0)
  );
}

function normalizeFinding(finding: AuditFinding): AuditFinding {
  return {
    ...finding,
    evidence: uniqueEvidence(finding.evidence)
  };
}

function uniqueEvidence(evidence: readonly Evidence[]): Evidence[] {
  const byKey = new Map<string, Evidence>();

  for (const item of evidence) {
    byKey.set(evidenceKey(item), item);
  }

  return [...byKey.values()].sort(compareEvidence);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function normalizeComparableText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function compareFindings(left: AuditFinding, right: AuditFinding): number {
  return (
    severityOrder(left.severity) - severityOrder(right.severity) ||
    left.rule.localeCompare(right.rule) ||
    left.memory_id.localeCompare(right.memory_id) ||
    firstEvidenceKey(left).localeCompare(firstEvidenceKey(right)) ||
    left.message.localeCompare(right.message)
  );
}

function firstEvidenceKey(finding: AuditFinding): string {
  return finding.evidence.map(evidenceKey).join("|");
}

function severityOrder(severity: AuditSeverity): number {
  return SEVERITY_ORDER.get(severity) ?? Number.MAX_SAFE_INTEGER;
}

function compareObjectsById(
  left: StoredMemoryObject,
  right: StoredMemoryObject
): number {
  return left.sidecar.id.localeCompare(right.sidecar.id);
}

function compareRelationsById(
  left: StoredMemoryRelation,
  right: StoredMemoryRelation
): number {
  return left.relation.id.localeCompare(right.relation.id);
}

function compareEvidence(left: Evidence, right: Evidence): number {
  return evidenceKey(left).localeCompare(evidenceKey(right));
}

function evidenceKey(evidence: Evidence): string {
  return `${evidence.kind}:${evidence.id}`;
}

function compareEntriesByKey<T>(left: [string, T], right: [string, T]): number {
  return left[0].localeCompare(right[0]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
