<svelte:options runes={true} />

<script lang="ts">
  import { FACET_CATEGORIES, OBJECT_TYPES } from "../../src/core/types.js";
  import cytoscape from "cytoscape";
  import { onDestroy, onMount } from "svelte";

  type FacetCategory = (typeof FACET_CATEGORIES)[number];
  type ObjectStatus = "active" | "stale" | "superseded" | "open" | "closed";
  type ObjectType = (typeof OBJECT_TYPES)[number];
  type RelationStatus = "active" | "stale" | "rejected";
  type RelationConfidence = "low" | "medium" | "high";
  type Predicate =
    | "affects"
    | "requires"
    | "depends_on"
    | "supersedes"
    | "conflicts_with"
    | "supports"
    | "challenges"
    | "derived_from"
    | "summarizes"
    | "documents"
    | "mentions"
    | "implements"
    | "related_to";

  interface Scope {
    kind: "project" | "branch" | "task";
    project: string;
    branch: string | null;
    task: string | null;
  }

  interface Source {
    kind: "agent" | "user" | "cli" | "mcp" | "system";
    task?: string;
    commit?: string;
  }

  interface SourceOrigin {
    kind: "file" | "url" | "user" | "external";
    locator: string;
    captured_at?: string;
    digest?: string;
    media_type?: string;
  }

  interface Evidence {
    kind: "memory" | "relation" | "file" | "commit" | "task" | "source";
    id: string;
  }

  type AuditSeverity = "warning" | "info";
  type AuditRule =
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

  interface AuditFinding {
    severity: AuditSeverity;
    rule: AuditRule;
    memory_id: string;
    message: string;
    evidence: Evidence[];
  }

  interface ObjectFacets {
    category: FacetCategory;
    applies_to?: string[];
    load_modes?: string[];
  }

  interface MemoryObjectSummary {
    id: string;
    type: ObjectType;
    status: ObjectStatus;
    title: string;
    body_path: string;
    json_path: string;
    scope: Scope;
    tags: string[];
    facets: ObjectFacets | null;
    evidence: Evidence[];
    source: Source | null;
    origin: SourceOrigin | null;
    superseded_by: string | null;
    created_at: string;
    updated_at: string;
    body: string;
  }

  interface MemoryRelationSummary {
    id: string;
    from: string;
    predicate: Predicate;
    to: string;
    status: RelationStatus;
    confidence: RelationConfidence | null;
    evidence: Evidence[];
    content_hash: string | null;
    created_at: string;
    updated_at: string;
    json_path: string;
  }

  interface ViewerBootstrapData {
    project: {
      id: string;
      name: string;
    };
    objects: MemoryObjectSummary[];
    relations: MemoryRelationSummary[];
    counts: {
      objects: number;
      relations: number;
      stale_objects: number;
      superseded_objects: number;
      source_objects: number;
      synthesis_objects: number;
      active_relations: number;
    };
    role_coverage: RoleCoverageData;
    lenses: MemoryLensData[];
    audit_findings: AuditFinding[];
    storage_warnings: string[];
  }

  interface RegisteredProjectSummary {
    registry_id: string;
    project: {
      id: string;
      name: string;
    };
    project_root: string;
    memory_root: string;
    source: "auto" | "manual";
    registered_at: string;
    last_seen_at: string;
  }

  interface ViewerProjectSummary extends RegisteredProjectSummary {
    current: boolean;
    available: boolean;
    counts: ViewerBootstrapData["counts"] | null;
    git: ViewerSuccessEnvelope["meta"]["git"] | null;
    warnings: string[];
  }

  interface ViewerProjectsData {
    registry_path: string;
    projects: ViewerProjectSummary[];
    counts: {
      projects: number;
      available: number;
      unavailable: number;
    };
    current_project_registry_id: string | null;
  }

  interface ExportObsidianProjectionData {
    format: "obsidian";
    output_dir: string;
    manifest_path: string;
    objects_exported: number;
    relations_linked: number;
    files_written: string[];
    files_removed: string[];
  }

  interface ViewerProjectDeleteData {
    registry_path: string;
    project: RegisteredProjectSummary;
    removed: RegisteredProjectSummary | null;
    destroyed: true;
    entries_removed: string[];
  }

  interface ViewerSuccessEnvelope<TData = ViewerBootstrapData> {
    ok: true;
    data: TData;
    warnings: string[];
    meta: {
      project_root: string;
      memory_root: string;
      git: {
        available: boolean;
        branch: string | null;
        commit: string | null;
        dirty: boolean | null;
      };
    };
  }

  interface ViewerErrorEnvelope {
    ok: false;
    error: {
      code: string;
      message: string;
      details?: unknown;
    };
    warnings: string[];
  }

  type ViewerEnvelope = ViewerSuccessEnvelope<ViewerBootstrapData> | ViewerErrorEnvelope;
  type ViewerProjectsEnvelope = ViewerSuccessEnvelope<ViewerProjectsData> | ViewerErrorEnvelope;
  type ExportEnvelope = ViewerSuccessEnvelope<ExportObsidianProjectionData> | ViewerErrorEnvelope;
  type LoadPreviewEnvelope = ViewerSuccessEnvelope<LoadPreviewData> | ViewerErrorEnvelope;
  type ProjectDeleteEnvelope = ViewerSuccessEnvelope<ViewerProjectDeleteData> | ViewerErrorEnvelope;
  type ViewerState = "loading" | "ready" | "error";
  type ViewerScreen = "projects" | "memories" | "detail" | "graph" | "maintenance" | "export";
  type ExportState = "idle" | "running" | "success" | "error";
  type PreviewState = "idle" | "running" | "success" | "error";
  type LayerFilter = "all" | "memories" | "syntheses" | "sources" | "inactive";
  type PagePreset = "all" | "atomic-memory" | "syntheses" | "sources" | "inactive";
  type ObjectSort = "type" | "updated-desc" | "updated-asc";
  type LoadMemoryMode = "coding" | "debugging" | "review" | "architecture" | "onboarding";
  type MemoryLensName = "project-map" | "current-work" | "review-risk" | "provenance" | "maintenance";
  type RoleCoverageStatus = "populated" | "thin" | "missing" | "stale" | "conflicted";

  interface RoleCoverageItem {
    key: string;
    label: string;
    description: string;
    status: RoleCoverageStatus;
    optional: boolean;
    memory_ids: string[];
    relation_ids: string[];
    gap: string | null;
  }

  interface RoleCoverageData {
    roles: RoleCoverageItem[];
    counts: Record<RoleCoverageStatus, number>;
  }

  interface MemoryLensData {
    name: MemoryLensName;
    title: string;
    markdown: string;
    role_coverage: RoleCoverageData;
    included_memory_ids: string[];
    relation_ids: string[];
    relations: MemoryRelationSummary[];
    generated_gaps: string[];
  }

  interface MarkdownBlock {
    kind: "heading" | "paragraph" | "list" | "quote" | "code";
    text?: string;
    level?: 1 | 2 | 3;
    items?: string[];
  }

  interface MemorySection {
    id: string;
    title: string;
    objects: MemoryObjectSummary[];
  }

  interface MemorySnapshotItem {
    label: string;
    value: string;
    detail: string;
  }

  interface MaintenanceGroup {
    memoryId: string;
    object: MemoryObjectSummary | null;
    findings: AuditFinding[];
    relations: MemoryRelationSummary[];
    suggestedAction: string;
  }

  interface DocGraphNode {
    id: string;
    label: string;
    type: ObjectType;
    color: string;
    borderColor: string;
    x: number;
    y: number;
    radius: number;
    hub: boolean;
    muted: boolean;
  }

  interface DocGraphEdge {
    id: string;
    color: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    muted: boolean;
  }

  interface DocGraphRelation {
    id: string;
    predicate: Predicate;
    targetLabel: string;
    status: RelationStatus;
    confidence: RelationConfidence | null;
  }

  interface DocGraphOverview {
    hub: MemoryObjectSummary | null;
    nodes: DocGraphNode[];
    edges: DocGraphEdge[];
    relations: DocGraphRelation[];
    hiddenRelationCount: number;
  }

  interface TokenTarget {
    value: number;
    source: "explicit" | "config_default" | "fallback_default";
    enforced: boolean;
    was_capped: boolean;
  }

  interface LoadMemorySource {
    project: string;
    git_available: boolean;
    branch: string | null;
    commit: string | null;
  }

  interface LoadPreviewData {
    task: string;
    token_budget: number;
    mode: LoadMemoryMode;
    context_pack: string;
    source: LoadMemorySource;
    token_target: TokenTarget;
    estimated_tokens: number;
    budget_status: "within_target" | "over_target";
    truncated: boolean;
    included_ids: string[];
    excluded_ids: string[];
    omitted_ids: string[];
  }

  let loadState = $state<ViewerState>("loading");
  let projectLoadState = $state<ViewerState>("loading");
  let projectsData = $state<ViewerProjectsData | null>(null);
  let bootstrap = $state<ViewerBootstrapData | null>(null);
  let warnings = $state<string[]>([]);
  let errorMessage = $state("");
  let projectErrorMessage = $state("");
  let currentScreen = $state<ViewerScreen>("projects");
  let selectedProjectId = $state<string | null>(null);
  let selectedObjectId = $state<string | null>(null);
  let searchQuery = $state("");
  let layerFilter = $state<LayerFilter>("all");
  let typeFilter = $state("all");
  let facetCategoryFilter = $state("all");
  let statusFilter = $state("all");
  let tagFilter = $state("all");
  let pagePreset = $state<PagePreset>("all");
  let objectSort = $state<ObjectSort>("type");
  let activeLensName = $state<MemoryLensName>("project-map");
  let sidebarDrawerOpen = $state(false);
  let exportOutDir = $state("");
  let exportState = $state<ExportState>("idle");
  let exportMessage = $state("");
  let exportErrorCode = $state("");
  let exportFilesWritten = $state(0);
  let exportManifestPath = $state("");
  let previewTask = $state("");
  let previewMode = $state<LoadMemoryMode>("coding");
  let previewTokenBudget = $state("");
  let previewState = $state<PreviewState>("idle");
  let previewMessage = $state("");
  let previewErrorCode = $state("");
  let previewData = $state<LoadPreviewData | null>(null);
  let copiedPreviewTarget = $state<"command" | "context" | null>(null);
  let pendingDeleteProjectId = $state<string | null>(null);
  let deleteConfirmText = $state("");
  let deletingProjectId = $state<string | null>(null);
  let projectDeleteMessage = $state("");
  let projectDeleteErrorCode = $state("");
  let graphContainer = $state<HTMLDivElement | null>(null);
  let memoryWorkspaceElement = $state<HTMLElement | null>(null);
  let graphInstance: cytoscape.Core | null = null;
  let graphShowInactive = $state(false);
  let selectedGraphObjectId = $state<string | null>(null);
  let selectedGraphRelationId = $state<string | null>(null);
  let schemaContextOpen = $state(true);

  const allOption = "all";
  const token = viewerToken();
  const isDemoMode = token === "demo";
  const layerOptions: Array<{ value: LayerFilter; label: string }> = [
    { value: "all", label: "All" },
    { value: "memories", label: "Atomic" },
    { value: "syntheses", label: "Syntheses" },
    { value: "sources", label: "Sources" },
    { value: "inactive", label: "Inactive" }
  ];
  const objectSortOptions: Array<{ value: ObjectSort; label: string }> = [
    { value: "type", label: "Type order" },
    { value: "updated-desc", label: "Edited newest" },
    { value: "updated-asc", label: "Edited oldest" }
  ];
  const loadModeOptions: Array<{ value: LoadMemoryMode; label: string }> = [
    { value: "coding", label: "Coding" },
    { value: "debugging", label: "Debugging" },
    { value: "review", label: "Review" },
    { value: "architecture", label: "Architecture" },
    { value: "onboarding", label: "Onboarding" }
  ];
  const graphTypeLegend: Array<{
    label: string;
    color: string;
    borderColor: string;
  }> = [
    { label: "Project", color: "#2f5d62", borderColor: "#fffefa" },
    { label: "Synthesis", color: "#574b90", borderColor: "#fffefa" },
    { label: "Workflow", color: "#3f648c", borderColor: "#fffefa" },
    { label: "Source", color: "#6b6f76", borderColor: "#9a968d" }
  ];
  const graphRelationLegend: Array<{ label: string; color: string; lineStyle: "solid" | "dashed" }> = [
    { label: "Semantic", color: "#4f6f5a", lineStyle: "solid" },
    { label: "Dependency", color: "#4f6590", lineStyle: "solid" },
    { label: "Provenance", color: "#766b94", lineStyle: "dashed" }
  ];
  const graphStyles: cytoscape.StylesheetJson = [
    {
      selector: "node",
      style: {
        "background-color": "data(color)",
        "border-color": "data(borderColor)",
        "border-width": 2,
        color: "#2e2d2a",
        "font-size": 9,
        "font-weight": 700,
        height: "data(size)",
        label: "data(label)",
        "min-zoomed-font-size": 8.5,
        "overlay-opacity": 0,
        "text-background-color": "#fffefa",
        "text-background-opacity": 0.94,
        "text-background-padding": "2px",
        "text-halign": "center",
        "text-margin-y": 10,
        "text-max-width": "74px",
        "text-valign": "bottom",
        "text-wrap": "wrap",
        width: "data(size)"
      }
    },
    {
      selector: "node.graph-node-source",
      style: {
        shape: "round-rectangle"
      }
    },
    {
      selector: "node.graph-node-project",
      style: {
        shape: "hexagon"
      }
    },
    {
      selector: "node.graph-node-workflow",
      style: {
        shape: "round-diamond"
      }
    },
    {
      selector: "node.graph-node-isolated",
      style: {
        "border-color": "#c36a43",
        "border-style": "dashed"
      }
    },
    {
      selector: "edge",
      style: {
        "curve-style": "bezier",
        "font-size": 8,
        "line-color": "data(color)",
        opacity: 0.72,
        "overlay-opacity": 0,
        "target-arrow-color": "data(color)",
        "target-arrow-shape": "triangle",
        width: "data(width)"
      }
    },
    {
      selector: "edge.graph-edge-provenance",
      style: {
        "line-style": "dashed"
      }
    },
    {
      selector: "node.graph-selected",
      style: {
        "border-color": "#171715",
        "border-width": 4,
        "font-size": 10.5,
        height: "data(size)",
        label: "data(fullLabel)",
        "min-zoomed-font-size": 0,
        opacity: 1,
        "text-background-opacity": 0.96,
        "text-max-width": "118px",
        width: "data(size)",
        "z-index": 20
      }
    },
    {
      selector: "edge.graph-selected",
      style: {
        "line-color": "#171715",
        opacity: 1,
        "target-arrow-color": "#171715",
        width: 3.2,
        "z-index": 20
      }
    },
    {
      selector: "node.graph-neighbor",
      style: {
        label: "data(label)",
        "min-zoomed-font-size": 0,
        opacity: 1,
        "text-background-opacity": 0.92,
        "text-opacity": 1,
        "z-index": 12
      }
    },
    {
      selector: "edge.graph-neighbor",
      style: {
        opacity: 1,
        "z-index": 12
      }
    },
    {
      selector: "node.graph-faded",
      style: {
        color: "#6c665e",
        "font-size": 8.8,
        label: "data(peekLabel)",
        "min-zoomed-font-size": 6.8,
        opacity: 0.44,
        "text-background-opacity": 0.78,
        "text-max-width": "80px",
        "text-opacity": 1,
        "z-index": 1
      }
    },
    {
      selector: "edge.graph-faded",
      style: {
        opacity: 0.12
      }
    }
  ];

  const projects = $derived(projectsData?.projects ?? []);
  const selectedProject = $derived.by(() =>
    selectedProjectId === null
      ? null
      : projects.find((project) => project.registry_id === selectedProjectId) ?? null
  );
  const objects = $derived(bootstrap?.objects ?? []);
  const relations = $derived(bootstrap?.relations ?? []);
  const auditFindings = $derived(bootstrap?.audit_findings ?? []);
  const objectById = $derived(new Map(objects.map((object) => [object.id, object])));
  const auditFindingsByMemory = $derived.by(() => groupAuditFindingsByMemory(auditFindings));
  const filteredObjects = $derived.by(() =>
    objects.filter((object) => objectMatchesFilters(object))
  );
  const selectedObject = $derived.by(() =>
    selectedObjectId === null ? null : objectById.get(selectedObjectId) ?? null
  );
  const selectedObjectFindings = $derived(
    selectedObject === null ? [] : auditFindingsByMemory.get(selectedObject.id) ?? []
  );
  const graphObjects = $derived.by(() =>
    objects.filter((object) =>
      (graphShowInactive || isCurrentStatus(object.status)) &&
      objectMatchesSearch(object, searchQuery)
    )
  );
  const graphVisibleObjectIds = $derived(new Set(graphObjects.map((object) => object.id)));
  const graphRelations = $derived.by(() =>
    relations.filter((relation) =>
      (graphShowInactive || relation.status === "active") &&
      graphVisibleObjectIds.has(relation.from) &&
      graphVisibleObjectIds.has(relation.to)
    )
  );
  const graphUnlinkedCount = $derived.by(() => {
    const linkedIds = new Set<string>();

    for (const relation of graphRelations) {
      linkedIds.add(relation.from);
      linkedIds.add(relation.to);
    }

    return graphObjects.filter((object) => !linkedIds.has(object.id)).length;
  });
  const graphElements = $derived.by(() => buildGraphElements(graphObjects, graphRelations));
  const selectedGraphObject = $derived.by(() =>
    selectedGraphObjectId === null || !graphVisibleObjectIds.has(selectedGraphObjectId)
      ? null
      : objectById.get(selectedGraphObjectId) ?? null
  );
  const selectedGraphRelation = $derived.by(() =>
    selectedGraphRelationId === null
      ? null
      : graphRelations.find((relation) => relation.id === selectedGraphRelationId) ?? null
  );
  const selectedGraphRelationSource = $derived(
    selectedGraphRelation === null ? null : objectById.get(selectedGraphRelation.from) ?? null
  );
  const selectedGraphRelationTarget = $derived(
    selectedGraphRelation === null ? null : objectById.get(selectedGraphRelation.to) ?? null
  );
  const directRelations = $derived.by(() =>
    selectedObject === null
      ? []
      : relations
          .filter((relation) => relation.from === selectedObject.id || relation.to === selectedObject.id)
          .sort(compareRelations)
  );
  const incomingRelations = $derived.by(() =>
    selectedObject === null
      ? []
      : directRelations.filter((relation) => relation.to === selectedObject.id)
  );
  const outgoingRelations = $derived.by(() =>
    selectedObject === null
      ? []
      : directRelations.filter((relation) => relation.from === selectedObject.id)
  );
  const typeOptions = $derived(uniqueSorted(objects.map((object) => object.type)));
  const facetCategoryOptions = $derived.by(() =>
    FACET_CATEGORIES.filter((category) =>
      objects.some((object) => object.facets?.category === category)
    )
  );
  const statusOptions = $derived(uniqueSorted(objects.map((object) => object.status)));
  const tagOptions = $derived(uniqueSorted(objects.flatMap((object) => object.tags)));
  const markdownBlocks = $derived(
    selectedObject === null ? [] : parseMarkdownBlocks(selectedObject.body)
  );
  const previewMarkdownBlocks = $derived(
    previewData === null ? [] : parseMarkdownBlocks(previewData.context_pack)
  );
  const guidedLenses = $derived(bootstrap?.lenses ?? []);
  const activeGuidedLens = $derived.by(() =>
    guidedLenses.find((lens) => lens.name === activeLensName) ?? guidedLenses[0] ?? null
  );
  const activeLensMarkdownBlocks = $derived(
    activeGuidedLens === null ? [] : parseMarkdownBlocks(activeGuidedLens.markdown)
  );
  const roleCoverage = $derived(bootstrap?.role_coverage ?? emptyRoleCoverage());
  const selectedJson = $derived(
    selectedObject === null ? "" : JSON.stringify(sidecarJsonForObject(selectedObject), null, 2)
  );
  const visibleWarnings = $derived(uniqueSorted([
    ...(bootstrap?.storage_warnings ?? []),
    ...(selectedProject?.warnings ?? []),
    ...warnings
  ]));
  const hasStarterMemoryOnly = $derived.by(() => isStarterMemoryOnly(objects));
  const memorySnapshot = $derived.by(() => buildMemorySnapshot(objects, relations));
  const activeMemoryCount = $derived(objects.filter((object) => isCurrentStatus(object.status)).length);
  const facetCategoryCount = $derived(facetCategoryOptions.length);
  const staleMemoryCount = $derived(objects.filter((object) => object.status === "stale" || object.status === "superseded").length);
  const advisoryMemoryCount = $derived(auditFindingsByMemory.size);
  const maintenanceGroups = $derived.by(() =>
    buildMaintenanceGroups(auditFindings, objectById, relations)
  );
  const trustLabel = $derived.by(() => selectedProject === null ? "No project" : gitLabel(selectedProject));
  const trustDescription = $derived.by(() =>
    selectedProject === null ? "No project is selected." : gitDescription(selectedProject)
  );
  const memorySections = $derived.by(() => buildMemorySections(filteredObjects, objectSort));
  const previewCommandTask = $derived.by(() => previewTask.trim() || (previewData?.task ?? ""));
  const showPreviewCommand = $derived(previewCommandTask.trim() !== "");
  const previewCommand = $derived.by(() => buildPreviewCommand(previewCommandTask, previewMode, previewTokenBudget));
  const docGraphOverview = $derived.by(() => buildDocGraphOverview(graphObjects, graphRelations));
  const docGraphPreviewRelations = $derived(docGraphOverview.relations.slice(0, 3));
  const docGraphOverflowCount = $derived(
    docGraphOverview.hiddenRelationCount + Math.max(0, docGraphOverview.relations.length - docGraphPreviewRelations.length)
  );
  const hasSelectedObject = $derived(selectedObject !== null);
  const memoryScreenActive = $derived(
    bootstrap !== null && (currentScreen === "memories" || currentScreen === "detail")
  );

  onMount(() => {
    void loadProjects();
  });

  onDestroy(() => {
    destroyGraph();
  });

  $effect(() => {
    if (currentScreen !== "graph" || graphContainer === null || bootstrap === null) {
      destroyGraph();
      return;
    }

    renderGraph(graphElements);
    queueMicrotask(() => {
      applyGraphSelection();
    });
  });

  $effect(() => {
    if (currentScreen === "graph") {
      applyGraphSelection();
    }
  });

  function viewerToken(): string {
    const explicitToken = new URLSearchParams(window.location.search).get("token");

    if (explicitToken !== null) {
      return explicitToken;
    }

    return window.location.hostname === "demo.aictx.dev" ? "demo" : "";
  }

  async function loadProjects(): Promise<void> {
    if (token === "") {
      loadState = "error";
      errorMessage = "Viewer API token is missing from the local URL.";
      return;
    }

    try {
      const response = await fetch(`/api/projects?token=${encodeURIComponent(token)}`, {
        headers: { accept: "application/json" }
      });
      const envelope = (await response.json()) as ViewerProjectsEnvelope;

      warnings = envelope.warnings ?? [];

      if (!response.ok || !envelope.ok) {
        loadState = "error";
        errorMessage = envelope.ok
          ? `Viewer API request failed with HTTP ${response.status}.`
          : `${envelope.error.code}: ${envelope.error.message}`;
        return;
      }

      projectsData = envelope.data;
      loadState = "ready";
    } catch (error) {
      loadState = "error";
      errorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  async function loadBootstrap(registryId: string): Promise<void> {
    if (token === "") {
      projectLoadState = "error";
      projectErrorMessage = "Viewer API token is missing from the local URL.";
      return;
    }

    projectLoadState = "loading";
    projectErrorMessage = "";
    bootstrap = null;

    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(registryId)}/bootstrap?token=${encodeURIComponent(token)}`, {
        headers: { accept: "application/json" }
      });
      const envelope = (await response.json()) as ViewerEnvelope;

      warnings = envelope.warnings ?? [];

      if (!response.ok || !envelope.ok) {
        projectLoadState = "error";
        projectErrorMessage = envelope.ok
          ? `Viewer API request failed with HTTP ${response.status}.`
          : `${envelope.error.code}: ${envelope.error.message}`;
        return;
      }

      bootstrap = envelope.data;
      projectLoadState = "ready";
      selectedObjectId = null;
    } catch (error) {
      projectLoadState = "error";
      projectErrorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  async function exportObsidian(): Promise<void> {
    if (isDemoMode) {
      exportState = "error";
      exportErrorCode = "MemoryValidationFailed";
      exportMessage = "The public demo viewer is read-only.";
      return;
    }

    if (selectedProjectId === null) {
      exportState = "error";
      exportErrorCode = "MemoryValidationFailed";
      exportMessage = "Select a project before exporting.";
      return;
    }

    exportState = "running";
    exportMessage = "Exporting Obsidian projection.";
    exportErrorCode = "";
    exportFilesWritten = 0;
    exportManifestPath = "";

    try {
      const trimmedOutDir = exportOutDir.trim();
      const response = await fetch(`/api/projects/${encodeURIComponent(selectedProjectId)}/export/obsidian?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify(trimmedOutDir === "" ? {} : { outDir: trimmedOutDir })
      });
      const envelope = (await response.json()) as ExportEnvelope;

      warnings = uniqueSorted([...warnings, ...(envelope.warnings ?? [])]);

      if (!response.ok || !envelope.ok) {
        exportState = "error";
        exportErrorCode = envelope.ok ? "" : envelope.error.code;
        exportMessage = envelope.ok
          ? `Viewer export request failed with HTTP ${response.status}.`
          : `${envelope.error.code}: ${envelope.error.message}`;
        return;
      }

      exportState = "success";
      exportMessage = "Export complete.";
      exportFilesWritten = envelope.data.files_written.length;
      exportManifestPath = envelope.data.manifest_path;
    } catch (error) {
      exportState = "error";
      exportErrorCode = "MemoryInternalError";
      exportMessage = error instanceof Error ? error.message : String(error);
    }
  }

  async function previewContext(): Promise<void> {
    if (selectedProjectId === null) {
      previewState = "error";
      previewErrorCode = "MemoryValidationFailed";
      previewMessage = "Select a project before previewing context.";
      return;
    }

    const task = previewTask.trim();

    if (task === "") {
      previewState = "error";
      previewErrorCode = "MemoryValidationFailed";
      previewMessage = "Enter a task to preview the context an agent would load.";
      return;
    }

    const parsedBudget = parsePreviewTokenBudget(previewTokenBudget);

    if (!parsedBudget.ok) {
      previewState = "error";
      previewErrorCode = "MemoryValidationFailed";
      previewMessage = parsedBudget.message;
      return;
    }

    previewState = "running";
    previewMessage = "Compiling the same context pack an agent would load.";
    previewErrorCode = "";
    copiedPreviewTarget = null;

    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(selectedProjectId)}/load-preview?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          task,
          mode: previewMode,
          ...(parsedBudget.value === null ? {} : { token_budget: parsedBudget.value })
        })
      });
      const envelope = (await response.json()) as LoadPreviewEnvelope;

      warnings = uniqueSorted([...warnings, ...(envelope.warnings ?? [])]);

      if (!response.ok || !envelope.ok) {
        previewState = "error";
        previewData = null;
        previewErrorCode = envelope.ok ? "" : envelope.error.code;
        previewMessage = envelope.ok
          ? `Viewer load preview request failed with HTTP ${response.status}.`
          : previewErrorMessage(envelope.error.code, envelope.error.message);
        return;
      }

      previewState = "success";
      previewMessage = "Context preview ready.";
      previewData = envelope.data;
    } catch (error) {
      previewState = "error";
      previewData = null;
      previewErrorCode = "MemoryInternalError";
      previewMessage = error instanceof Error ? error.message : String(error);
    }
  }

  async function copyPreview(kind: "command" | "context"): Promise<void> {
    const text = kind === "command" ? previewCommand : previewData?.context_pack ?? "";

    if (text === "") {
      return;
    }

    await navigator.clipboard.writeText(text);
    copiedPreviewTarget = kind;
  }

  function requestProjectDelete(registryId: string): void {
    pendingDeleteProjectId = registryId;
    deleteConfirmText = "";
    projectDeleteMessage = "";
    projectDeleteErrorCode = "";
  }

  function cancelProjectDelete(): void {
    pendingDeleteProjectId = null;
    deleteConfirmText = "";
    projectDeleteErrorCode = "";
  }

  function projectDeleteConfirmationMatches(project: ViewerProjectSummary): boolean {
    return deleteConfirmText.trim() === project.project.id;
  }

  async function deleteProjectMemory(project: ViewerProjectSummary): Promise<void> {
    if (isDemoMode) {
      projectDeleteErrorCode = "MemoryValidationFailed";
      projectDeleteMessage = "The public demo viewer is read-only.";
      return;
    }

    if (!projectDeleteConfirmationMatches(project)) {
      projectDeleteErrorCode = "MemoryValidationFailed";
      projectDeleteMessage = `Type ${project.project.id} to confirm memory deletion.`;
      return;
    }

    deletingProjectId = project.registry_id;
    projectDeleteMessage = `Deleting ${project.project.name} memory.`;
    projectDeleteErrorCode = "";

    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project.registry_id)}?token=${encodeURIComponent(token)}`, {
        method: "DELETE",
        headers: { accept: "application/json" }
      });
      const envelope = (await response.json()) as ProjectDeleteEnvelope;

      warnings = uniqueSorted([...warnings, ...(envelope.warnings ?? [])]);

      if (!response.ok || !envelope.ok) {
        projectDeleteErrorCode = envelope.ok ? "" : envelope.error.code;
        projectDeleteMessage = envelope.ok
          ? `Viewer delete request failed with HTTP ${response.status}.`
          : `${envelope.error.code}: ${envelope.error.message}`;
        return;
      }

      if (selectedProjectId === project.registry_id) {
        clearSelectedProjectAfterDelete();
      }

      pendingDeleteProjectId = null;
      deleteConfirmText = "";
      projectDeleteMessage = projectDeleteSuccessMessage(envelope.data);
      projectDeleteErrorCode = "";
      await loadProjects();
    } catch (error) {
      projectDeleteErrorCode = "MemoryInternalError";
      projectDeleteMessage = error instanceof Error ? error.message : String(error);
    } finally {
      if (deletingProjectId === project.registry_id) {
        deletingProjectId = null;
      }
    }
  }

  function clearSelectedProjectAfterDelete(): void {
    selectedProjectId = null;
    selectedObjectId = null;
    bootstrap = null;
    projectLoadState = "loading";
    currentScreen = "projects";
    objectSort = "type";
    exportState = "idle";
    previewState = "idle";
    previewData = null;
    previewMessage = "";
    previewErrorCode = "";
    selectedGraphObjectId = null;
    selectedGraphRelationId = null;
  }

  function projectDeleteSuccessMessage(data: ViewerProjectDeleteData): string {
    const removedMemory = data.entries_removed.includes(".memory");
    const action = removedMemory
      ? "Deleted .memory and removed the project from the viewer."
      : "Removed the project from the viewer; .memory was already missing.";

    return `${data.project.project.name}: ${action}`;
  }

  function selectProject(registryId: string): void {
    selectedProjectId = registryId;
    selectedObjectId = null;
    searchQuery = "";
    layerFilter = "all";
    typeFilter = allOption;
    facetCategoryFilter = allOption;
    statusFilter = allOption;
    tagFilter = allOption;
    pagePreset = "all";
    objectSort = "type";
    activeLensName = "project-map";
    exportState = "idle";
    previewState = "idle";
    previewData = null;
    previewMessage = "";
    previewErrorCode = "";
    graphShowInactive = false;
    selectedGraphObjectId = null;
    selectedGraphRelationId = null;
    currentScreen = "memories";
    void loadBootstrap(registryId);
  }

  function selectObject(id: string): void {
    if (selectedObjectId === id) {
      selectedObjectId = null;
      return;
    }

    selectedObjectId = id;
    currentScreen = "memories";
    focusMemoryWorkspaceStart();
  }

  function closeSelectedObject(): void {
    selectedObjectId = null;
    focusMemoryWorkspaceStart();
  }

  function focusMemoryWorkspaceStart(): void {
    queueMicrotask(() => {
      memoryWorkspaceElement?.scrollTo({ top: 0, left: 0 });
    });
  }

  function showProjects(): void {
    currentScreen = "projects";
    closeSidebarDrawer();
  }

  function showMemories(): void {
    currentScreen = selectedProjectId === null ? "projects" : "memories";
    closeSidebarDrawer();
  }

  function showGraph(): void {
    if (selectedProjectId === null) {
      showProjects();
      return;
    }

    currentScreen = "graph";
    closeSidebarDrawer();

    if (selectedGraphObjectId === null) {
      selectedGraphObjectId = preferredGraphObjectId();
    }
  }

  function showMaintenance(): void {
    currentScreen = selectedProjectId === null ? "projects" : "maintenance";
    closeSidebarDrawer();
  }

  function showExport(): void {
    if (isDemoMode) {
      showMemories();
      return;
    }

    currentScreen = selectedProjectId === null ? "projects" : "export";
    closeSidebarDrawer();
  }

  function rankedObjects(memoryObjects: MemoryObjectSummary[]): MemoryObjectSummary[] {
    return [...memoryObjects].sort(compareObjectsByRank);
  }

  function compareObjectsByRank(left: MemoryObjectSummary, right: MemoryObjectSummary): number {
    const leftStatus = isCurrentStatus(left.status) ? 0 : 1;
    const rightStatus = isCurrentStatus(right.status) ? 0 : 1;
    if (leftStatus !== rightStatus) {
      return leftStatus - rightStatus;
    }

    const leftType = OBJECT_TYPES.indexOf(left.type);
    const rightType = OBJECT_TYPES.indexOf(right.type);
    if (leftType !== rightType) {
      return leftType - rightType;
    }

    const titleComparison = left.title.localeCompare(right.title);
    return titleComparison === 0 ? left.id.localeCompare(right.id) : titleComparison;
  }

  function sortObjects(memoryObjects: MemoryObjectSummary[], sort: ObjectSort): MemoryObjectSummary[] {
    if (sort === "type") {
      return rankedObjects(memoryObjects);
    }

    return [...memoryObjects].sort((left, right) => {
      const direction = sort === "updated-desc" ? -1 : 1;
      const timestampComparison =
        (updatedAtTimestamp(left.updated_at) - updatedAtTimestamp(right.updated_at)) * direction;

      return timestampComparison === 0 ? compareObjectsByRank(left, right) : timestampComparison;
    });
  }

  function updatedAtTimestamp(value: string): number {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function objectMatchesFilters(object: MemoryObjectSummary): boolean {
    return (
      objectMatchesPagePreset(object, pagePreset) &&
      objectMatchesLayer(object, layerFilter) &&
      optionMatches(typeFilter, object.type) &&
      optionMatches(facetCategoryFilter, object.facets?.category ?? "") &&
      optionMatches(statusFilter, object.status) &&
      (tagFilter === allOption || object.tags.includes(tagFilter)) &&
      objectMatchesSearch(object, searchQuery)
    );
  }

  function objectMatchesPagePreset(object: MemoryObjectSummary, preset: PagePreset): boolean {
    switch (preset) {
      case "all":
        return true;
      case "atomic-memory":
        return object.type !== "source" && object.type !== "synthesis" && isCurrentStatus(object.status);
      case "syntheses":
        return object.type === "synthesis";
      case "sources":
        return object.type === "source";
      case "inactive":
        return object.status === "stale" || object.status === "superseded";
    }
  }

  function objectMatchesSearch(object: MemoryObjectSummary, rawQuery: string): boolean {
    const query = normalizeText(rawQuery);

    if (query === "") {
      return true;
    }

    return normalizeText([
      object.title,
      object.id,
      object.type,
      object.status,
      object.tags.join(" "),
      object.facets?.category ?? "",
      object.evidence.map((evidence) => `${evidence.kind} ${evidence.id}`).join(" "),
      object.origin === null
        ? ""
        : [
            object.origin.kind,
            object.origin.locator,
            object.origin.captured_at ?? "",
            object.origin.digest ?? "",
            object.origin.media_type ?? ""
          ].join(" "),
      object.body
    ].join(" ")).includes(query);
  }

  function objectMatchesLayer(object: MemoryObjectSummary, filter: LayerFilter): boolean {
    switch (filter) {
      case "all":
        return true;
      case "memories":
        return object.type !== "source" && object.type !== "synthesis" && isCurrentStatus(object.status);
      case "syntheses":
        return object.type === "synthesis";
      case "sources":
        return object.type === "source";
      case "inactive":
        return object.status === "stale" || object.status === "superseded";
    }
  }

  function optionMatches(filter: string, value: string): boolean {
    return filter === allOption || filter === value;
  }

  function isCurrentStatus(status: ObjectStatus): boolean {
    return status === "active" || status === "open";
  }

  function normalizeText(value: string): string {
    return value.trim().toLowerCase();
  }

  function selectRelated(id: string): void {
    if (objectById.has(id)) {
      searchQuery = "";
      layerFilter = "all";
      typeFilter = allOption;
      facetCategoryFilter = allOption;
      statusFilter = allOption;
      tagFilter = allOption;
      selectedObjectId = id;
      currentScreen = "memories";
      focusMemoryWorkspaceStart();
    }
  }

  function selectGraphObject(id: string): void {
    if (!objectById.has(id)) {
      return;
    }

    selectedGraphObjectId = id;
    selectedGraphRelationId = null;
    selectedObjectId = id;
  }

  function selectGraphRelation(id: string): void {
    if (!relations.some((relation) => relation.id === id)) {
      return;
    }

    selectedGraphRelationId = id;
    selectedGraphObjectId = null;
  }

  function setGraphShowInactive(showInactive: boolean): void {
    if (graphShowInactive === showInactive) {
      return;
    }

    graphShowInactive = showInactive;
    selectedGraphObjectId = null;
    selectedGraphRelationId = null;
  }

  function preferredGraphObjectId(): string | null {
    if (selectedObjectId !== null && graphVisibleObjectIds.has(selectedObjectId)) {
      return selectedObjectId;
    }

    const degreeById = new Map<string, number>();

    for (const relation of graphRelations) {
      degreeById.set(relation.from, (degreeById.get(relation.from) ?? 0) + 1);
      degreeById.set(relation.to, (degreeById.get(relation.to) ?? 0) + 1);
    }

    return [...graphObjects]
      .sort((left, right) => {
        const degreeComparison = (degreeById.get(right.id) ?? 0) - (degreeById.get(left.id) ?? 0);
        return degreeComparison === 0 ? left.id.localeCompare(right.id) : degreeComparison;
      })[0]?.id ?? null;
  }

  function fitGraph(): void {
    graphInstance?.fit(undefined, 48);
  }

  function zoomGraph(factor: number): void {
    if (graphInstance === null) {
      return;
    }

    const nextZoom = clamp(graphInstance.zoom() * factor, 0.25, 3);

    graphInstance.zoom({
      level: nextZoom,
      renderedPosition: {
        x: graphInstance.width() / 2,
        y: graphInstance.height() / 2
      }
    });
  }

  function resetGraphLayout(): void {
    runGraphLayout(true);
  }

  function focusGraphSelection(): void {
    if (selectedGraphObjectId !== null) {
      focusGraphNode(selectedGraphObjectId, true);
      return;
    }

    if (selectedGraphRelationId !== null) {
      focusGraphEdge(selectedGraphRelationId, true);
    }
  }

  function clearPagePreset(): void {
    pagePreset = "all";
  }

  function relationsForObject(id: string): MemoryRelationSummary[] {
    return relations
      .filter((relation) => relation.from === id || relation.to === id)
      .sort(compareRelations);
  }

  function buildDocGraphOverview(
    memoryObjects: MemoryObjectSummary[],
    relationList: MemoryRelationSummary[]
  ): DocGraphOverview {
    if (memoryObjects.length === 0) {
      return {
        hub: null,
        nodes: [],
        edges: [],
        relations: [],
        hiddenRelationCount: 0
      };
    }

    const objectMap = new Map(memoryObjects.map((object) => [object.id, object]));
    const hubId = preferredGraphObjectId() ?? memoryObjects[0]?.id ?? null;
    const hub = hubId === null ? null : objectMap.get(hubId) ?? null;

    if (hub === null) {
      return {
        hub: null,
        nodes: [],
        edges: [],
        relations: [],
        hiddenRelationCount: 0
      };
    }

    const directRelations = relationList
      .filter((relation) => relation.from === hub.id || relation.to === hub.id)
      .sort((left, right) => {
        const leftTarget = relationTargetLabel(left, hub.id);
        const rightTarget = relationTargetLabel(right, hub.id);
        const targetComparison = leftTarget.localeCompare(rightTarget);
        return targetComparison === 0 ? left.predicate.localeCompare(right.predicate) : targetComparison;
      });
    const relatedObjects = uniqueById(
      directRelations
        .map((relation) => objectMap.get(relationCounterpart(relation, hub.id)) ?? null)
        .filter((object): object is MemoryObjectSummary => object !== null)
    ).slice(0, 6);
    const fillerObjects = rankedObjects(memoryObjects)
      .filter((object) => object.id !== hub.id && !relatedObjects.some((related) => related.id === object.id))
      .slice(0, Math.max(0, 6 - relatedObjects.length));
    const visibleObjects = [hub, ...relatedObjects, ...fillerObjects];
    const positions = docGraphNodePositions(visibleObjects.length);
    const nodePositionById = new Map<string, { x: number; y: number }>();
    const directlyRelatedIds = new Set(relatedObjects.map((object) => object.id));
    const nodes = visibleObjects.map((object, index) => {
      const position = positions[index] ?? { x: 180, y: 100 };
      nodePositionById.set(object.id, position);

      return {
        id: object.id,
        label: graphObjectLabel(object),
        type: object.type,
        color: graphObjectColor(object),
        borderColor: graphObjectBorderColor(object),
        x: position.x,
        y: position.y,
        radius: object.id === hub.id ? 18 : 11,
        hub: object.id === hub.id,
        muted: object.id !== hub.id && !directlyRelatedIds.has(object.id)
      };
    });
    const directEdges = directRelations.filter((relation) => {
      const sourcePosition = nodePositionById.get(relation.from);
      const targetPosition = nodePositionById.get(relation.to);
      return sourcePosition !== undefined && targetPosition !== undefined;
    });
    const edges = directEdges.map((relation) => {
      const sourcePosition = nodePositionById.get(relation.from) ?? { x: 180, y: 100 };
      const targetPosition = nodePositionById.get(relation.to) ?? { x: 180, y: 100 };

      return {
        id: relation.id,
        color: graphRelationColor(relation),
        x1: sourcePosition.x,
        y1: sourcePosition.y,
        x2: targetPosition.x,
        y2: targetPosition.y,
        muted: false
      };
    });

    return {
      hub,
      nodes,
      edges,
      relations: directRelations.slice(0, 4).map((relation) => ({
        id: relation.id,
        predicate: relation.predicate,
        targetLabel: relationTargetLabel(relation, hub.id),
        status: relation.status,
        confidence: relation.confidence
      })),
      hiddenRelationCount: Math.max(0, directRelations.length - 4)
    };
  }

  function docGraphNodePositions(count: number): Array<{ x: number; y: number }> {
    const center = { x: 180, y: 100 };

    if (count <= 1) {
      return [center];
    }

    const slots = [
      { x: 104, y: 62 },
      { x: 256, y: 64 },
      { x: 280, y: 134 },
      { x: 174, y: 154 },
      { x: 80, y: 130 },
      { x: 182, y: 36 }
    ];

    return [center, ...slots.slice(0, count - 1)];
  }

  function uniqueById(memoryObjects: MemoryObjectSummary[]): MemoryObjectSummary[] {
    const seen = new Set<string>();
    const uniqueObjects: MemoryObjectSummary[] = [];

    for (const object of memoryObjects) {
      if (!seen.has(object.id)) {
        uniqueObjects.push(object);
        seen.add(object.id);
      }
    }

    return uniqueObjects;
  }

  function buildGraphElements(
    memoryObjects: MemoryObjectSummary[],
    relationList: MemoryRelationSummary[]
  ): cytoscape.ElementDefinition[] {
    const degreeById = new Map<string, number>();

    for (const relation of relationList) {
      degreeById.set(relation.from, (degreeById.get(relation.from) ?? 0) + 1);
      degreeById.set(relation.to, (degreeById.get(relation.to) ?? 0) + 1);
    }

    return [
      ...memoryObjects.map((object) => {
        const degree = degreeById.get(object.id) ?? 0;

        return {
          group: "nodes" as const,
          classes: graphNodeClasses(object, degree),
          data: {
            id: object.id,
            label: graphObjectLabel(object),
            peekLabel: graphObjectPeekLabel(object),
            fullLabel: graphObjectFullLabel(object),
            type: object.type,
            status: object.status,
            color: graphObjectColor(object),
            borderColor: graphObjectBorderColor(object, degree),
            size: (degree === 0 ? 25 : 29) + Math.min(degree, 8) * 3
          }
        };
      }),
      ...relationList.map((relation) => ({
        group: "edges" as const,
        classes: graphEdgeClasses(relation),
        data: {
          id: relation.id,
          source: relation.from,
          target: relation.to,
          predicate: relation.predicate,
          status: relation.status,
          color: graphRelationColor(relation),
          width: relation.status === "active" ? 1.8 : 1
        }
      }))
    ];
  }

  function renderGraph(elements: cytoscape.ElementDefinition[]): void {
    if (graphContainer === null) {
      return;
    }

    if (graphInstance === null) {
      graphInstance = cytoscape({
        container: graphContainer,
        elements,
        style: graphStyles,
        layout: graphLayoutOptions(true),
        minZoom: 0.25,
        maxZoom: 3,
        boxSelectionEnabled: false
      });
      graphInstance.on("tap", "node", (event: cytoscape.EventObject) => {
        selectGraphObject(event.target.id());
      });
      graphInstance.on("tap", "edge", (event: cytoscape.EventObject) => {
        selectGraphRelation(event.target.id());
      });
      graphInstance.on("tap", (event: cytoscape.EventObject) => {
        if (event.target === graphInstance) {
          selectedGraphObjectId = null;
          selectedGraphRelationId = null;
        }
      });
      return;
    }

    graphInstance.batch(() => {
      graphInstance?.elements().remove();
      graphInstance?.add(elements);
    });
    runGraphLayout(true);
  }

  function destroyGraph(): void {
    graphInstance?.destroy();
    graphInstance = null;
  }

  function graphLayoutOptions(fit: boolean): cytoscape.LayoutOptions {
    return {
      name: "cose",
      animate: false,
      componentSpacing: 132,
      edgeElasticity: 140,
      fit,
      gravity: 0.16,
      idealEdgeLength: 138,
      nodeOverlap: 36,
      nodeRepulsion: 9800,
      numIter: 1200,
      padding: 72,
      randomize: true
    };
  }

  function runGraphLayout(fit: boolean): void {
    if (graphInstance === null) {
      return;
    }

    graphInstance.layout(graphLayoutOptions(fit)).run();
  }

  function applyGraphSelection(): void {
    if (graphInstance === null) {
      return;
    }

    graphInstance.elements().removeClass("graph-selected graph-neighbor graph-faded");

    if (selectedGraphObjectId !== null) {
      const node = graphInstance.getElementById(selectedGraphObjectId);

      if (node.nonempty()) {
        const neighborhood = node.closedNeighborhood();
        node.addClass("graph-selected");
        neighborhood.difference(node).addClass("graph-neighbor");
        graphInstance.elements().difference(neighborhood).addClass("graph-faded");
      }
      return;
    }

    if (selectedGraphRelationId !== null) {
      const edge = graphInstance.getElementById(selectedGraphRelationId);

      if (edge.nonempty()) {
        const neighborhood = edge.connectedNodes().union(edge);
        edge.addClass("graph-selected");
        neighborhood.difference(edge).addClass("graph-neighbor");
        graphInstance.elements().difference(neighborhood).addClass("graph-faded");
      }
    }
  }

  function focusGraphNode(id: string, animate: boolean): void {
    if (graphInstance === null) {
      return;
    }

    const node = graphInstance.getElementById(id);

    if (node.nonempty()) {
      graphInstance.animate({
        center: { eles: node },
        duration: animate ? 260 : 0,
        zoom: Math.max(graphInstance.zoom(), 1.12)
      });
    }
  }

  function focusGraphEdge(id: string, animate: boolean): void {
    if (graphInstance === null) {
      return;
    }

    const edge = graphInstance.getElementById(id);

    if (edge.nonempty()) {
      graphInstance.animate({
        center: { eles: edge.connectedNodes() },
        duration: animate ? 260 : 0,
        zoom: Math.max(graphInstance.zoom(), 1.04)
      });
    }
  }

  function graphObjectLabel(object: MemoryObjectSummary): string {
    const concise = compactGraphTitle(object);
    const words = concise.split(/\s+/).filter(Boolean);

    if (words.length <= 1) {
      return truncateGraphLabel(concise, 18);
    }

    const lines: string[] = [];
    let line = "";

    for (const word of words) {
      const candidate = line === "" ? word : `${line} ${word}`;

      if (candidate.length > 14 && line !== "") {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }

      if (lines.length === 2) {
        break;
      }
    }

    if (line !== "" && lines.length < 2) {
      lines.push(line);
    }

    const label = lines.slice(0, 2).join("\n");
    return truncateGraphLabel(label, 30);
  }

  function graphObjectFullLabel(object: MemoryObjectSummary): string {
    return truncateGraphLabel(object.title.replace(/^Source:\s*/i, ""), 46);
  }

  function graphObjectPeekLabel(object: MemoryObjectSummary): string {
    return truncateGraphLabel(compactGraphTitle(object).replace(/\s+/g, " "), 22);
  }

  function compactGraphTitle(object: MemoryObjectSummary): string {
    const title = object.title.replace(/^Source:\s*/i, "").trim();

    if (object.type !== "source") {
      return title;
    }

    if (!looksLikePathLabel(title)) {
      return title;
    }

    const originLabel = graphOriginLabel(object.origin?.locator ?? title);
    return originLabel === "" ? title : originLabel;
  }

  function looksLikePathLabel(label: string): boolean {
    return /[\\/]/.test(label) || /\.[a-z0-9]{2,8}$/i.test(label);
  }

  function graphOriginLabel(locator: string): string {
    if (/^https?:\/\//i.test(locator)) {
      try {
        const url = new URL(locator);
        const filename = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
        return filename === "" ? url.hostname.replace(/^www\./, "") : filename;
      } catch {
        return locator.replace(/^https?:\/\//i, "").split("/")[0] ?? locator;
      }
    }

    const withoutQuery = locator.split(/[?#]/)[0] ?? locator;
    const segments = withoutQuery.split(/[\\/]/).filter(Boolean);
    const filename = segments.at(-1) ?? withoutQuery.trim();

    if (filename === "") {
      return "";
    }

    return filename.replace(/\.(markdown|mdx?)$/i, ".md");
  }

  function truncateGraphLabel(label: string, maxLength: number): string {
    if (label.length <= maxLength) {
      return label;
    }

    return `${label.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
  }

  function graphObjectColor(object: MemoryObjectSummary): string {
    if (!isCurrentStatus(object.status)) {
      return "#c7c1b8";
    }

    switch (object.type) {
      case "project":
        return "#2f5d62";
      case "architecture":
        return "#8b5e34";
      case "synthesis":
        return "#574b90";
      case "decision":
        return "#9a5b23";
      case "constraint":
        return "#8e3b46";
      case "question":
        return "#5f6c37";
      case "fact":
        return "#356b4f";
      case "workflow":
        return "#3f648c";
      case "gotcha":
        return "#b54708";
      case "source":
        return "#6b6f76";
      case "concept":
        return "#7a5c99";
      case "note":
        return "#6f6259";
      default:
        return "#5f6b65";
    }
  }

  function graphNodeClasses(object: MemoryObjectSummary, degree: number): string {
    return [
      `graph-node-${object.type}`,
      ...(degree === 0 ? ["graph-node-isolated"] : [])
    ].join(" ");
  }

  function graphObjectBorderColor(object: MemoryObjectSummary, degree = 1): string {
    if (degree === 0) {
      return "#c36a43";
    }

    if (object.type === "source") {
      return "#9a968d";
    }

    return isCurrentStatus(object.status) ? "#fffefa" : "#8f8a81";
  }

  function graphRelationColor(relation: MemoryRelationSummary): string {
    if (relation.status !== "active") {
      return "#b9b2a8";
    }

    switch (relation.predicate) {
      case "requires":
      case "depends_on":
        return "#5b6f95";
      case "supersedes":
      case "conflicts_with":
      case "challenges":
        return "#a14a3d";
      case "derived_from":
      case "supports":
      case "summarizes":
      case "documents":
        return "#6b637d";
      case "implements":
        return "#4d745b";
      default:
        return "#78736b";
    }
  }

  function graphEdgeClasses(relation: MemoryRelationSummary): string {
    return relation.predicate === "derived_from" ? "graph-edge-provenance" : "";
  }

  function pageFilter(section: string): void {
    currentScreen = "memories";
    closeSidebarDrawer();
    searchQuery = "";
    typeFilter = allOption;
    facetCategoryFilter = allOption;
    statusFilter = allOption;
    tagFilter = allOption;
    pagePreset = section as PagePreset;

    switch (section) {
      case "overview":
        pagePreset = "all";
        layerFilter = "all";
        break;
      case "atomic-memory":
        layerFilter = "memories";
        break;
      case "syntheses":
        layerFilter = "syntheses";
        break;
      case "sources":
        layerFilter = "sources";
        break;
      case "inactive":
        layerFilter = "inactive";
        break;
      default:
        pagePreset = "all";
        layerFilter = "all";
    }
  }

  function buildMemorySections(
    memoryObjects: MemoryObjectSummary[],
    sort: ObjectSort
  ): MemorySection[] {
    if (sort !== "type") {
      return [
        {
          id: "edited-objects",
          title: sort === "updated-desc" ? "Recently edited objects" : "Oldest edited objects",
          objects: sortObjects(memoryObjects, sort)
        }
      ].filter((section) => section.objects.length > 0);
    }

    return OBJECT_TYPES
      .map((type) => ({
        id: `type-${type}`,
        title: objectTypeLabel(type),
        objects: sortObjects(memoryObjects.filter((object) => object.type === type), sort)
      }))
      .filter((section) => section.objects.length > 0);
  }

  function buildMemorySnapshot(
    memoryObjects: MemoryObjectSummary[],
    relationList: MemoryRelationSummary[]
  ): MemorySnapshotItem[] {
    const reusableCount = memoryObjects.filter((object) =>
      object.type !== "source" && object.type !== "synthesis" && isCurrentStatus(object.status)
    ).length;
    const memoryFacetCategoryCount = uniqueSorted(
      memoryObjects.flatMap((object) => object.facets?.category === undefined ? [] : [object.facets.category])
    ).length;
    const sourceCount = memoryObjects.filter((object) => object.type === "source").length;
    const activeRelationCount = relationList.filter((relation) => relation.status === "active").length;

    return [
      {
        label: "Active objects",
        value: String(reusableCount),
        detail: "canonical non-source records agents can load"
      },
      {
        label: "Facet categories",
        value: String(memoryFacetCategoryCount),
        detail: "typed durable categories represented in storage"
      },
      {
        label: "Provenance trail",
        value: `${sourceCount}/${activeRelationCount}`,
        detail: "source records / active memory links"
      }
    ];
  }

  function bodyPreview(object: MemoryObjectSummary): string {
    const text = object.body
      .replace(/^#+\s+/gm, "")
      .replace(/[`*_>#-]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    return text.length > 190 ? `${text.slice(0, 187)}...` : text;
  }

  function objectTypeLabel(type: ObjectType): string {
    return `${type.charAt(0).toUpperCase()}${type.slice(1)} objects`;
  }

  function facetCategoryLabel(object: MemoryObjectSummary): string {
    return object.facets?.category ?? "no facet category";
  }

  function editedDateLabel(object: MemoryObjectSummary): string {
    return `Edited ${compactIsoDateTime(object.updated_at)}`;
  }

  function compactIsoDateTime(value: string): string {
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
    return match === null ? value : `${match[1]} ${match[2]}`;
  }

  function scopeLabel(scope: Scope): string {
    if (scope.kind === "branch") {
      return `branch:${scope.branch ?? "unknown"}`;
    }

    if (scope.kind === "task") {
      return `task:${scope.task ?? "unknown"}`;
    }

    return "project";
  }

  function emptyRoleCoverage(): RoleCoverageData {
    return {
      roles: [],
      counts: {
        populated: 0,
        thin: 0,
        missing: 0,
        stale: 0,
        conflicted: 0
      }
    };
  }

  function roleStatusClass(status: RoleCoverageStatus): string {
    return `status-${status}`;
  }

  function relationCounterpart(relation: MemoryRelationSummary, objectId: string): string {
    return relation.from === objectId ? relation.to : relation.from;
  }

  function relationObject(relation: MemoryRelationSummary, objectId: string): MemoryObjectSummary | null {
    return objectById.get(relationCounterpart(relation, objectId)) ?? null;
  }

  function relationTargetLabel(relation: MemoryRelationSummary, objectId: string): string {
    const related = relationObject(relation, objectId);

    return related === null ? relationCounterpart(relation, objectId) : related.title;
  }

  function relationStatusLabel(relation: Pick<MemoryRelationSummary, "status" | "confidence">): string {
    return relation.confidence === null
      ? relation.status
      : `${relation.status} / ${relation.confidence} confidence`;
  }

  function groupAuditFindingsByMemory(
    findings: readonly AuditFinding[]
  ): Map<string, AuditFinding[]> {
    const groups = new Map<string, AuditFinding[]>();

    for (const finding of findings) {
      groups.set(finding.memory_id, [...(groups.get(finding.memory_id) ?? []), finding]);
    }

    return groups;
  }

  function buildMaintenanceGroups(
    findings: readonly AuditFinding[],
    memoryObjects: Map<string, MemoryObjectSummary>,
    relationList: readonly MemoryRelationSummary[]
  ): MaintenanceGroup[] {
    return [...groupAuditFindingsByMemory(findings).entries()]
      .map(([memoryId, memoryFindings]) => ({
        memoryId,
        object: memoryObjects.get(memoryId) ?? null,
        findings: [...memoryFindings].sort(compareAuditFindings),
        relations: relationList
          .filter((relation) => relation.from === memoryId || relation.to === memoryId)
          .sort(compareRelations),
        suggestedAction: suggestedMaintenanceAction(memoryFindings)
      }))
      .sort(compareMaintenanceGroups);
  }

  function compareMaintenanceGroups(left: MaintenanceGroup, right: MaintenanceGroup): number {
    return (
      maintenanceSeverityRank(right.findings) - maintenanceSeverityRank(left.findings) ||
      left.memoryId.localeCompare(right.memoryId)
    );
  }

  function maintenanceSeverityRank(findings: readonly AuditFinding[]): number {
    return findings.some((finding) => finding.severity === "warning") ? 1 : 0;
  }

  function compareAuditFindings(left: AuditFinding, right: AuditFinding): number {
    return (
      auditSeverityOrder(left.severity) - auditSeverityOrder(right.severity) ||
      left.rule.localeCompare(right.rule) ||
      left.message.localeCompare(right.message)
    );
  }

  function auditSeverityOrder(severity: AuditSeverity): number {
    return severity === "warning" ? 0 : 1;
  }

  function advisoryLabel(findings: readonly AuditFinding[]): string {
    if (findings.some((finding) => finding.rule === "possibly_stale_changed_reference")) {
      return "possibly stale";
    }

    if (findings.some((finding) => finding.rule === "source_origin_outdated")) {
      return "source changed";
    }

    if (findings.some((finding) => finding.rule === "active_conflict_needs_resolution")) {
      return "conflict";
    }

    if (findings.some((finding) => finding.rule === "referenced_file_missing")) {
      return "missing file";
    }

    return findings.some((finding) => finding.severity === "warning") ? "needs review" : "advisory";
  }

  function suggestedMaintenanceAction(findings: readonly AuditFinding[]): string {
    if (findings.some((finding) => finding.rule === "active_conflict_needs_resolution")) {
      return "Add evidence or create a linked unresolved-conflict question.";
    }

    if (findings.some((finding) => finding.rule === "source_origin_outdated")) {
      return "Refresh the source record and any syntheses derived from it.";
    }

    if (findings.some((finding) => finding.rule === "referenced_file_missing")) {
      return "Update, supersede, or mark stale after checking current files.";
    }

    if (findings.some((finding) => finding.rule === "supersession_chain_needs_review")) {
      return "Review the replacement chain and collapse it when a current replacement is known.";
    }

    if (findings.some((finding) => finding.rule === "possibly_stale_changed_reference")) {
      return "Verify the memory against current code before relying on it.";
    }

    return "Review the audit evidence and repair only if current evidence supports the change.";
  }

  function evidenceLabel(evidence: Evidence): string {
    return `${evidence.kind}:${evidence.id}`;
  }

  function parsePreviewTokenBudget(raw: string): { ok: true; value: number | null } | { ok: false; message: string } {
    const trimmed = raw.trim();

    if (trimmed === "") {
      return { ok: true, value: null };
    }

    const value = Number(trimmed);

    if (!Number.isSafeInteger(value) || value <= 500) {
      return { ok: false, message: "Token budget must be an integer greater than 500." };
    }

    return { ok: true, value };
  }

  function previewErrorMessage(code: string, message: string): string {
    if (code === "MemoryIndexUnavailable") {
      return `${code}: ${message} Run memory rebuild, then preview again.`;
    }

    return `${code}: ${message}`;
  }

  function buildPreviewCommand(task: string, mode: LoadMemoryMode, tokenBudget: string): string {
    const parts = ["memory", "load", shellQuote(task.trim())];

    if (mode !== "coding") {
      parts.push("--mode", mode);
    }

    const parsedBudget = parsePreviewTokenBudget(tokenBudget);

    if (parsedBudget.ok && parsedBudget.value !== null) {
      parts.push("--token-budget", String(parsedBudget.value));
    }

    return parts.join(" ");
  }

  function shellQuote(value: string): string {
    return `"${value.replace(/["\\$`]/g, "\\$&")}"`;
  }

  function previewSourceLabel(source: LoadMemorySource): string {
    if (!source.git_available) {
      return `${source.project}, Git unavailable`;
    }

    return `${source.project}, ${source.branch ?? "detached HEAD"}@${source.commit ?? "unknown commit"}`;
  }

  function gitLabel(project: ViewerProjectSummary): string {
    if (!project.available) {
      return "Unavailable";
    }

    if (project.git === null || !project.git.available) {
      return "No Git";
    }

    if (project.git.dirty === true) {
      return "Uncommitted memory";
    }

    if (project.git.dirty === false) {
      return "Committed memory";
    }

    return "Git available";
  }

  function gitDescription(project: ViewerProjectSummary): string {
    if (!project.available) {
      return "This registered memory root is unavailable.";
    }

    if (project.git === null || !project.git.available) {
      return "Git status is unavailable for this memory root.";
    }

    if (project.git.dirty === true) {
      return "There are uncommitted changes under this memory root. Use memory diff or Git before treating it as committed team state.";
    }

    if (project.git.dirty === false) {
      return "The memory root has no uncommitted Git changes.";
    }

    return "Git is available, but dirty state is unknown.";
  }

  function countLabel(count: number, singular: string, plural: string): string {
    return `${count} ${count === 1 ? singular : plural}`;
  }

  function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  function uniqueSorted(values: string[]): string[] {
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
  }

  function compareRelations(left: MemoryRelationSummary, right: MemoryRelationSummary): number {
    return left.id.localeCompare(right.id);
  }

  function isStarterMemoryOnly(memoryObjects: readonly MemoryObjectSummary[]): boolean {
    if (memoryObjects.length !== 2) {
      return false;
    }

    const projectObject = memoryObjects.find(
      (object) => object.type === "project" && object.source?.kind === "system"
    );
    const architectureObject = memoryObjects.find(
      (object) => object.id === "architecture.current" && object.source?.kind === "system"
    );

    return (
      projectObject !== undefined &&
      architectureObject !== undefined &&
      /^# .+\n\nProject-level memory for .+\.$/.test(normalizeBody(projectObject.body)) &&
      normalizeBody(architectureObject.body) ===
        "# Current Architecture\n\nArchitecture memory starts here."
    );
  }

  function normalizeBody(body: string): string {
    return body.replace(/\r\n?/g, "\n").trim();
  }

  function sidecarJsonForObject(object: MemoryObjectSummary): Record<string, unknown> {
    return {
      id: object.id,
      type: object.type,
      status: object.status,
      title: object.title,
      body_path: object.body_path,
      json_path: object.json_path,
      scope: object.scope,
      tags: object.tags,
      facets: object.facets,
      evidence: object.evidence,
      source: object.source,
      origin: object.origin,
      superseded_by: object.superseded_by,
      created_at: object.created_at,
      updated_at: object.updated_at
    };
  }

  function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
    const blocks: MarkdownBlock[] = [];
    const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
    let paragraph: string[] = [];
    let list: string[] = [];
    let quote: string[] = [];
    let code: string[] | null = null;

    const flushParagraph = (): void => {
      if (paragraph.length > 0) {
        blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
        paragraph = [];
      }
    };
    const flushList = (): void => {
      if (list.length > 0) {
        blocks.push({ kind: "list", items: list });
        list = [];
      }
    };
    const flushQuote = (): void => {
      if (quote.length > 0) {
        blocks.push({ kind: "quote", text: quote.join(" ") });
        quote = [];
      }
    };
    const flushLooseBlocks = (): void => {
      flushParagraph();
      flushList();
      flushQuote();
    };

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();

      if (line.startsWith("```")) {
        if (code === null) {
          flushLooseBlocks();
          code = [];
        } else {
          blocks.push({ kind: "code", text: code.join("\n") });
          code = null;
        }
        continue;
      }

      if (code !== null) {
        code.push(rawLine);
        continue;
      }

      if (line.trim() === "") {
        flushLooseBlocks();
        continue;
      }

      const heading = /^(#{1,3})\s+(.+)$/.exec(line);
      if (heading !== null) {
        flushLooseBlocks();
        blocks.push({
          kind: "heading",
          level: Math.min(heading[1].length, 3) as 1 | 2 | 3,
          text: heading[2]
        });
        continue;
      }

      const listItem = /^\s*[-*]\s+(.+)$/.exec(line);
      if (listItem !== null) {
        flushParagraph();
        flushQuote();
        list.push(listItem[1]);
        continue;
      }

      const quoteLine = /^\s*>\s?(.+)$/.exec(line);
      if (quoteLine !== null) {
        flushParagraph();
        flushList();
        quote.push(quoteLine[1]);
        continue;
      }

      flushList();
      flushQuote();
      paragraph.push(line.trim());
    }

    if (code !== null) {
      blocks.push({ kind: "code", text: code.join("\n") });
    }

    flushLooseBlocks();
    return blocks;
  }

  function toggleSidebarDrawer(): void {
    sidebarDrawerOpen = !sidebarDrawerOpen;
  }

  function closeSidebarDrawer(): void {
    sidebarDrawerOpen = false;
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && sidebarDrawerOpen) {
      closeSidebarDrawer();
    }
  }
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<main class="viewer-shell" aria-labelledby="viewer-title">
  {#if loadState === "loading"}
    <section class="system-panel" aria-live="polite">
      <p class="eyebrow">Memory local viewer</p>
      <h1 id="viewer-title">Memory Viewer</h1>
      <p>Loading memory from the local viewer API.</p>
    </section>
  {:else if loadState === "error"}
    <section class="system-panel error-panel" role="alert">
      <p class="eyebrow">Memory local viewer</p>
      <h1 id="viewer-title">Memory Viewer</h1>
      <h2>Viewer failed to load</h2>
      <p>{errorMessage}</p>
    </section>
  {:else if projectsData !== null}
    <button
      type="button"
      class="sidebar-toggle"
      class:open={sidebarDrawerOpen}
      aria-label={sidebarDrawerOpen ? "Close menu" : "Open menu"}
      aria-expanded={sidebarDrawerOpen}
      aria-controls="viewer-sidebar-drawer"
      onclick={toggleSidebarDrawer}
      data-testid="sidebar-menu-toggle"
    >
      <span class="burger-icon" aria-hidden="true"></span>
      <span>{sidebarDrawerOpen ? "Close menu" : "Menu"}</span>
    </button>

    {#if sidebarDrawerOpen}
      <button
        type="button"
        class="sidebar-backdrop"
        aria-label="Dismiss menu"
        onclick={closeSidebarDrawer}
        data-testid="sidebar-backdrop"
      ></button>
    {/if}

    {#if sidebarDrawerOpen}
    <aside id="viewer-sidebar-drawer" class="sidebar" aria-label="Viewer navigation" data-testid="viewer-sidebar-drawer">
      <div class="brand">
        <div class="brand-row">
          <img class="book-icon" src="/favicon.svg" width="28" height="28" alt="" aria-hidden="true" />
          <h1 id="viewer-title">Memory Schema</h1>
        </div>
        <p>{selectedProject?.project.name ?? "No project selected"} · {selectedProject?.project.id ?? "local memory"}</p>
      </div>

      <div class="sidebar-menu open">
        {#if bootstrap !== null}
          <dl class="sidebar-stats" aria-label="Memory schema stats">
            <div><dt>{activeMemoryCount}</dt><dd>active</dd></div>
            <div><dt>{relations.length}</dt><dd>links</dd></div>
            <div><dt>{facetCategoryCount}</dt><dd>facets</dd></div>
            <div><dt>{advisoryMemoryCount}</dt><dd>review</dd></div>
          </dl>
        {/if}

        <label class="sidebar-search">
          <span>Search storage</span>
          <input
            type="search"
            bind:value={searchQuery}
            placeholder="oauth, schema, cron..."
            autocomplete="off"
            data-testid="viewer-search"
          />
        </label>

        <nav class="nav-list" aria-label="Memory schema views">
          <section class="nav-section" aria-labelledby="workspace-pages-heading">
            <p class="nav-heading" id="workspace-pages-heading">Workspace</p>
            <button
              type="button"
              class:active={currentScreen === "projects"}
              aria-current={currentScreen === "projects" ? "page" : undefined}
              data-testid="nav-projects"
              onclick={showProjects}
            >
              <span class="nav-row-icon" aria-hidden="true">⌂</span>
              <span>Projects</span>
            </button>
            <button
              type="button"
              class:active={currentScreen === "memories" || currentScreen === "detail"}
              aria-current={currentScreen === "memories" || currentScreen === "detail" ? "page" : undefined}
              data-testid="nav-memories"
              disabled={selectedProjectId === null}
              onclick={showMemories}
            >
              <span class="nav-row-icon" aria-hidden="true">#</span>
              <span>Schema Browser</span>
            </button>
            <button
              type="button"
              class:active={currentScreen === "graph"}
              aria-current={currentScreen === "graph" ? "page" : undefined}
              data-testid="nav-graph"
              disabled={selectedProjectId === null}
              onclick={showGraph}
            >
              <span class="nav-row-icon" aria-hidden="true">◎</span>
              <span>Graph</span>
            </button>
            <button
              type="button"
              class:active={currentScreen === "maintenance"}
              aria-current={currentScreen === "maintenance" ? "page" : undefined}
              data-testid="nav-maintenance"
              disabled={selectedProjectId === null}
              onclick={showMaintenance}
            >
              <span class="nav-row-icon" aria-hidden="true">!</span>
              <span>Maintenance</span>
            </button>
            {#if !isDemoMode}
              <button
                type="button"
                class:active={currentScreen === "export"}
                aria-current={currentScreen === "export" ? "page" : undefined}
                data-testid="nav-export"
                disabled={selectedProjectId === null}
                onclick={showExport}
              >
                <span class="nav-row-icon" aria-hidden="true">↗</span>
                <span>Export</span>
              </button>
            {/if}
          </section>

          <section class="nav-section" aria-labelledby="memory-views-heading">
            <p class="nav-heading" id="memory-views-heading">Schema views</p>
            <button type="button" class:active={pagePreset === "all"} onclick={() => pageFilter("overview")}>
              <span class="nav-row-icon" aria-hidden="true">≡</span>
              <span>All objects</span>
            </button>
            <button type="button" class:active={pagePreset === "atomic-memory"} onclick={() => pageFilter("atomic-memory")}>
              <span class="nav-row-icon" aria-hidden="true">#</span>
              <span>Atomic memory</span>
            </button>
            <button type="button" class:active={pagePreset === "syntheses"} onclick={() => pageFilter("syntheses")}>
              <span class="nav-row-icon" aria-hidden="true">S</span>
              <span>Syntheses</span>
            </button>
            <button type="button" class:active={pagePreset === "sources"} onclick={() => pageFilter("sources")}>
              <span class="nav-row-icon" aria-hidden="true">R</span>
              <span>Sources</span>
            </button>
            <button type="button" class:active={pagePreset === "inactive"} onclick={() => pageFilter("inactive")}>
              <span class="nav-row-icon" aria-hidden="true">!</span>
              <span>Inactive</span>
            </button>
          </section>
        </nav>

        {#if !isDemoMode}
          <details class="sidebar-export">
            <summary>Obsidian export</summary>
            <button
              type="button"
              onclick={() => window.print()}
            >
              Print/PDF
            </button>
            <label class="obsidian-field">
              <span>Obsidian vault</span>
              <input
                type="text"
                bind:value={exportOutDir}
                placeholder=".memory/exports/obsidian"
                autocomplete="off"
              />
            </label>
            <button
              type="button"
              disabled={exportState === "running" || selectedProjectId === null}
              onclick={() => void exportObsidian()}
            >
              {exportState === "running" ? "Exporting" : "Export Obsidian"}
            </button>
          </details>
        {/if}
      </div>
    </aside>
    {/if}

    <section
      class={`main-stage ${memoryScreenActive ? "memory-stage" : ""} ${hasSelectedObject ? "has-selected-object" : ""}`}
      aria-label="Read-only memory browser"
    >
      {#if currentScreen === "projects"}
        <section class="projects-page" aria-labelledby="projects-title" data-testid="projects-view">
          <header class="page-header">
            <p class="eyebrow">Registered memory roots</p>
            <h2 id="projects-title">Projects</h2>
            <p>{countLabel(projects.length, "registered project", "registered projects")}</p>
          </header>

          {#if projectDeleteMessage !== ""}
            <section
              class:error={projectDeleteErrorCode !== ""}
              class:success={projectDeleteErrorCode === ""}
              class="project-delete-status"
              role={projectDeleteErrorCode === "" ? "status" : "alert"}
              aria-live="polite"
              data-testid="project-delete-status"
            >
              <p>{projectDeleteMessage}</p>
              {#if projectDeleteErrorCode !== ""}
                <p class="mono">{projectDeleteErrorCode}</p>
              {/if}
            </section>
          {/if}

          <div class="project-grid" data-testid="project-list">
            {#each projects as project (project.registry_id)}
              <article
                class:unavailable={!project.available}
                class:current={project.current}
                class="project-card"
                data-testid={`project-card-${project.registry_id}`}
              >
                <div class="card-topline">
                  <span>{project.current ? "Current" : project.source}</span>
                  <strong>{gitLabel(project)}</strong>
                </div>
                <h3>{project.project.name}</h3>
                <p class="mono">{project.project.id}</p>
                <p class="path">{project.project_root}</p>
                <dl class="mini-stats">
                  <div><dt>Memories</dt><dd>{project.counts?.objects ?? 0}</dd></div>
                  <div><dt>Relations</dt><dd>{project.counts?.relations ?? 0}</dd></div>
                  <div><dt>Syntheses</dt><dd>{project.counts?.synthesis_objects ?? 0}</dd></div>
                </dl>
                {#if project.warnings.length > 0}
                  <p class="warning-copy">{project.warnings[0]}</p>
                {/if}
                <div class="project-card-actions">
                  <button
                    type="button"
                    class="primary-action"
                    disabled={!project.available || deletingProjectId === project.registry_id}
                    onclick={() => selectProject(project.registry_id)}
                    data-testid={`project-open-${project.registry_id}`}
                  >
                    Open project
                  </button>
                  {#if !isDemoMode}
                    <button
                      type="button"
                      class="danger-action"
                      disabled={deletingProjectId !== null}
                      onclick={() => requestProjectDelete(project.registry_id)}
                      data-testid={`project-delete-${project.registry_id}`}
                    >
                      Delete memory
                    </button>
                  {/if}
                </div>
                {#if !isDemoMode && pendingDeleteProjectId === project.registry_id}
                  <section class="project-delete-confirm" aria-label={`Confirm memory deletion for ${project.project.name}`}>
                    <p>
                      Delete this project's <code>.memory</code> memory directory and unregister it from the viewer.
                      Source files in <span class="mono">{project.project_root}</span> remain.
                    </p>
                    <label class="field">
                      <span>Type <strong>{project.project.id}</strong> to confirm</span>
                      <input
                        type="text"
                        bind:value={deleteConfirmText}
                        autocomplete="off"
                        disabled={deletingProjectId === project.registry_id}
                        data-testid={`project-delete-confirm-${project.registry_id}`}
                      />
                    </label>
                    <div class="project-card-actions">
                      <button
                        type="button"
                        class="danger-action solid"
                        disabled={!projectDeleteConfirmationMatches(project) || deletingProjectId === project.registry_id}
                        onclick={() => void deleteProjectMemory(project)}
                        data-testid={`project-delete-submit-${project.registry_id}`}
                      >
                        {deletingProjectId === project.registry_id ? "Deleting" : "Delete .memory"}
                      </button>
                      <button
                        type="button"
                        class="ghost-action"
                        disabled={deletingProjectId === project.registry_id}
                        onclick={cancelProjectDelete}
                        data-testid={`project-delete-cancel-${project.registry_id}`}
                      >
                        Cancel
                      </button>
                    </div>
                  </section>
                {/if}
              </article>
            {:else}
              <section class="empty-panel" data-testid="empty-projects">
                <h3>No projects registered</h3>
                <p>Run <code>memory projects add</code> inside an initialized project.</p>
                <p class="mono">{projectsData.registry_path}</p>
              </section>
            {/each}
          </div>
        </section>
      {:else if projectLoadState === "error"}
        <section class="system-panel error-panel" role="alert" data-testid="project-load-error">
          <p class="eyebrow">Memory local viewer</p>
          <h2>Project failed to load</h2>
          <p>{projectErrorMessage}</p>
          <button type="button" class="ghost-action" onclick={showProjects}>Back to projects</button>
        </section>
      {:else if projectLoadState === "loading" || bootstrap === null}
        <section class="system-panel" aria-live="polite" data-testid="project-loading">
          <p class="eyebrow">Memory local viewer</p>
          <h2>Loading project</h2>
          <p>{selectedProject?.project.name ?? "Selected project"}</p>
        </section>
      {:else if currentScreen === "graph"}
        <article class="graph-page" aria-labelledby="graph-title" data-testid="graph-view">
          <header class="page-header compact">
            <div>
              <p class="eyebrow">Relation map</p>
              <h2 id="graph-title">Graph</h2>
            </div>
            <dl class="graph-counts" aria-label="Visible graph counts">
              <div><dt>Nodes</dt><dd data-testid="graph-node-count">{graphObjects.length}</dd></div>
              <div><dt>Links</dt><dd data-testid="graph-relation-count">{graphRelations.length}</dd></div>
              <div><dt>Unlinked</dt><dd data-testid="graph-unlinked-count">{graphUnlinkedCount}</dd></div>
            </dl>
          </header>

          <section class="graph-panel">
            <div class="graph-toolbar" aria-label="Graph controls">
              <div class="graph-filter-tabs" role="group" aria-label="Graph item scope">
                <button
                  type="button"
                  class:active={!graphShowInactive}
                  onclick={() => setGraphShowInactive(false)}
                  data-testid="graph-filter-current"
                >
                  Current
                </button>
                <button
                  type="button"
                  class:active={graphShowInactive}
                  onclick={() => setGraphShowInactive(true)}
                  data-testid="graph-filter-all"
                >
                  All
                </button>
              </div>
              <div class="graph-actions">
                <button type="button" aria-label="Zoom in" title="Zoom in" onclick={() => zoomGraph(1.18)} data-testid="graph-zoom-in">+</button>
                <button type="button" aria-label="Zoom out" title="Zoom out" onclick={() => zoomGraph(0.84)} data-testid="graph-zoom-out">-</button>
                <button type="button" aria-label="Fit graph" title="Fit graph" onclick={fitGraph} data-testid="graph-fit">Fit</button>
                <button type="button" aria-label="Reset graph layout" title="Reset graph layout" onclick={resetGraphLayout} data-testid="graph-reset-layout">↺</button>
                <button
                  type="button"
                  aria-label="Focus selected graph item"
                  title="Focus selected graph item"
                  disabled={selectedGraphObject === null && selectedGraphRelation === null}
                  onclick={focusGraphSelection}
                  data-testid="graph-focus-selected"
                >
                  ◎
                </button>
              </div>
            </div>
            <div class="graph-legend" aria-label="Graph legend" data-testid="graph-legend">
              <div class="graph-legend-group">
                {#each graphTypeLegend as item (item.label)}
                  <span class="graph-legend-item">
                    <span
                      class="graph-legend-node"
                      style={`--legend-color: ${item.color}; --legend-border: ${item.borderColor}`}
                      aria-hidden="true"
                    ></span>
                    {item.label}
                  </span>
                {/each}
                <span class="graph-legend-item">
                  <span class="graph-legend-node unlinked" aria-hidden="true"></span>
                  Unlinked
                </span>
              </div>
              <div class="graph-legend-group">
                {#each graphRelationLegend as item (item.label)}
                  <span class="graph-legend-item">
                    <span
                      class:dashed={item.lineStyle === "dashed"}
                      class="graph-legend-line"
                      style={`--legend-color: ${item.color}`}
                      aria-hidden="true"
                    ></span>
                    {item.label}
                  </span>
                {/each}
              </div>
            </div>

            <section class="graph-workspace">
              <div class="graph-canvas-wrap">
                <div
                  class="graph-canvas"
                  bind:this={graphContainer}
                  aria-label="Memory relation graph"
                  data-testid="relation-graph"
                ></div>
                {#if graphObjects.length === 0}
                  <div class="graph-empty" data-testid="graph-empty">
                    <h3>No visible graph nodes</h3>
                    <p>Clear search or show all memory.</p>
                  </div>
                {/if}
              </div>

              <aside class="graph-inspector" aria-label="Graph selection" data-testid="graph-inspector">
                {#if selectedGraphObject !== null}
                  <section>
                    <p class="eyebrow">Selected object</p>
                    <h3>{selectedGraphObject.title}</h3>
                    <p class="mono">{selectedGraphObject.id}</p>
                    <dl class="graph-meta">
                      <div><dt>Type</dt><dd>{selectedGraphObject.type}</dd></div>
                      <div><dt>Status</dt><dd>{selectedGraphObject.status}</dd></div>
                      <div><dt>Facet</dt><dd>{facetCategoryLabel(selectedGraphObject)}</dd></div>
                      <div><dt>Relations</dt><dd>{relationsForObject(selectedGraphObject.id).length}</dd></div>
                      <div><dt>Graph</dt><dd>{relationsForObject(selectedGraphObject.id).length === 0 ? "Unlinked" : "Linked"}</dd></div>
                    </dl>
                    <p class="graph-body-preview">{bodyPreview(selectedGraphObject)}</p>
                    <div class="graph-inspector-actions">
                      <button type="button" onclick={() => selectRelated(selectedGraphObject.id)}>
                        Open in schema browser
                      </button>
                      <button type="button" onclick={focusGraphSelection}>Focus node</button>
                    </div>
                    <details class="graph-relations" open>
                      <summary>Direct relations</summary>
                      <ul class="relation-list">
                        {#each graphRelations.filter((relation) => relation.from === selectedGraphObject.id || relation.to === selectedGraphObject.id) as relation (relation.id)}
                          <li>
                            <span class="pill">{relation.predicate}</span>
                            <button type="button" onclick={() => selectGraphRelation(relation.id)}>
                              {relationTargetLabel(relation, selectedGraphObject.id)}
                            </button>
                            <small>{relationStatusLabel(relation)}</small>
                          </li>
                        {:else}
                          <li class="empty-copy">No visible related memories.</li>
                        {/each}
                      </ul>
                    </details>
                  </section>
                {:else if selectedGraphRelation !== null}
                  <section>
                    <p class="eyebrow">Selected relation</p>
                    <h3>{selectedGraphRelation.predicate}</h3>
                    <p class="mono">{selectedGraphRelation.id}</p>
                    <dl class="graph-meta">
                      <div><dt>Status</dt><dd>{selectedGraphRelation.status}</dd></div>
                      <div><dt>Confidence</dt><dd>{selectedGraphRelation.confidence ?? "not set"}</dd></div>
                      <div><dt>Source</dt><dd>{selectedGraphRelationSource?.title ?? selectedGraphRelation.from}</dd></div>
                      <div><dt>Target</dt><dd>{selectedGraphRelationTarget?.title ?? selectedGraphRelation.to}</dd></div>
                    </dl>
                    <div class="graph-inspector-actions">
                      <button type="button" onclick={() => selectGraphObject(selectedGraphRelation.from)}>
                        Source node
                      </button>
                      <button type="button" onclick={() => selectGraphObject(selectedGraphRelation.to)}>
                        Target node
                      </button>
                      <button type="button" onclick={focusGraphSelection}>Focus link</button>
                    </div>
                  </section>
                {:else}
                  <section class="graph-empty-selection">
                    <p class="eyebrow">Selection</p>
                    <h3>{graphObjects.length} visible objects</h3>
                    <p>{graphRelations.length} visible relation links. {graphUnlinkedCount} unlinked {graphUnlinkedCount === 1 ? "node" : "nodes"} use dashed rims.</p>
                  </section>
                {/if}
              </aside>
            </section>
          </section>
        </article>
      {:else if currentScreen === "maintenance"}
        <article class="maintenance-page" aria-labelledby="maintenance-title" data-testid="maintenance-view">
          <header class="page-header compact">
            <div>
              <p class="eyebrow">Review queue</p>
              <h2 id="maintenance-title">Maintenance</h2>
              <p>
                {auditFindings.length} audit findings across {advisoryMemoryCount} memories. Possible staleness is advisory; repair memory only after checking current evidence.
              </p>
            </div>
            <dl class="graph-counts" aria-label="Maintenance counts">
              <div><dt>Review</dt><dd>{advisoryMemoryCount}</dd></div>
              <div><dt>Findings</dt><dd>{auditFindings.length}</dd></div>
              <div><dt>Inactive</dt><dd>{staleMemoryCount}</dd></div>
            </dl>
          </header>

          <section class="maintenance-list" aria-label="Audit findings by memory">
            {#each maintenanceGroups as group (group.memoryId)}
              <article class="maintenance-card" data-testid={`maintenance-card-${group.memoryId}`}>
                <div class="maintenance-card-header">
                  <div>
                    <p class="eyebrow">{advisoryLabel(group.findings)}</p>
                    <h3>{group.object?.title ?? group.memoryId}</h3>
                    <p class="mono">{group.memoryId}</p>
                  </div>
                  {#if group.object !== null}
                    <button type="button" class="ghost-action" onclick={() => selectRelated(group.memoryId)}>
                      Open object
                    </button>
                  {/if}
                </div>
                <p class="maintenance-action">{group.suggestedAction}</p>
                <ul class="maintenance-findings">
                  {#each group.findings as finding (`${finding.rule}-${finding.message}`)}
                    <li>
                      <span class={`advisory-badge ${finding.severity}`}>{finding.severity}</span>
                      <strong>{finding.rule}</strong>
                      <p>{finding.message}</p>
                      <small>
                        {#each finding.evidence.slice(0, 6) as evidence, index (`${finding.rule}-${evidence.kind}-${evidence.id}-${index}`)}
                          <code>{evidenceLabel(evidence)}</code>
                        {/each}
                      </small>
                    </li>
                  {/each}
                </ul>
                {#if group.relations.length > 0}
                  <details class="notion-toggle">
                    <summary>Relation chain</summary>
                    <ul class="relation-list">
                      {#each group.relations as relation (relation.id)}
                        <li>
                          <span class="pill">{relation.predicate}</span>
                          <button type="button" onclick={() => selectRelated(relationCounterpart(relation, group.memoryId))}>
                            {relationTargetLabel(relation, group.memoryId)}
                          </button>
                          <small>{relationStatusLabel(relation)}</small>
                        </li>
                      {/each}
                    </ul>
                  </details>
                {/if}
              </article>
            {:else}
              <section class="empty-panel" data-testid="maintenance-empty">
                <h3>No audit findings</h3>
                <p>Current deterministic checks do not flag stale, conflicting, or weakly evidenced memory.</p>
              </section>
            {/each}
          </section>
        </article>
      {:else if currentScreen === "export" && !isDemoMode}
        <section class="export-page" aria-labelledby="export-title" data-testid="export-view">
          <header class="page-header compact">
            <p class="eyebrow">Generated projection</p>
            <h2 id="export-title">Obsidian Export</h2>
            <p>Write the current project memory into a linked vault-shaped projection.</p>
          </header>

          <form
            class="export-form"
            aria-label="Obsidian export"
            onsubmit={(event) => {
              event.preventDefault();
              void exportObsidian();
            }}
          >
            <label class="field">
              <span>Output directory</span>
              <input
                type="text"
                bind:value={exportOutDir}
                placeholder=".memory/exports/obsidian"
                autocomplete="off"
                disabled={exportState === "running"}
                data-testid="obsidian-export-out-dir"
              />
            </label>
            <button
              type="submit"
              class="primary-action"
              disabled={exportState === "running"}
              data-testid="obsidian-export-submit"
            >
              {exportState === "running" ? "Exporting" : "Export Obsidian"}
            </button>
            {#if exportState !== "idle"}
              <section
                class:error={exportState === "error"}
                class:success={exportState === "success"}
                class="export-status"
                role={exportState === "error" ? "alert" : "status"}
                aria-live="polite"
                data-testid="obsidian-export-status"
              >
                <p>{exportMessage}</p>
                {#if exportState === "error" && exportErrorCode !== ""}
                  <p class="mono">{exportErrorCode}</p>
                {/if}
                {#if exportState === "success"}
                  <dl class="mini-stats">
                    <div><dt>Files written</dt><dd data-testid="obsidian-export-files-written">{exportFilesWritten}</dd></div>
                    <div><dt>Manifest</dt><dd data-testid="obsidian-export-manifest-path">{exportManifestPath}</dd></div>
                  </dl>
                {/if}
              </section>
            {/if}
          </form>
        </section>
      {:else}
        <article
          class={`memory-page ${hasSelectedObject ? "has-selected-object" : ""}`}
          aria-labelledby="memory-list-title"
          data-testid="memory-list-view"
        >
          <header class="doc-hero">
            <img class="doc-icon" src="/favicon.svg" width="46" height="46" alt="" aria-hidden="true" />
            <p class="eyebrow">Canonical Memory storage</p>
            <h2 id="memory-list-title">{bootstrap.project.name} Memory Schema</h2>
            <p>
              Browse the real object types, facet categories, statuses, scopes, evidence, and relations
              saved in this project's local memory database.
            </p>
          </header>

          <section class="list-controls" aria-label="Memory list controls">
            <div class="list-controls-heading">
              <div>
                <strong>Canonical objects</strong>
                <span>
                  {filteredObjects.length} rows · {objects.length} objects · {facetCategoryCount} facets · {relations.length} links
                </span>
              </div>
              <p class="projection-status" role="status">
                <span>{trustLabel}</span> {trustDescription}
              </p>
            </div>
            <div class="controls-row">
              <div class="layer-tabs" role="group" aria-label="Memory layers">
                {#each layerOptions as option (option.value)}
                  <button
                    type="button"
                    class:active={layerFilter === option.value}
                    onclick={() => {
                      clearPagePreset();
                      layerFilter = option.value;
                    }}
                    data-testid={`viewer-layer-${option.value}`}
                  >
                    {option.label}
                  </button>
                {/each}
              </div>
              <select bind:value={typeFilter} onchange={clearPagePreset} data-testid="viewer-type-filter" aria-label="Type">
                <option value={allOption}>All types</option>
                {#each typeOptions as type (type)}
                  <option value={type}>{type}</option>
                {/each}
              </select>
              <select bind:value={facetCategoryFilter} onchange={clearPagePreset} data-testid="viewer-facet-filter" aria-label="Facet category">
                <option value={allOption}>All facets</option>
                {#each facetCategoryOptions as category (category)}
                  <option value={category}>{category}</option>
                {/each}
              </select>
              <select bind:value={statusFilter} onchange={clearPagePreset} data-testid="viewer-status-filter" aria-label="Status">
                <option value={allOption}>All statuses</option>
                {#each statusOptions as status (status)}
                  <option value={status}>{status}</option>
                {/each}
              </select>
              <select bind:value={tagFilter} onchange={clearPagePreset} data-testid="viewer-tag-filter" aria-label="Tag">
                <option value={allOption}>All tags</option>
                {#each tagOptions as tag (tag)}
                  <option value={tag}>{tag}</option>
                {/each}
              </select>
            </div>
          </section>

          <section class="schema-browser-layout">
            <details
              class="schema-context-panel"
              open={schemaContextOpen}
              ontoggle={(event) => {
                schemaContextOpen = (event.currentTarget as HTMLDetailsElement).open;
              }}
            >
              <summary data-testid="schema-context-toggle">
                <span>
                  <strong>Relation overview</strong>
                  <small>
                    {docGraphOverview.hub?.title ?? `${graphObjects.length} visible objects`}
                  </small>
                </span>
              </summary>

              {#if docGraphOverview.hub !== null}
                <section class="doc-relation-overview" aria-labelledby="doc-relation-title" data-testid="doc-relation-overview">
                  <div class="doc-relation-map" aria-label="Embedded relation overview">
                    <svg viewBox="0 0 360 200" role="img" aria-labelledby="doc-relation-title">
                      <defs>
                        <marker id="doc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                          <path d="M 0 0 L 10 5 L 0 10 z"></path>
                        </marker>
                      </defs>
                      {#each docGraphOverview.edges as edge (edge.id)}
                        <line
                          x1={edge.x1}
                          y1={edge.y1}
                          x2={edge.x2}
                          y2={edge.y2}
                          stroke={edge.color}
                          class:muted={edge.muted}
                          marker-end="url(#doc-arrow)"
                        />
                      {/each}
                      {#each docGraphOverview.nodes as node (node.id)}
                        <g class:hub={node.hub} class:muted={node.muted}>
                          <circle
                            cx={node.x}
                            cy={node.y}
                            r={node.radius}
                            fill={node.color}
                            stroke={node.borderColor}
                          />
                          <text x={node.x} y={node.y + node.radius + 14}>
                            {#each node.label.split("\n") as line, lineIndex (`${node.id}-${lineIndex}`)}
                              <tspan x={node.x} dy={lineIndex === 0 ? 0 : 11}>{line}</tspan>
                            {/each}
                          </text>
                        </g>
                      {/each}
                    </svg>
                  </div>

                  <div class="doc-relation-copy">
                    <div class="doc-relation-heading">
                      <div>
                        <p class="eyebrow">Relation overview</p>
                        <h3 id="doc-relation-title">{docGraphOverview.hub.title}</h3>
                        <p>{docGraphOverview.hub.id}</p>
                      </div>
                      <button
                        type="button"
                        class="doc-graph-action"
                        onclick={showGraph}
                        data-testid="doc-hero-graph-link"
                      >
                        View full graph
                      </button>
                    </div>

                    <dl class="doc-relation-stats" aria-label="Visible graph counts">
                      <div><dt>Nodes</dt><dd>{graphObjects.length}</dd></div>
                      <div><dt>Links</dt><dd>{graphRelations.length}</dd></div>
                    </dl>

                    <ul class="doc-relation-list" aria-label="Visible direct relations">
                      {#each docGraphPreviewRelations as relation (relation.id)}
                        <li>
                          <span class="pill">{relation.predicate}</span>
                          <strong>
                            {relation.targetLabel}
                          </strong>
                          <small>{relationStatusLabel(relation)}</small>
                        </li>
                      {:else}
                        <li class="empty-copy">No direct relation links.</li>
                      {/each}
                      {#if docGraphOverflowCount > 0}
                        <li class="doc-relation-more">
                          {docGraphOverflowCount} more linked {docGraphOverflowCount === 1 ? "object" : "objects"}
                        </li>
                      {/if}
                    </ul>
                  </div>
                </section>
              {:else}
                <div class="doc-hero-actions">
                  <button
                    type="button"
                    class="doc-graph-link"
                    onclick={showGraph}
                    data-testid="doc-hero-graph-link"
                  >
                    <span class="doc-graph-icon" aria-hidden="true">◎</span>
                    <span>
                      <strong>Open relation graph</strong>
                      <small>{graphObjects.length} visible nodes, {graphRelations.length} links</small>
                    </span>
                  </button>
                </div>
              {/if}
            </details>

          <section class="memory-workspace" class:has-preview={hasSelectedObject} bind:this={memoryWorkspaceElement}>
            {#if visibleWarnings.length > 0}
              <section class="warnings" aria-label="Storage warnings">
                {#each visibleWarnings as warning (warning)}
                  <p>{warning}</p>
                {/each}
              </section>
            {/if}

            {#if hasStarterMemoryOnly}
              <section class="onboarding-callout" aria-label="Starter memory notice" data-testid="starter-memory-notice">
                <p><strong>Starter memory only.</strong> Seed useful repo memory with a bootstrap patch, then refresh the viewer.</p>
                <code>memory suggest --bootstrap --patch &gt; bootstrap-memory.json</code>
                <code>memory save --file bootstrap-memory.json</code>
              </section>
            {/if}

            <div class="browser-workspace-grid">
            <section class="sectioned-memory" aria-label="Memory objects">
              <div class="schema-browser-toolbar">
                <div>
                  <strong>Schema browser</strong>
                  <span>{filteredObjects.length} visible objects</span>
                </div>
                <label class="schema-sort-field">
                  <span>Sort</span>
                  <select bind:value={objectSort} class="schema-sort-select" data-testid="viewer-sort" aria-label="Sort objects">
                    {#each objectSortOptions as option (option.value)}
                      <option value={option.value}>{option.label}</option>
                    {/each}
                  </select>
                </label>
              </div>
              {#each memorySections as section (section.id)}
                <section id={section.id}>
                  <h3>{section.title}</h3>
                  <p>{countLabel(section.objects.length, "matching memory", "matching memories")}</p>
                  <div class="object-list">
                    {#each section.objects as object (object.id)}
                      <button
                        type="button"
                        class:selected={selectedObject?.id === object.id}
                        onclick={() => selectObject(object.id)}
                        data-testid={`object-row-${object.id}`}
                      >
                        <span>
                          <strong>{object.title}</strong>
                          <span class="object-meta" data-testid={`object-meta-${object.id}`}>
                            <span>{object.type}</span>
                            <span>{object.status}</span>
                            <span>{facetCategoryLabel(object)}</span>
                            <span>{scopeLabel(object.scope)}</span>
                            <span>{editedDateLabel(object)}</span>
                            {#if auditFindingsByMemory.has(object.id)}
                              <span class="advisory-chip">{advisoryLabel(auditFindingsByMemory.get(object.id) ?? [])}</span>
                            {/if}
                          </span>
                          <small>{bodyPreview(object)}</small>
                        </span>
                        <em aria-hidden="true">{selectedObject?.id === object.id ? "Selected" : "Open"}</em>
                      </button>
                    {/each}
                  </div>
                </section>
              {/each}
            </section>

            {#if selectedObject !== null}
              <article class="memory-preview object-detail-panel" aria-label={selectedObject.title} data-testid="selected-object">
                <header class="memory-preview-header">
                  <button
                    type="button"
                    class="selected-object-back"
                    onclick={closeSelectedObject}
                    data-testid="selected-object-back"
                  >
                    Back
                  </button>
                  <div>
                    <p class="eyebrow">Selected object</p>
                    <h3>{selectedObject.title}</h3>
                    <p class="mono">{selectedObject.id}</p>
                  </div>
                </header>

                <dl class="notion-properties">
                  <div><dt>Name</dt><dd>{selectedObject.title}</dd></div>
                  <div><dt>ID</dt><dd class="mono">{selectedObject.id}</dd></div>
                  <div><dt>Type</dt><dd>{selectedObject.type}</dd></div>
                  <div><dt>Facet</dt><dd>{facetCategoryLabel(selectedObject)}</dd></div>
                  <div><dt>Status</dt><dd>{selectedObject.status}</dd></div>
                  <div><dt>Scope</dt><dd>{scopeLabel(selectedObject.scope)}</dd></div>
                  <div><dt>Origin</dt><dd>{selectedObject.origin?.kind ?? "none"}</dd></div>
                  <div><dt>Evidence</dt><dd>{selectedObject.evidence.length}</dd></div>
                  <div><dt>Relations</dt><dd>{directRelations.length}</dd></div>
                  <div><dt>Updated</dt><dd>{selectedObject.updated_at}</dd></div>
                </dl>

                <div class="notion-toggle-list">
                  {#if selectedObjectFindings.length > 0}
                    <details class="notion-toggle advisory-details" open data-testid="selected-object-advisories">
                      <summary>Maintenance advisories</summary>
                      <ul class="maintenance-findings compact">
                        {#each selectedObjectFindings as finding (`${finding.rule}-${finding.message}`)}
                          <li>
                            <span class={`advisory-badge ${finding.severity}`}>{finding.severity}</span>
                            <strong>{finding.rule}</strong>
                            <p>{finding.message}</p>
                            <small>
                              {#each finding.evidence.slice(0, 6) as evidence, index (`${finding.rule}-${evidence.kind}-${evidence.id}-${index}`)}
                                <code>{evidenceLabel(evidence)}</code>
                              {/each}
                            </small>
                          </li>
                        {/each}
                      </ul>
                    </details>
                  {/if}

                  <details class="notion-toggle" open>
                    <summary>Memory</summary>
                    <section class="markdown-view" aria-label="Markdown body" data-testid="markdown-view">
                      {#each markdownBlocks as block, index (`${block.kind}-${index}`)}
                        {#if block.kind === "heading"}
                          {#if block.level === 1}
                            <h3>{block.text}</h3>
                          {:else if block.level === 2}
                            <h4>{block.text}</h4>
                          {:else}
                            <h5>{block.text}</h5>
                          {/if}
                        {:else if block.kind === "list"}
                          <ul>
                            {#each block.items ?? [] as item, itemIndex (itemIndex)}
                              <li>{item}</li>
                            {/each}
                          </ul>
                        {:else if block.kind === "quote"}
                          <blockquote>{block.text}</blockquote>
                        {:else if block.kind === "code"}
                          <pre><code>{block.text}</code></pre>
                        {:else}
                          <p>{block.text}</p>
                        {/if}
                      {:else}
                        <p class="empty-copy">This memory object has an empty Markdown body.</p>
                      {/each}
                    </section>
                  </details>

                  {#if selectedObject.tags.length > 0}
                    <details class="notion-toggle" open>
                      <summary>Tags</summary>
                      <ul class="tag-list" aria-label="Tags">
                        {#each selectedObject.tags as tag (tag)}
                          <li>{tag}</li>
                        {/each}
                      </ul>
                    </details>
                  {/if}

                  <details class="notion-toggle" open data-testid="facet-details">
                    <summary>Facet category</summary>
                    {#if selectedObject.facets === null}
                      <p class="empty-copy">No facets saved on this object.</p>
                    {:else}
                      <dl class="facet-grid">
                        <div><dt>Category</dt><dd>{selectedObject.facets.category}</dd></div>
                        <div><dt>Applies to</dt><dd>{selectedObject.facets.applies_to?.join(", ") || "global"}</dd></div>
                        <div><dt>Load modes</dt><dd>{selectedObject.facets.load_modes?.join(", ") || "all modes"}</dd></div>
                      </dl>
                    {/if}
                  </details>

                  <details class="notion-toggle" open data-testid="provenance-links">
                    <summary>Provenance</summary>
                    <ul class="relation-list">
                      {#if selectedObject.origin !== null}
                        <li>
                          <span class="pill">{selectedObject.origin.kind}</span>
                          <code>{selectedObject.origin.locator}</code>
                        </li>
                        {#if selectedObject.origin.digest !== undefined}
                          <li>
                            <span class="pill">digest</span>
                            <code>{selectedObject.origin.digest}</code>
                          </li>
                        {/if}
                        {#if selectedObject.origin.media_type !== undefined}
                          <li>
                            <span class="pill">media</span>
                            <code>{selectedObject.origin.media_type}</code>
                          </li>
                        {/if}
                        {#if selectedObject.origin.captured_at !== undefined}
                          <li>
                            <span class="pill">captured</span>
                            <code>{selectedObject.origin.captured_at}</code>
                          </li>
                        {/if}
                      {/if}
                      {#each selectedObject.evidence as evidence (`${evidence.kind}-${evidence.id}`)}
                        <li>
                          <span class="pill">{evidence.kind}</span>
                          {#if objectById.has(evidence.id)}
                            <button type="button" onclick={() => selectRelated(evidence.id)}>
                              {objectById.get(evidence.id)?.title ?? evidence.id}
                            </button>
                          {:else}
                            <code>{evidence.id}</code>
                          {/if}
                        </li>
                      {:else}
                        <li class="empty-copy">No evidence links.</li>
                      {/each}
                      {#each directRelations.filter((relation) => ["derived_from", "supports", "summarizes", "documents"].includes(relation.predicate)) as relation (relation.id)}
                        <li>
                          <span class="pill">{relation.predicate}</span>
                          <button type="button" onclick={() => selectRelated(relationCounterpart(relation, selectedObject.id))}>
                            {relationTargetLabel(relation, selectedObject.id)}
                          </button>
                        </li>
                      {/each}
                    </ul>
                  </details>

                  <details class="notion-toggle" open>
                    <summary>Direct relations</summary>
                    <section class="relation-columns">
                      <div>
                        <p class="eyebrow">Outgoing</p>
                        <ul class="relation-list" data-testid="outgoing-relations">
                          {#each outgoingRelations as relation (relation.id)}
                            <li data-testid={`relation-card-${relation.id}`}>
                              <span class="pill">{relation.predicate}</span>
                              <button type="button" onclick={() => selectRelated(relation.to)}>
                                {relationTargetLabel(relation, selectedObject.id)}
                              </button>
                              <small>{relationStatusLabel(relation)}</small>
                            </li>
                          {:else}
                            <li class="empty-copy">No outgoing related memories.</li>
                          {/each}
                        </ul>
                      </div>

                      <div>
                        <p class="eyebrow">Incoming</p>
                        <ul class="relation-list" data-testid="incoming-relations">
                          {#each incomingRelations as relation (relation.id)}
                            <li data-testid={`relation-card-${relation.id}`}>
                              <span class="pill">{relation.predicate}</span>
                              <button type="button" onclick={() => selectRelated(relation.from)}>
                                {relationTargetLabel(relation, selectedObject.id)}
                              </button>
                              <small>{relationStatusLabel(relation)}</small>
                            </li>
                          {:else}
                            <li class="empty-copy">No incoming related memories.</li>
                          {/each}
                        </ul>
                      </div>
                    </section>
                  </details>

                  <details class="notion-toggle technical-details" data-testid="technical-details">
                    <summary>Technical details</summary>
                    <dl>
                      <div><dt>Body</dt><dd>{selectedObject.body_path}</dd></div>
                      <div><dt>Sidecar</dt><dd>{selectedObject.json_path}</dd></div>
                      <div><dt>Scope</dt><dd>{selectedObject.scope.kind}</dd></div>
                      <div><dt>Updated</dt><dd>{selectedObject.updated_at}</dd></div>
                    </dl>
                    <section class="json-view" aria-label="Object sidecar JSON" data-testid="json-view">
                      <pre>{selectedJson}</pre>
                    </section>
                  </details>
                </div>
              </article>
            {/if}
            </div>
          </section>
          </section>
        </article>
      {/if}
    </section>
  {/if}
</main>

<style>
  :global(*) {
    box-sizing: border-box;
  }

  :global(body) {
    margin: 0;
    min-width: 320px;
    min-height: 100vh;
    color: #182230;
    background: #f6f7f4;
    font-family:
      Inter, "Avenir Next", "Segoe UI", ui-sans-serif, system-ui, -apple-system,
      BlinkMacSystemFont, sans-serif;
  }

  button,
  input,
  select {
    font: inherit;
  }

  button {
    cursor: pointer;
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.58;
  }

  h1,
  h2,
  h3,
  h4,
  p {
    margin-top: 0;
  }

  h1,
  h2,
  h3,
  h4 {
    color: #101828;
    letter-spacing: 0;
  }

  h1 {
    margin-bottom: 0;
    font-size: 1.35rem;
    line-height: 1.1;
  }

  h2 {
    margin-bottom: 0;
    font-size: 2rem;
    line-height: 1.08;
  }

  h3 {
    margin-bottom: 0;
    font-size: 1.2rem;
    line-height: 1.2;
  }

  code,
  pre,
  .mono,
  .path {
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  }

  .viewer-shell {
    display: grid;
    grid-template-columns: 236px minmax(0, 1fr);
    min-height: 100vh;
  }

  .sidebar {
    position: sticky;
    top: 0;
    display: flex;
    height: 100vh;
    flex-direction: column;
    gap: 20px;
    border-right: 1px solid #d8ded8;
    padding: 22px 18px;
    background: #fbfcfa;
  }

  .brand {
    display: grid;
    gap: 8px;
  }

  .brand p:last-child {
    margin: 0;
    color: #52605b;
    font-size: 0.88rem;
    line-height: 1.35;
  }

  .eyebrow {
    margin: 0;
    color: #667085;
    font-size: 0.72rem;
    font-weight: 800;
    letter-spacing: 0;
    text-transform: uppercase;
  }

  .nav-list {
    display: grid;
    gap: 8px;
  }

  .nav-list button,
  .ghost-action,
  .primary-action {
    min-height: 40px;
    border-radius: 7px;
    font-weight: 800;
  }

  .nav-list button {
    border: 1px solid transparent;
    padding: 9px 10px;
    color: #344054;
    background: transparent;
    text-align: left;
  }

  .nav-list button:hover {
    border-color: #a5bbb4;
    color: #2f2f2b;
    background: #ece9e1;
  }

  .mini-stats div {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }

  .mini-stats dt {
    color: #667085;
    font-size: 0.72rem;
    font-weight: 800;
    text-transform: uppercase;
  }

  .mini-stats dd {
    margin: 0;
    color: #101828;
    font-weight: 900;
  }

  .main-stage {
    min-width: 0;
    padding: 24px;
  }

  .system-panel {
    width: min(720px, calc(100vw - 32px));
    margin: 18vh auto 0;
    border: 1px solid #d7ded7;
    border-radius: 8px;
    padding: 24px;
    background: #ffffff;
    box-shadow: 0 18px 50px rgb(16 24 40 / 8%);
  }

  .error-panel {
    border-color: #efb5a8;
    background: #fff8f6;
  }

  .projects-page,
  .memory-page,
  .export-page {
    width: min(1180px, 100%);
    margin: 0 auto;
  }

  .page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 18px;
    margin-bottom: 18px;
  }

  .page-header p {
    margin-bottom: 0;
    color: #667085;
  }

  .project-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 14px;
  }

  .project-card,
  .empty-panel,
  .markdown-view,
  .object-list,
  .export-form,
  .project-delete-status,
  .warnings,
  .onboarding-callout {
    border: 1px solid #d9ded7;
    border-radius: 8px;
    background: #ffffff;
    box-shadow: 0 10px 28px rgb(16 24 40 / 5%);
  }

  .project-card {
    display: grid;
    gap: 12px;
    padding: 16px;
  }

  .project-card.current {
    border-color: #bdb7ab;
    background: #fbfaf7;
  }

  .project-card.unavailable {
    border-color: #edc3b8;
    background: #fff8f5;
  }

  .project-card-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .project-delete-confirm {
    display: grid;
    gap: 12px;
    border: 1px solid #efc7bd;
    border-radius: 8px;
    padding: 12px;
    background: #fff8f5;
  }

  .project-delete-confirm p,
  .project-delete-status p {
    margin: 0;
    color: #5f433d;
    line-height: 1.45;
  }

  .project-delete-status {
    margin: 0 0 14px;
    padding: 12px 14px;
  }

  .project-delete-status.success {
    border-color: #d8d0c3;
    background: #fbfaf7;
  }

  .project-delete-status.error {
    border-color: #efb5a8;
    background: #fff1f0;
  }

  .card-topline {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    color: #667085;
    font-size: 0.72rem;
    font-weight: 900;
    text-transform: uppercase;
  }

  .card-topline strong {
    color: #37352f;
  }

  .path,
  .mono {
    overflow-wrap: anywhere;
    color: #667085;
    font-size: 0.78rem;
    line-height: 1.45;
  }

  .mini-stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    margin: 0;
  }

  .mini-stats div {
    display: grid;
    justify-content: stretch;
    border-radius: 7px;
    padding: 9px;
    background: #f6f8f6;
  }

  .primary-action,
  .danger-action,
  .ghost-action {
    border: 1px solid #2b2925;
    padding: 9px 13px;
  }

  .primary-action {
    color: #ffffff;
    background: #2b2925;
  }

  .danger-action {
    border-color: #b5473d;
    color: #94342c;
    background: #fff8f5;
  }

  .danger-action.solid {
    color: #ffffff;
    background: #b5473d;
  }

  .ghost-action {
    color: #2b2925;
    background: #ffffff;
  }

  .layer-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .layer-tabs button {
    border: 1px solid #d0d5dd;
    border-radius: 999px;
    padding: 7px 11px;
    color: #344054;
    background: #ffffff;
    font-weight: 800;
  }

  .layer-tabs button.active {
    border-color: #2b2925;
    color: #ffffff;
    background: #2b2925;
  }

  .field {
    display: grid;
    gap: 6px;
  }

  .field span {
    color: #667085;
    font-size: 0.76rem;
    font-weight: 900;
    text-transform: uppercase;
  }

  input,
  select {
    width: 100%;
    min-height: 40px;
    border: 1px solid #cfd7cf;
    border-radius: 7px;
    padding: 8px 10px;
    color: #101828;
    background: #ffffff;
  }

  .warnings,
  .onboarding-callout {
    display: grid;
    gap: 8px;
    margin-bottom: 16px;
    padding: 14px;
  }

  .warnings {
    border-color: #e5d08b;
    background: #fffbea;
  }

  .onboarding-callout {
    border-color: #b8c9c4;
    background: #f7f5f0;
  }

  .object-list {
    overflow: hidden;
  }

  .object-list button {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 12px;
    width: 100%;
    border: 0;
    border-bottom: 1px solid #edf0ed;
    padding: 13px 14px;
    background: #ffffff;
    text-align: left;
  }

  .object-list button:hover,
  .object-list button.selected {
    background: #f7f5f0;
  }

  .tag-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 0;
    list-style: none;
  }

  .pill,
  .tag-list li {
    display: inline-flex;
    border: 1px solid #d0d5dd;
    border-radius: 999px;
    padding: 3px 8px;
    color: #344054;
    background: #f8fafc;
    font-size: 0.75rem;
    font-weight: 800;
  }

  .markdown-view,
  .export-form {
    padding: 16px;
  }

  .markdown-view {
    color: #2f3a4a;
    line-height: 1.65;
  }

  .markdown-view h3,
  .markdown-view h4,
  .markdown-view h5 {
    margin-top: 1.1rem;
  }

  .markdown-view pre,
  .json-view pre {
    overflow: auto;
    border-radius: 7px;
    padding: 12px;
    background: #101828;
    color: #f8fafc;
  }

  .markdown-view blockquote {
    margin: 0;
    border-left: 3px solid #bdb7ab;
    padding-left: 12px;
    color: #475467;
  }

  .relation-list {
    display: grid;
    gap: 9px;
    margin: 10px 0 0;
    padding: 0;
    list-style: none;
  }

  .relation-list li {
    display: grid;
    gap: 5px;
  }

  .relation-list button {
    justify-self: start;
    border: 0;
    padding: 0;
    color: #2b2925;
    background: transparent;
    font-weight: 900;
    text-align: left;
  }

  .relation-list small {
    color: #667085;
  }

  .technical-details {
    border-top: 1px solid #e4e8e4;
    padding-top: 12px;
  }

  .technical-details summary {
    cursor: pointer;
    font-weight: 900;
  }

  .technical-details dl {
    display: grid;
    gap: 8px;
  }

  .technical-details dd {
    margin: 0;
    overflow-wrap: anywhere;
    color: #667085;
  }

  .export-page {
    width: min(760px, 100%);
  }

  .export-form {
    display: grid;
    gap: 14px;
  }

  .export-status {
    border-radius: 7px;
    padding: 12px;
    background: #f8fafc;
  }

  .export-status.success {
    background: #f7f5f0;
  }

  .export-status.error {
    background: #fff1f0;
  }

  .empty-copy {
    margin: 0;
    color: #667085;
  }

  @media (max-width: 900px) {
    .viewer-shell {
      display: block;
    }

    .sidebar {
      position: static;
      height: auto;
      border-right: 0;
      border-bottom: 1px solid #d8ded8;
    }

    .object-list button {
      grid-template-columns: 1fr;
    }

  }

  :global(body) {
    color: #2b2b2b;
    background: #ffffff;
    font-family:
      Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  .viewer-shell {
    grid-template-columns: 248px minmax(0, 1fr);
    background: #ffffff;
  }

  .sidebar {
    border-right: 1px solid #e6e3dc;
    background: #f7f6f2;
    padding: 14px 10px;
    gap: 14px;
  }

  .brand-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 32px;
    border-radius: 6px;
    padding: 4px 6px;
  }

  .sidebar-menu {
    display: grid;
    gap: 14px;
  }

  .book-icon {
    display: block;
    width: 22px;
    height: 22px;
    flex: 0 0 auto;
    border-radius: 6px;
    object-fit: contain;
  }

  .brand h1 {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 800;
    letter-spacing: 0;
  }

  .brand p:last-child {
    overflow: hidden;
    padding: 0 6px 0 36px;
    color: #8b8a84;
    font-size: 0.76rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sidebar-search,
  .obsidian-field {
    display: grid;
    gap: 6px;
  }

  .sidebar-search span,
  .obsidian-field span,
  .nav-heading {
    margin: 0;
    color: #8a8880;
    font-size: 0.68rem;
    font-weight: 800;
    text-transform: uppercase;
  }

  .sidebar-search input,
  .obsidian-field input,
  .list-controls select {
    min-height: 32px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: #eeece6;
    color: #33332f;
    font-size: 0.83rem;
  }

  .sidebar-search input {
    width: 100%;
    padding: 0 10px;
  }

  .sidebar-search input:focus,
  .obsidian-field input:focus {
    border-color: #d1cdc4;
    background: #ffffff;
    outline: 0;
    box-shadow: 0 0 0 2px rgb(18 53 50 / 8%);
  }

  .nav-list {
    display: grid;
    gap: 16px;
    border-top: 1px solid #ebe8e0;
    padding-top: 12px;
  }

  .nav-section {
    display: grid;
    gap: 2px;
  }

  .nav-list button {
    display: grid;
    grid-template-columns: 20px minmax(0, 1fr);
    align-items: center;
    gap: 7px;
    min-height: 30px;
    border: 0;
    border-radius: 6px;
    padding: 4px 7px;
    color: #5f5e58;
    background: transparent;
    font-size: 0.88rem;
    font-weight: 560;
    text-align: left;
  }

  .nav-list button span:last-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .nav-row-icon {
    display: inline-grid;
    place-items: center;
    width: 20px;
    color: #96948c;
    font-size: 0.84rem;
  }

  .nav-list button:hover,
  .nav-list button.active {
    color: #262621;
    background: #e9e6df;
  }

  .nav-list button.active .nav-row-icon {
    color: #2b2925;
  }

  .nav-list button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .nav-list button:disabled:hover {
    color: #5f5e58;
    background: transparent;
  }

  .sidebar-export {
    display: grid;
    gap: 9px;
    border-top: 1px solid #ebe8e0;
    padding-top: 12px;
  }

  .sidebar-export summary {
    border-radius: 6px;
    padding: 5px 7px;
    color: #6a6861;
    cursor: pointer;
    font-size: 0.8rem;
    font-weight: 760;
  }

  .sidebar-export summary:hover {
    background: #e9e6df;
    color: #262621;
  }

  .sidebar-export button {
    min-height: 28px;
    border: 1px solid #dedbd5;
    border-radius: 6px;
    color: #464646;
    background: #ffffff;
    font-weight: 700;
  }

  .main-stage {
    padding: 56px clamp(28px, 6vw, 88px) 72px;
  }

  .memory-page,
  .projects-page,
  .export-page {
    width: min(1180px, 100%);
  }

  .memory-page {
    display: grid;
    gap: 22px;
  }

  .doc-hero {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    gap: 16px;
    padding-bottom: 18px;
    border-bottom: 1px solid #e9e6e0;
  }

  .doc-hero h2 {
    font-size: clamp(1.9rem, 3vw, 2.45rem);
    line-height: 1.06;
    font-weight: 950;
  }

  .doc-hero p:not(.eyebrow) {
    margin: 8px 0 0;
    max-width: 720px;
    color: #777777;
    font-size: 0.98rem;
    line-height: 1.55;
  }

  .list-controls button {
    border: 1px solid #e1ded7;
    border-radius: 7px;
    padding: 7px 10px;
    color: #343434;
    background: #ffffff;
    text-decoration: none;
    font-size: 0.82rem;
    font-weight: 800;
  }

  .projection-status {
    margin: 0;
    max-width: 640px;
    color: #666666;
    line-height: 1.5;
  }

  .sectioned-memory h3 {
    color: #2f2f2b;
    font-size: 1.16rem;
    font-weight: 760;
  }

  .sectioned-memory > section > p {
    margin: 4px 0 0;
    color: #9a988f;
    font-size: 0.86rem;
  }

  .list-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    margin: 0;
    border-bottom: 1px solid #e9e6e0;
    padding-bottom: 14px;
  }

  .list-controls strong,
  .list-controls span {
    display: block;
  }

  .list-controls span {
    color: #777777;
    font-size: 0.85rem;
  }

  .layer-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-left: auto;
  }

  .layer-tabs button {
    border-color: #e2dfd8;
    border-radius: 7px;
    padding: 7px 10px;
    font-size: 0.84rem;
  }

  .layer-tabs button.active {
    border-color: #bdb7ab;
    color: #2f2f2b;
    background: #ece9e1;
  }

  .list-controls select {
    width: auto;
    min-width: 138px;
    padding: 0 32px 0 12px;
  }

  .list-controls [data-testid="viewer-tag-filter"] {
    min-width: 170px;
  }

  .memory-workspace {
    display: grid;
    gap: 18px;
  }

  .memory-workspace.has-preview {
    grid-template-columns: 1fr;
  }

  .memory-preview {
    display: grid;
    gap: 10px;
    margin: 2px 0 14px 34px;
    padding: 2px 0 8px;
    background: transparent;
  }

  .notion-properties {
    display: grid;
    gap: 4px;
    margin: 0;
    padding: 2px 0 10px;
    border-bottom: 1px solid #f0eee8;
  }

  .notion-properties div {
    display: grid;
    grid-template-columns: 92px minmax(0, 1fr);
    gap: 12px;
    align-items: baseline;
  }

  .notion-properties dt {
    color: #9a988f;
    font-size: 0.78rem;
    font-weight: 650;
  }

  .notion-properties dd {
    margin: 0;
    color: #44443f;
    font-size: 0.86rem;
    overflow-wrap: anywhere;
  }

  .notion-toggle-list {
    display: grid;
    gap: 4px;
  }

  .notion-toggle {
    border: 0;
    padding: 0;
  }

  .notion-toggle summary {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 30px;
    border-radius: 5px;
    padding: 4px 6px;
    color: #3d3d38;
    cursor: pointer;
    font-size: 0.9rem;
    font-weight: 760;
    list-style: none;
  }

  .notion-toggle summary::-webkit-details-marker {
    display: none;
  }

  .notion-toggle summary::before {
    content: "›";
    display: inline-grid;
    place-items: center;
    width: 14px;
    color: #8a8880;
    transition: transform 120ms ease;
  }

  .notion-toggle[open] > summary::before {
    transform: rotate(90deg);
  }

  .notion-toggle summary:hover {
    background: #f1efea;
  }

  .notion-toggle > :not(summary) {
    margin-left: 22px;
    padding: 4px 0 12px;
  }

  .memory-preview .markdown-view {
    border: 0;
    border-radius: 0;
    padding: 0;
    background: transparent;
    box-shadow: none;
  }

  .relation-columns {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
  }

  .sectioned-memory > section {
    margin-top: 24px;
    border-top: 1px solid #f0eee8;
    padding-top: 14px;
  }

  .sectioned-memory > section:first-child {
    margin-top: 0;
    border-top: 0;
    padding-top: 0;
  }

  .object-list {
    display: grid;
    gap: 1px;
    margin-top: 8px;
    border: 0;
    background: transparent;
    box-shadow: none;
  }

  .object-list button {
    grid-template-columns: minmax(0, 1fr) 18px;
    align-items: center;
    border: 0;
    border-radius: 4px;
    padding: 6px 8px;
    background: transparent;
  }

  .object-list button:hover,
  .object-list button.selected {
    background: #f1efea;
  }

  .object-list button.selected {
    box-shadow: none;
  }

  .object-list button:focus-visible {
    outline: 0;
    background: #ebe9e3;
  }

  .object-list strong {
    display: block;
    color: #37352f;
    font-size: 0.96rem;
    font-weight: 650;
  }

  .object-list small {
    display: block;
    margin-top: 1px;
    color: #8f8d86;
    font-size: 0.84rem;
    line-height: 1.35;
  }

  .object-list em {
    display: inline-grid;
    place-items: center;
    width: 22px;
    height: 22px;
    color: #8a8a8a;
    font-style: normal;
    font-weight: 900;
  }

  @media (max-width: 980px) {
    .doc-hero,
    .list-controls {
      grid-template-columns: 1fr;
    }

    .memory-workspace.has-preview {
      grid-template-columns: 1fr;
    }

    .memory-preview {
      position: static;
      max-height: none;
    }

    .list-controls {
      align-items: stretch;
    }
  }

  @media (max-width: 900px) {
    .viewer-shell {
      display: block;
      min-height: 100vh;
    }

    .sidebar {
      position: sticky;
      top: 0;
      z-index: 20;
      height: auto;
      gap: 0;
      border-right: 0;
      border-bottom: 1px solid #dedbd5;
      padding: 12px 14px;
      box-shadow: 0 8px 22px rgb(16 24 40 / 7%);
    }

    .brand {
      gap: 4px;
    }

    .brand-row {
      gap: 8px;
    }

    .book-icon {
      width: 22px;
      height: 22px;
      border-radius: 5px;
    }

    .brand h1 {
      font-size: 1rem;
      line-height: 1.1;
    }

    .brand p:last-child {
      max-width: 100%;
      overflow: hidden;
      padding-left: 30px;
      font-size: 0.78rem;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .sidebar-menu {
      display: none;
      position: absolute;
      top: calc(100% + 8px);
      right: 10px;
      left: 10px;
      gap: 14px;
      max-height: calc(100dvh - 96px);
      overflow: auto;
      border: 1px solid #e1ded7;
      border-radius: 10px;
      padding: 14px;
      background: #fffefa;
      box-shadow:
        0 24px 60px rgb(16 24 40 / 18%),
        0 2px 8px rgb(16 24 40 / 8%);
    }

    .sidebar-menu.open {
      display: grid;
    }

    .sidebar-search {
      gap: 5px;
    }

    .sidebar-search input {
      width: 100%;
      min-height: 40px;
      padding: 0 13px;
      font-size: 0.9rem;
    }

    .nav-list {
      display: grid;
      gap: 12px;
      border-top: 0;
      padding: 0;
    }

    .nav-section {
      gap: 3px;
    }

    .nav-list button {
      min-height: 36px;
      border: 0;
      border-radius: 6px;
      padding: 7px 9px;
      background: transparent;
      color: #3f4643;
      font-size: 0.9rem;
      font-weight: 700;
      text-align: left;
    }

    .nav-heading {
      margin-bottom: 1px;
    }

    .nav-list button:hover,
    .nav-list button.active {
      color: #2b2925;
      background: #e9e6df;
    }

    .sidebar-export {
      display: grid;
      grid-template-columns: 1fr;
      gap: 8px;
      border-top: 1px solid #e7e2db;
      padding-top: 14px;
    }

    .sidebar-export .obsidian-field {
      grid-column: 1 / -1;
    }

    .sidebar-export button {
      min-height: 36px;
    }

    .main-stage {
      padding: 26px 14px 48px;
    }

    .memory-page {
      gap: 24px;
    }

    .doc-hero {
      grid-template-columns: minmax(0, 1fr);
      gap: 8px;
      padding-bottom: 14px;
    }

    .doc-hero h2 {
      font-size: 1.9rem;
      line-height: 1.08;
    }

    .doc-hero p:not(.eyebrow) {
      margin-top: 8px;
      font-size: 0.94rem;
    }

    .list-controls button {
      min-height: 36px;
      white-space: nowrap;
    }

    .list-controls {
      gap: 12px;
      margin-bottom: 12px;
      padding-top: 18px;
    }

    .layer-tabs {
      flex-wrap: nowrap;
      justify-content: flex-start;
      overflow-x: auto;
      padding-bottom: 2px;
      scrollbar-width: none;
      -webkit-overflow-scrolling: touch;
    }

    .layer-tabs::-webkit-scrollbar {
      display: none;
    }

    .layer-tabs button {
      flex: 0 0 auto;
      min-height: 36px;
      white-space: nowrap;
    }

    .list-controls select {
      width: 100%;
      min-height: 38px;
    }

    .object-list button {
      grid-template-columns: minmax(0, 1fr);
      gap: 10px;
      padding: 12px;
    }

    .markdown-view pre {
      overflow-x: auto;
      font-size: 0.74rem;
    }
  }

  @media (max-width: 560px) {
    .main-stage {
      padding-inline: 10px;
    }

    .sidebar {
      padding-inline: 10px;
    }

    .doc-hero h2 {
      font-size: 1.65rem;
    }

    .sectioned-memory h3 {
      font-size: 1.35rem;
    }

    .list-controls button {
      padding: 7px 9px;
      font-size: 0.78rem;
    }

  }

  /* Document-style viewer pass. */
  :global(body) {
    color: #2f2f2b;
    background: #fbfaf7;
    font-family:
      Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  .viewer-shell {
    grid-template-columns: 340px minmax(0, 1fr);
    background: #fbfaf7;
  }

  .sidebar {
    border-right: 1px solid #dedbd2;
    background: #f4f1eb;
    padding: 30px 28px;
    gap: 28px;
  }

  .brand {
    gap: 22px;
  }

  .brand-row {
    gap: 10px;
    padding: 0;
  }

  .book-icon {
    width: 28px;
    height: 28px;
    border-radius: 999px;
    object-fit: contain;
    box-shadow:
      0 1px 2px rgb(16 24 40 / 8%),
      inset 0 0 0 1px rgb(255 255 255 / 8%);
  }

  .brand h1 {
    color: #242423;
    font-size: 1.46rem;
    line-height: 1.1;
    font-weight: 850;
  }

  .brand p:last-child {
    padding: 0;
    color: #6c6962;
    font-size: 1.02rem;
    line-height: 1.35;
    white-space: normal;
  }

  .sidebar-stats {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    margin: 0;
    border-top: 1px solid #dfdbd1;
    padding-top: 24px;
  }

  .sidebar-stats div {
    min-height: 84px;
    border: 1px solid #dfdbd1;
    border-radius: 8px;
    padding: 14px 16px;
    background: #fffefa;
    box-shadow: 0 1px 2px rgb(16 24 40 / 5%);
  }

  .sidebar-stats dt {
    color: #262522;
    font-size: 1.7rem;
    line-height: 1.05;
    font-weight: 850;
  }

  .sidebar-stats dd {
    margin: 7px 0 0;
    color: #74716a;
    font-size: 0.92rem;
    font-weight: 560;
  }

  .sidebar-menu {
    gap: 24px;
  }

  .sidebar-search {
    gap: 9px;
  }

  .sidebar-search span,
  .nav-heading,
  .obsidian-field span {
    color: #9a968d;
    font-size: 0.72rem;
    letter-spacing: 0;
  }

  .sidebar-search input,
  .obsidian-field input {
    min-height: 44px;
    border: 1px solid #dedbd3;
    border-radius: 8px;
    background: #fffefa;
    color: #37352f;
    font-size: 0.94rem;
    box-shadow: 0 1px 2px rgb(16 24 40 / 4%);
  }

  .nav-list {
    gap: 22px;
    border-top: 1px solid #dfdbd1;
    padding-top: 22px;
  }

  .nav-section {
    gap: 6px;
  }

  .nav-list button {
    min-height: 32px;
    grid-template-columns: 18px minmax(0, 1fr);
    gap: 9px;
    border: 0;
    border-radius: 6px;
    padding: 5px 9px;
    color: #6e6b65;
    background: transparent;
    font-size: 0.98rem;
    font-weight: 520;
  }

  .nav-list button:hover,
  .nav-list button.active {
    color: #2f2f2b;
    background: #e9e6df;
  }

  .nav-row-icon {
    width: 18px;
    color: #9a968d;
  }

  .sidebar-export {
    border-top: 1px solid #dfdbd1;
    padding-top: 18px;
  }

  .main-stage {
    min-width: 0;
    padding: 46px clamp(34px, 4vw, 72px) 88px;
    background: #fffefa;
  }

  .memory-page,
  .projects-page,
  .graph-page,
  .export-page {
    width: min(1060px, 100%);
    margin: 0;
  }

  .graph-page {
    width: min(1280px, 100%);
  }

  .memory-page {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    justify-content: center;
    gap: 24px;
  }

  .doc-hero {
    display: grid;
    grid-template-columns: 1fr;
    gap: 10px;
    max-width: none;
    margin: 0;
    border-bottom: 0;
    padding: 0;
  }

  .doc-icon {
    display: block;
    width: 46px;
    height: 46px;
    border-radius: 999px;
    object-fit: contain;
    box-shadow:
      0 16px 42px rgb(16 24 40 / 10%),
      inset 0 0 0 1px rgb(255 255 255 / 8%);
  }

  .doc-hero .eyebrow {
    margin-top: 4px;
    color: #9a968d;
  }

  .doc-hero h2 {
    max-width: 860px;
    color: #202020;
    font-size: clamp(2.7rem, 4.1vw, 3.85rem);
    line-height: 1;
    font-weight: 880;
  }

  .doc-hero p:not(.eyebrow) {
    max-width: 680px;
    color: #6d6a65;
    font-size: 1rem;
    line-height: 1.48;
  }

  .doc-relation-overview {
    display: grid;
    grid-template-columns: minmax(0, 1.08fr) minmax(280px, 0.82fr);
    gap: 22px;
    align-items: stretch;
    border-top: 1px solid #ebe7de;
    border-bottom: 1px solid #ebe7de;
    padding: 20px 0 22px;
  }

  .doc-relation-map {
    min-height: 244px;
    overflow: hidden;
    border: 1px solid #e2ded5;
    border-radius: 8px;
    background:
      linear-gradient(rgb(242 239 232 / 70%) 1px, transparent 1px),
      linear-gradient(90deg, rgb(242 239 232 / 70%) 1px, transparent 1px),
      #fffefa;
    background-size: 24px 24px;
  }

  .doc-relation-map svg {
    display: block;
    width: 100%;
    height: 100%;
    min-height: 244px;
  }

  .doc-relation-map marker path {
    fill: #8e8981;
  }

  .doc-relation-map line {
    stroke-width: 1.25;
    stroke-linecap: round;
    opacity: 0.62;
  }

  .doc-relation-map line.muted {
    opacity: 0.24;
  }

  .doc-relation-map circle {
    stroke-width: 2;
  }

  .doc-relation-map g.hub circle {
    stroke-width: 4;
  }

  .doc-relation-map g.muted circle {
    opacity: 0.32;
  }

  .doc-relation-map text {
    fill: #37352f;
    font-size: 7.8px;
    font-weight: 800;
    text-anchor: middle;
  }

  .doc-relation-map g.muted text {
    opacity: 0;
  }

  .doc-relation-copy {
    display: grid;
    align-content: start;
    gap: 14px;
    min-width: 0;
  }

  .doc-relation-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 18px;
  }

  .doc-relation-heading h3 {
    margin: 4px 0 0;
    color: #242423;
    font-size: 1.26rem;
    line-height: 1.12;
    font-weight: 850;
  }

  .doc-relation-heading p:not(.eyebrow) {
    margin: 6px 0 0;
    color: #667085;
  }

  .doc-relation-stats {
    display: flex;
    gap: 8px;
    margin: 0;
  }

  .doc-relation-stats div {
    min-width: 62px;
    border: 1px solid #e2ded5;
    border-radius: 8px;
    padding: 8px 10px;
    background: #ffffff;
  }

  .doc-relation-stats dt {
    color: #9a968d;
    font-size: 0.64rem;
    font-weight: 850;
    text-transform: uppercase;
  }

  .doc-relation-stats dd {
    margin: 2px 0 0;
    color: #262522;
    font-size: 1.08rem;
    font-weight: 880;
  }

  .doc-relation-list {
    display: grid;
    gap: 9px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .doc-relation-list li {
    display: grid;
    grid-template-columns: minmax(96px, auto) minmax(0, 1fr);
    gap: 4px 10px;
    align-items: center;
    border-top: 1px solid #f0eee8;
    padding-top: 9px;
  }

  .doc-relation-list li:first-child {
    border-top: 0;
    padding-top: 0;
  }

  .doc-relation-list .pill {
    justify-self: start;
  }

  .doc-relation-list strong {
    min-width: 0;
    color: #242423;
    font-size: 1rem;
    font-weight: 850;
    line-height: 1.18;
  }

  .doc-relation-list small {
    grid-column: 2;
    color: #667085;
  }

  .doc-relation-more {
    display: block !important;
    color: #8b8880;
    font-size: 0.86rem;
  }

  .doc-graph-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    border: 1px solid #202020;
    border-radius: 8px;
    padding: 10px 15px;
    color: #ffffff;
    background: #202020;
    font-size: 0.9rem;
    font-weight: 850;
    white-space: nowrap;
    box-shadow: 0 10px 24px rgb(16 24 40 / 10%);
  }

  .doc-graph-action:hover {
    border-color: #111214;
    background: #111214;
  }

  .doc-graph-action:focus-visible {
    outline: 2px solid #2563eb;
    outline-offset: 3px;
  }

  .doc-hero-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 2px;
  }

  .doc-graph-link {
    display: inline-flex;
    align-items: center;
    gap: 11px;
    max-width: 100%;
    min-height: 54px;
    border: 1px solid #dedbd3;
    border-radius: 8px;
    padding: 9px 14px 9px 10px;
    color: #2f2f2b;
    background: #ffffff;
    text-align: left;
    box-shadow: 0 8px 24px rgb(16 24 40 / 5%);
  }

  .doc-graph-link:hover {
    border-color: #cbc5ba;
    background: #f7f6f2;
  }

  .doc-graph-link:focus-visible {
    outline: 2px solid #2563eb;
    outline-offset: 3px;
  }

  .doc-graph-icon {
    display: inline-grid;
    place-items: center;
    width: 34px;
    height: 34px;
    flex: 0 0 auto;
    border-radius: 999px;
    color: #faf9f5;
    background: #111214;
    font-size: 1rem;
    font-weight: 900;
  }

  .doc-graph-link span:last-child {
    display: grid;
    min-width: 0;
    gap: 2px;
  }

  .doc-graph-link strong {
    color: #242423;
    font-size: 0.96rem;
    font-weight: 820;
    line-height: 1.15;
  }

  .doc-graph-link small {
    color: #77736d;
    font-size: 0.82rem;
    line-height: 1.25;
  }

  .projection-status {
    margin: 0;
    color: #6f6b63;
    font-size: 0.92rem;
    line-height: 1.45;
  }

  .projection-status span {
    display: inline-flex;
    margin-right: 6px;
    border: 1px solid #d6d2ca;
    border-radius: 999px;
    padding: 2px 8px;
    color: #37352f;
    background: #f7f6f2;
    font-size: 0.78rem;
    font-weight: 820;
  }

  .graph-counts {
    display: flex;
    gap: 10px;
    margin: 0;
  }

  .graph-counts div {
    min-width: 86px;
    border: 1px solid #e2ded5;
    border-radius: 8px;
    padding: 10px 12px;
    background: #ffffff;
    box-shadow: 0 1px 2px rgb(16 24 40 / 4%);
  }

  .graph-counts dt {
    color: #9a968d;
    font-size: 0.68rem;
    font-weight: 850;
    text-transform: uppercase;
  }

  .graph-counts dd {
    margin: 3px 0 0;
    color: #262522;
    font-size: 1.25rem;
    font-weight: 880;
  }

  .graph-panel {
    display: grid;
    gap: 12px;
  }

  .graph-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border: 1px solid #e2ded5;
    border-radius: 8px;
    padding: 10px;
    background: linear-gradient(180deg, #ffffff 0%, #fbfaf6 100%);
    box-shadow: 0 8px 22px rgb(16 24 40 / 5%);
  }

  .graph-filter-tabs,
  .graph-actions,
  .graph-inspector-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .graph-filter-tabs button,
  .graph-actions button,
  .graph-inspector-actions button {
    min-height: 34px;
    border: 1px solid #dedbd3;
    border-radius: 7px;
    padding: 7px 11px;
    color: #5e5a53;
    background: #ffffff;
    font-size: 0.84rem;
    font-weight: 760;
  }

  .graph-actions button {
    min-width: 38px;
    padding-right: 10px;
    padding-left: 10px;
    color: #36342f;
    font-size: 0.92rem;
  }

  .graph-actions button:disabled {
    color: #b5aea4;
    background: #f6f4ee;
  }

  .graph-filter-tabs button.active {
    border-color: #2b2925;
    color: #ffffff;
    background: #2b2925;
  }

  .graph-legend {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 10px 16px;
    border: 1px solid #e5e0d6;
    border-radius: 8px;
    padding: 10px 12px;
    color: #625d55;
    background: #fbfaf6;
    font-size: 0.78rem;
    font-weight: 760;
  }

  .graph-legend-group,
  .graph-legend-item {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .graph-legend-item {
    gap: 6px;
    white-space: nowrap;
  }

  .graph-legend-node {
    width: 11px;
    height: 11px;
    border: 2px solid var(--legend-border, #fffefa);
    border-radius: 999px;
    background: var(--legend-color, #6b6f76);
    box-shadow: 0 0 0 1px rgb(38 37 34 / 14%);
  }

  .graph-legend-node.unlinked {
    border-color: #c36a43;
    border-style: dashed;
    background: #fff7ef;
  }

  .graph-legend-line {
    width: 24px;
    border-top: 2px solid var(--legend-color, #78736b);
  }

  .graph-legend-line.dashed {
    border-top-style: dashed;
  }

  .graph-workspace {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(280px, 340px);
    gap: 14px;
    align-items: stretch;
  }

  .graph-canvas-wrap,
  .graph-inspector {
    border: 1px solid #e2ded5;
    border-radius: 8px;
    background: #ffffff;
    box-shadow: 0 10px 28px rgb(16 24 40 / 5%);
  }

  .graph-canvas-wrap {
    position: relative;
    min-height: 640px;
    overflow: hidden;
  }

  .graph-canvas {
    width: 100%;
    height: 100%;
    min-height: 640px;
    background:
      radial-gradient(circle at 18% 18%, rgb(47 93 98 / 7%), transparent 26%),
      linear-gradient(rgb(238 234 225 / 72%) 1px, transparent 1px),
      linear-gradient(90deg, rgb(238 234 225 / 72%) 1px, transparent 1px),
      #fffefa;
    background-size: auto, 30px 30px, 30px 30px, auto;
  }

  .graph-empty {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    gap: 8px;
    padding: 24px;
    text-align: center;
    background: rgb(255 254 250 / 86%);
  }

  .graph-empty h3,
  .graph-empty p,
  .graph-empty-selection h3,
  .graph-empty-selection p {
    margin: 0;
  }

  .graph-empty p,
  .graph-empty-selection p,
  .graph-body-preview {
    color: #746f68;
    line-height: 1.45;
  }

  .graph-inspector {
    align-self: stretch;
    min-height: 640px;
    padding: 18px;
    background: linear-gradient(180deg, #ffffff 0%, #fbfaf7 100%);
  }

  .graph-inspector section {
    display: grid;
    gap: 12px;
  }

  .graph-inspector h3 {
    color: #242423;
    font-size: 1.2rem;
    font-weight: 850;
    line-height: 1.15;
  }

  .graph-meta {
    display: grid;
    gap: 7px;
    margin: 0;
    border-top: 1px solid #f0eee8;
    border-bottom: 1px solid #f0eee8;
    padding: 12px 0;
  }

  .graph-meta div {
    display: grid;
    grid-template-columns: 82px minmax(0, 1fr);
    gap: 10px;
    align-items: baseline;
  }

  .graph-meta dt {
    color: #9a968d;
    font-size: 0.76rem;
    font-weight: 780;
  }

  .graph-meta dd {
    margin: 0;
    overflow-wrap: anywhere;
    color: #3d3d38;
    font-size: 0.88rem;
  }

  .graph-body-preview {
    margin: 0;
    border-left: 3px solid #e2ded5;
    padding-left: 10px;
    font-size: 0.92rem;
  }

  .graph-relations {
    border-top: 1px solid #f0eee8;
    padding-top: 10px;
  }

  .graph-relations summary {
    cursor: pointer;
    color: #37352f;
    font-weight: 780;
  }

  .warnings,
  .onboarding-callout,
  .list-controls,
  .sectioned-memory {
    max-width: none;
    margin-right: 0;
    margin-left: 0;
  }

  .list-controls {
    display: grid;
    grid-template-columns: 1fr;
    align-items: start;
    justify-content: stretch;
    gap: 14px;
    border-bottom: 1px solid #ebe7de;
    padding: 4px 0 24px;
  }

  .list-controls > div:first-child {
    text-align: left;
  }

  .list-controls strong {
    color: #2f2f2b;
    font-size: 0.98rem;
  }

  .list-controls span {
    color: #8b8880;
    font-size: 0.9rem;
  }

  .controls-row {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: 8px;
    width: 100%;
    overflow-x: auto;
    padding-bottom: 2px;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
  }

  .controls-row::-webkit-scrollbar {
    display: none;
  }

  .layer-tabs {
    flex: 0 0 auto;
    flex-wrap: nowrap;
    justify-content: flex-start;
    margin: 0;
    gap: 8px;
  }

  .layer-tabs button,
  .list-controls button {
    flex: 0 0 auto;
    min-height: 36px;
    border: 1px solid #dedbd3;
    border-radius: 999px;
    padding: 7px 12px;
    color: #6d6a65;
    background: #ffffff;
    font-size: 0.86rem;
    font-weight: 650;
    white-space: nowrap;
    box-shadow: 0 1px 2px rgb(16 24 40 / 4%);
  }

  .layer-tabs button.active {
    border-color: #202020;
    color: #ffffff;
    background: #202020;
  }

  .list-controls select {
    flex: 0 0 auto;
    width: auto;
    min-width: 138px;
    min-height: 38px;
    border-color: #dedbd3;
    border-radius: 999px;
    appearance: none;
    -webkit-appearance: none;
    background-color: #efede8;
    background-image:
      linear-gradient(45deg, transparent 50%, #6c675f 50%),
      linear-gradient(135deg, #6c675f 50%, transparent 50%);
    background-position:
      calc(100% - 18px) 50%,
      calc(100% - 13px) 50%;
    background-repeat: no-repeat;
    background-size: 5px 5px;
    color: #504d48;
    font-size: 0.9rem;
    white-space: nowrap;
  }

  .list-controls [data-testid="viewer-tag-filter"] {
    min-width: 140px;
  }

  .list-controls [data-testid="viewer-facet-filter"] {
    min-width: 160px;
  }

  .sectioned-memory {
    display: grid;
    gap: 36px;
  }

  .schema-browser-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    border-bottom: 1px solid #ece6dc;
    padding-bottom: 16px;
  }

  .schema-browser-toolbar strong,
  .schema-browser-toolbar span {
    display: block;
  }

  .schema-browser-toolbar strong {
    color: #202020;
    font-size: 1.04rem;
    font-weight: 780;
  }

  .schema-browser-toolbar span {
    margin-top: 3px;
    color: #77736d;
    font-size: 0.92rem;
  }

  .schema-sort-field {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 9px;
    color: #625d54;
    font-size: 0.88rem;
    font-weight: 720;
  }

  .schema-sort-field > span {
    margin: 0;
    color: #625d54;
    font-size: 0.88rem;
  }

  .schema-sort-select {
    min-width: 168px;
    min-height: 40px;
    border: 1px solid #dfd8cd;
    border-radius: 999px;
    appearance: none;
    -webkit-appearance: none;
    padding: 0 38px 0 14px;
    background-color: #f4f1eb;
    background-image:
      linear-gradient(45deg, transparent 50%, #6c675f 50%),
      linear-gradient(135deg, #6c675f 50%, transparent 50%);
    background-position:
      calc(100% - 18px) 50%,
      calc(100% - 13px) 50%;
    background-repeat: no-repeat;
    background-size: 5px 5px;
    color: #45413b;
    font: inherit;
    font-size: 0.92rem;
    white-space: nowrap;
  }

  .sectioned-memory > section {
    margin: 0;
    border-top: 0;
    padding-top: 0;
  }

  .sectioned-memory h3 {
    display: flex;
    align-items: center;
    gap: 10px;
    color: #202020;
    font-size: 2.05rem;
    line-height: 1.08;
    font-weight: 850;
  }

  .sectioned-memory > section > p {
    margin: 6px 0 18px;
    color: #77736d;
    font-size: 1.04rem;
  }

  .object-list {
    display: grid;
    gap: 12px;
    overflow: visible;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }

  .object-list button {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 14px;
    min-height: 72px;
    border: 1px solid #e3dfd7;
    border-radius: 8px;
    padding: 12px 18px;
    background: #ffffff;
    color: #37352f;
    box-shadow: 0 1px 2px rgb(16 24 40 / 4%);
  }

  .object-list button:hover {
    border-color: #d7d2c8;
    background: #fbfaf7;
  }

  .object-list button.selected {
    border-color: #e3dfd7;
    border-bottom-color: transparent;
    border-radius: 8px 8px 0 0;
    background: #f1efea;
    box-shadow: none;
  }

  .object-list button:focus-visible {
    outline: 2px solid #2563eb;
    outline-offset: 2px;
    background: #f7f5f0;
  }

  .object-list strong {
    color: #2c2c29;
    font-size: 1.1rem;
    line-height: 1.22;
    font-weight: 800;
  }

  .object-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 7px;
  }

  .object-meta span {
    border: 1px solid #dedbd3;
    border-radius: 999px;
    padding: 2px 7px;
    color: #605c55;
    background: #fbfaf7;
    font-size: 0.74rem;
    font-weight: 760;
  }

  .object-meta .advisory-chip {
    border-color: #d99b69;
    color: #8a461a;
    background: #fff4e8;
  }

  .object-list small {
    display: block;
    margin-top: 7px;
    color: #77736d;
    font-size: 0.94rem;
    line-height: 1.35;
  }

  .object-list em {
    width: auto;
    min-width: 34px;
    color: #9a968d;
    font-size: 0.92rem;
    font-style: normal;
    font-weight: 620;
    text-align: right;
  }

  .maintenance-page {
    display: grid;
    gap: 22px;
    padding: 28px;
  }

  .maintenance-list {
    display: grid;
    gap: 14px;
  }

  .maintenance-card {
    display: grid;
    gap: 14px;
    border: 1px solid #e4dfd6;
    border-radius: 8px;
    padding: 18px;
    background: #ffffff;
    box-shadow: 0 1px 2px rgb(16 24 40 / 4%);
  }

  .maintenance-card-header {
    display: flex;
    justify-content: space-between;
    gap: 14px;
    align-items: flex-start;
  }

  .maintenance-card h3 {
    margin: 2px 0 4px;
    color: #25231f;
    font-size: 1.2rem;
    line-height: 1.2;
  }

  .maintenance-action {
    margin: 0;
    color: #5b5650;
  }

  .maintenance-findings {
    display: grid;
    gap: 10px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .maintenance-findings li {
    display: grid;
    gap: 5px;
    border-left: 3px solid #ded7cc;
    padding: 2px 0 2px 12px;
  }

  .maintenance-findings.compact li {
    border-left-color: #d99b69;
  }

  .maintenance-findings p,
  .maintenance-findings small {
    margin: 0;
    color: #665f56;
  }

  .maintenance-findings small {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .advisory-badge {
    width: max-content;
    border: 1px solid #d6cec2;
    border-radius: 999px;
    padding: 2px 8px;
    color: #675f56;
    background: #f7f3ec;
    font-size: 0.72rem;
    font-weight: 780;
    text-transform: uppercase;
  }

  .advisory-badge.warning {
    border-color: #d99b69;
    color: #8a461a;
    background: #fff4e8;
  }

  .memory-preview {
    display: grid;
    gap: 18px;
    margin: -12px 0 4px;
    border: 1px solid #e3dfd7;
    border-top: 0;
    border-radius: 0 0 8px 8px;
    padding: 24px 56px 28px;
    background: #ffffff;
    box-shadow: 0 16px 32px rgb(16 24 40 / 5%);
  }

  .notion-properties {
    gap: 0;
    padding: 0 0 14px;
    border-bottom: 1px solid #e7e3dc;
  }

  .notion-properties div {
    grid-template-columns: 92px minmax(0, 1fr);
    min-height: 26px;
    gap: 18px;
  }

  .notion-properties dt {
    color: #99958d;
    font-size: 0.9rem;
    font-weight: 780;
  }

  .notion-properties dd {
    color: #3e3d39;
    font-size: 0.98rem;
  }

  .notion-toggle-list {
    gap: 12px;
  }

  .facet-grid {
    display: grid;
    gap: 8px;
    margin: 0;
  }

  .facet-grid div {
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr);
    gap: 12px;
  }

  .facet-grid dt {
    color: #99958d;
    font-weight: 760;
  }

  .facet-grid dd {
    margin: 0;
    color: #3e3d39;
    overflow-wrap: anywhere;
  }

  .notion-toggle summary {
    min-height: 30px;
    padding: 2px 0;
    color: #37352f;
    font-size: 1.02rem;
    font-weight: 760;
  }

  .notion-toggle summary:hover {
    background: transparent;
  }

  .notion-toggle > :not(summary) {
    margin-left: 22px;
    padding: 8px 0 18px;
  }

  .memory-preview .markdown-view {
    color: #283247;
    font-size: 1.05rem;
    line-height: 1.55;
  }

  .memory-preview .markdown-view h3 {
    margin: 0 0 6px;
    color: #182230;
    font-size: 1.45rem;
    line-height: 1.18;
  }

  .tag-list li,
  .pill {
    border-color: #d6d2ca;
    background: #f7f6f2;
    color: #4e5a6b;
  }

  .relation-columns {
    gap: 28px;
  }

  .technical-details {
    border-top: 0;
    padding-top: 0;
  }

  @media (max-width: 1040px) {
    .viewer-shell {
      grid-template-columns: 286px minmax(0, 1fr);
    }

    .sidebar {
      padding: 24px 20px;
    }

    .main-stage {
      padding: 52px 28px 72px;
    }

    .doc-hero h2 {
      font-size: clamp(2.8rem, 7vw, 4.3rem);
    }
  }

  @media (max-width: 900px) {
    .viewer-shell {
      display: block;
    }

    .sidebar {
      position: sticky;
      padding: 12px 14px;
      background: #f4f1eb;
    }

    .brand {
      gap: 4px;
    }

    .brand-row {
      min-height: 36px;
    }

    .brand p:last-child {
      padding-left: 38px;
      font-size: 0.82rem;
      white-space: nowrap;
    }

    .sidebar-stats {
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
      padding-top: 0;
      border-top: 0;
    }

    .sidebar-stats div {
      min-height: auto;
      padding: 9px;
    }

    .sidebar-stats dt {
      font-size: 1.08rem;
    }

    .sidebar-stats dd {
      margin-top: 2px;
      font-size: 0.72rem;
    }

    .main-stage {
      padding: 34px 16px 58px;
    }

    .doc-hero {
      margin: 0 0 18px;
    }

    .doc-hero-actions,
    .doc-graph-link {
      width: 100%;
    }

    .doc-relation-overview {
      grid-template-columns: 1fr;
      gap: 16px;
      padding: 16px 0 18px;
    }

    .doc-relation-map,
    .doc-relation-map svg {
      min-height: 220px;
    }

    .doc-relation-heading {
      align-items: stretch;
      flex-direction: column;
      gap: 12px;
    }

    .doc-relation-stats {
      width: 100%;
    }

    .doc-relation-stats div {
      flex: 1;
    }

    .doc-relation-list li {
      grid-template-columns: 1fr;
    }

    .doc-relation-list small {
      grid-column: 1;
    }

    .doc-graph-action {
      width: 100%;
    }

    .doc-hero h2 {
      font-size: 2.45rem;
    }

    .graph-workspace {
      grid-template-columns: 1fr;
    }

    .graph-canvas-wrap,
    .graph-canvas,
    .graph-inspector {
      min-height: 420px;
    }

    .graph-toolbar,
    .graph-actions {
      align-items: stretch;
      flex-direction: column;
    }

    .graph-filter-tabs,
    .graph-actions {
      width: 100%;
    }

    .graph-legend {
      justify-content: flex-start;
    }

    .graph-filter-tabs button,
    .graph-actions button {
      flex: 1 1 auto;
    }

    .list-controls {
      justify-content: flex-start;
    }

    .list-controls > div:first-child {
      text-align: left;
    }

    .controls-row {
      display: flex;
      flex-wrap: nowrap;
      align-items: center;
      overflow-x: auto;
    }

    .memory-preview {
      padding: 20px 18px 24px;
    }
  }

  /* Human readability polish. */
  :global(body) {
    color: #2d2b27;
    font-kerning: normal;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }

  .main-stage {
    padding-top: clamp(34px, 5vw, 60px);
  }

  .main-stage.memory-stage {
    height: 100vh;
    overflow: hidden;
    padding-bottom: 24px;
  }

  :global(body:has(.main-stage.memory-stage)) {
    overflow: hidden;
  }

  .memory-page {
    gap: 30px;
  }

  .memory-stage .memory-page {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    gap: 18px;
    overflow: hidden;
  }

  .memory-stage .doc-hero {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .memory-page,
  .memory-workspace,
  .sectioned-memory,
  .sectioned-memory > section,
  .object-list,
  .object-list button,
  .object-list button > span,
  .memory-preview,
  .notion-properties,
  .notion-toggle,
  .notion-toggle > :not(summary),
  .markdown-view,
  .json-view,
  .facet-grid,
  .relation-columns {
    min-width: 0;
    max-width: 100%;
  }

  .doc-hero h2 {
    font-size: clamp(2.35rem, 3.8vw, 3.25rem);
    line-height: 1.04;
    font-weight: 820;
  }

  .doc-hero p:not(.eyebrow) {
    color: #68635c;
    line-height: 1.62;
  }

  .projection-status {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: 0;
    max-width: none;
    color: #6c675f;
    font-size: 0.9rem;
    line-height: 1.45;
    white-space: nowrap;
  }

  .projection-status span {
    flex: 0 0 auto;
    margin: 0 8px 0 0;
    border-color: #d8d0c3;
    padding: 3px 10px;
    background: #faf7f1;
    font-weight: 760;
  }

  .list-controls {
    position: sticky;
    top: 0;
    z-index: 4;
    gap: 12px;
    border-bottom-color: #ece6dc;
    padding: 2px 0 28px;
    background: #fffefa;
  }

  .list-controls-heading {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px 18px;
    min-width: 0;
  }

  .list-controls-heading > div {
    min-width: 0;
  }

  .list-controls strong {
    color: #302e2a;
    font-size: 1rem;
    line-height: 1.2;
    font-weight: 780;
  }

  .list-controls span {
    margin-top: 2px;
    color: #858078;
    font-size: 0.93rem;
  }

  .list-controls .projection-status span {
    display: inline-flex;
    margin: 0 8px 0 0;
    color: #37352f;
    font-size: 0.78rem;
  }

  .controls-row {
    gap: 10px;
    min-width: 0;
    padding-bottom: 6px;
  }

  .layer-tabs button,
  .list-controls button {
    min-height: 40px;
    border-color: #dfd8cd;
    padding: 8px 14px;
    color: #5e5950;
    background: #fffdf9;
    font-size: 0.9rem;
    font-weight: 680;
  }

  .layer-tabs button.active {
    border-color: #262522;
    background: #262522;
  }

  .list-controls select {
    min-width: 138px;
    min-height: 40px;
    border-color: #dfd8cd;
    appearance: none;
    -webkit-appearance: none;
    padding-right: 38px;
    padding-left: 14px;
    background-color: #f4f1eb;
    background-image:
      linear-gradient(45deg, transparent 50%, #6c675f 50%),
      linear-gradient(135deg, #6c675f 50%, transparent 50%);
    background-position:
      calc(100% - 18px) 50%,
      calc(100% - 13px) 50%;
    background-repeat: no-repeat;
    background-size: 5px 5px;
    color: #45413b;
    font-size: 0.92rem;
  }

  .sectioned-memory {
    gap: 42px;
  }

  .memory-stage .memory-workspace,
  .memory-stage .sectioned-memory {
    min-height: 0;
  }

  .memory-stage .doc-relation-overview {
    max-height: 280px;
    min-height: 0;
    overflow: hidden;
    padding: 14px 0 16px;
  }

  .memory-stage .doc-relation-map,
  .memory-stage .doc-relation-map svg {
    height: 220px;
    min-height: 220px;
  }

  .memory-stage .doc-relation-copy {
    min-height: 0;
    overflow: hidden;
  }

  .memory-stage .doc-relation-list {
    max-height: 116px;
    overflow-y: auto;
    padding-right: 4px;
  }

  .memory-stage .memory-workspace {
    display: flex;
    flex-direction: column;
    flex: 1 1 0;
    gap: 18px;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding-right: 8px;
    scrollbar-gutter: stable;
  }

  .memory-stage .sectioned-memory {
    overflow: visible;
  }

  .memory-stage .sectioned-memory > section:last-child {
    padding-bottom: 22px;
  }

  .sectioned-memory h3 {
    color: #24231f;
    font-size: clamp(1.58rem, 2.3vw, 1.95rem);
    line-height: 1.12;
    font-weight: 780;
  }

  .sectioned-memory > section > p {
    margin: 7px 0 20px;
    color: #817c74;
    font-size: 1rem;
    line-height: 1.45;
  }

  .object-list {
    gap: 14px;
  }

  .object-list button {
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    min-height: 0;
    border-color: #e6dfd4;
    padding: 18px 22px;
    background: #fffdf9;
    box-shadow:
      0 1px 2px rgb(39 31 21 / 4%),
      0 10px 24px rgb(39 31 21 / 4%);
    transition:
      background-color 140ms ease,
      border-color 140ms ease,
      box-shadow 140ms ease,
      transform 140ms ease;
  }

  .object-list button:hover {
    border-color: #d8cec0;
    background: #fffaf1;
    box-shadow:
      0 2px 5px rgb(39 31 21 / 5%),
      0 14px 30px rgb(39 31 21 / 7%);
    transform: translateY(-1px);
  }

  .object-list button.selected {
    border-color: #d8cec0;
    border-bottom-color: transparent;
    background: #f7f3ec;
  }

  .object-list strong {
    color: #292825;
    font-size: 1.08rem;
    line-height: 1.32;
    font-weight: 760;
    overflow-wrap: anywhere;
  }

  .object-meta {
    gap: 6px 7px;
    margin-top: 8px;
  }

  .object-meta span,
  .pill,
  .tag-list li {
    border-color: #ded6ca;
    background: #f8f5ef;
    color: #59544c;
    font-size: 0.76rem;
    line-height: 1.15;
    font-weight: 680;
    overflow-wrap: anywhere;
  }

  .object-list small {
    max-width: 76ch;
    margin-top: 9px;
    color: #6f6a62;
    font-size: 0.98rem;
    line-height: 1.52;
    overflow-wrap: anywhere;
  }

  .object-list em {
    align-self: center;
    min-width: 34px;
    padding-left: 12px;
    color: #8a847b;
    font-size: 0.93rem;
    font-weight: 650;
  }

  .memory-preview {
    margin-top: -14px;
    border-color: #d8cec0;
    padding: 28px clamp(24px, 5vw, 64px) 34px;
    background: #fffdf9;
    box-shadow: 0 18px 34px rgb(39 31 21 / 6%);
  }

  .notion-properties {
    gap: 2px;
    padding-bottom: 18px;
  }

  .notion-properties div {
    grid-template-columns: 112px minmax(0, 1fr);
    min-height: 30px;
  }

  .notion-properties dt {
    color: #8e887f;
    font-size: 0.86rem;
    font-weight: 700;
  }

  .notion-properties dd {
    color: #3c3934;
    font-size: 0.96rem;
    line-height: 1.45;
  }

  .notion-toggle-list {
    gap: 14px;
  }

  .notion-toggle summary {
    min-height: 34px;
    font-size: 1.01rem;
    font-weight: 720;
  }

  .notion-toggle > :not(summary) {
    padding: 10px 0 20px;
  }

  .memory-preview .markdown-view {
    max-width: 78ch;
    color: #2f3440;
    font-size: 1.04rem;
    line-height: 1.72;
  }

  .memory-preview .markdown-view p {
    margin: 0 0 1rem;
  }

  .memory-preview .markdown-view h3 {
    margin: 0 0 0.75rem;
    color: #24231f;
    font-size: 1.38rem;
    line-height: 1.22;
    font-weight: 780;
  }

  .memory-preview .markdown-view ul {
    margin: 0 0 1rem;
    padding-left: 1.2rem;
  }

  .memory-preview .markdown-view li + li {
    margin-top: 0.38rem;
  }

  .relation-list {
    gap: 11px;
  }

  .relation-list li {
    gap: 6px;
  }

  .relation-list button {
    line-height: 1.35;
    font-weight: 760;
  }

  .relation-list small {
    color: #777169;
    line-height: 1.4;
  }

  @media (max-width: 900px) {
    .main-stage {
      padding: 28px 14px 52px;
    }

    .main-stage.memory-stage {
      height: calc(100vh - 68px);
      height: calc(100svh - 68px);
      padding: 18px 14px 16px;
    }

    .memory-page {
      gap: 22px;
    }

    .memory-stage .memory-page {
      gap: 14px;
    }

    .memory-stage .doc-hero {
      gap: 6px;
    }

    .memory-stage .doc-icon,
    .memory-stage .doc-hero p:not(.eyebrow) {
      display: none;
    }

    .memory-stage .doc-hero h2 {
      font-size: 1.45rem;
      line-height: 1.12;
    }

    .list-controls {
      padding-bottom: 16px;
    }

    .list-controls-heading {
      grid-template-columns: 1fr;
      align-items: start;
      gap: 8px;
    }

    .projection-status {
      align-items: flex-start;
      flex-wrap: wrap;
      white-space: normal;
    }

    .memory-stage .doc-relation-overview {
      gap: 12px;
      padding: 12px 0 14px;
    }

    .memory-stage .doc-relation-map,
    .memory-stage .doc-relation-map svg {
      height: 172px;
      min-height: 172px;
    }

    .memory-stage .doc-relation-list {
      max-height: 118px;
      overflow-y: auto;
      padding-right: 4px;
    }

    .sectioned-memory {
      gap: 34px;
    }

    .memory-stage .memory-workspace {
      padding-right: 0;
      scrollbar-gutter: auto;
    }

    .sectioned-memory h3 {
      font-size: 1.5rem;
    }

    .object-list button {
      grid-template-columns: minmax(0, 1fr) auto;
      padding: 16px;
    }

    .object-list em {
      grid-column: 2;
      justify-self: start;
      padding-left: 0;
    }

    .memory-preview {
      margin-top: -14px;
      padding: 22px 18px 28px;
    }

    .notion-properties div,
    .facet-grid div {
      grid-template-columns: 1fr;
      gap: 2px;
    }

    .relation-columns {
      grid-template-columns: 1fr;
      gap: 18px;
    }
  }

  @media (max-width: 560px) {
    .object-list button {
      grid-template-columns: 1fr;
    }

    .object-list em {
      grid-column: 1;
    }

    .memory-preview .markdown-view {
      font-size: 1rem;
    }
  }

  .main-stage.memory-stage {
    padding-right: clamp(18px, 2vw, 32px);
    padding-left: clamp(18px, 2vw, 32px);
  }

  .memory-stage .memory-page {
    width: 100%;
    max-width: none;
  }

  .memory-stage .list-controls {
    flex: 0 0 auto;
  }

  .schema-browser-layout {
    display: grid;
    grid-template-columns: minmax(260px, 0.3fr) minmax(0, 1fr);
    gap: clamp(16px, 2vw, 24px);
    min-height: 0;
    flex: 1 1 0;
    overflow: hidden;
  }

  .schema-context-panel {
    min-width: 0;
    min-height: 0;
  }

  .schema-context-panel > summary {
    display: none;
  }

  .schema-context-panel:not([open]) > :not(summary) {
    display: none;
  }

  .memory-stage .doc-relation-overview {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 14px;
    align-content: start;
    max-height: none;
    min-height: 0;
    overflow: visible;
    border-top: 0;
    padding: 0;
  }

  .memory-stage .doc-relation-map {
    height: min(28vh, 260px);
    min-height: 210px;
  }

  .memory-stage .doc-relation-map svg {
    height: 100%;
    min-height: 210px;
  }

  .memory-stage .doc-relation-copy,
  .memory-stage .doc-relation-list {
    max-height: none;
    overflow: visible;
  }

  .memory-stage .doc-relation-list {
    padding-right: 0;
  }

  .doc-relation-more {
    color: #817c74;
    font-size: 0.9rem;
    font-weight: 700;
  }

  .memory-stage .memory-workspace {
    min-height: 0;
    overflow-y: auto;
    padding-right: 8px;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
  }

  .browser-workspace-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 18px;
    min-width: 0;
  }

  .memory-workspace.has-preview .browser-workspace-grid {
    grid-template-columns: minmax(340px, 0.92fr) minmax(420px, 1.08fr);
    align-items: start;
  }

  .object-detail-panel {
    align-self: start;
    margin: 0 0 24px;
    border: 1px solid #d8cec0;
    border-radius: 8px;
    padding: 24px clamp(22px, 3vw, 42px) 30px;
  }

  .memory-preview-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    min-width: 0;
  }

  .memory-preview-header h3 {
    margin: 3px 0 0;
    color: #24231f;
    font-size: clamp(1.4rem, 2vw, 1.75rem);
    line-height: 1.14;
    font-weight: 800;
    overflow-wrap: anywhere;
  }

  .memory-preview-header .mono {
    margin: 5px 0 0;
    color: #6f6a62;
    font-size: 0.86rem;
    overflow-wrap: anywhere;
  }

  .selected-object-back {
    display: none;
  }

  .memory-stage .object-list button.selected {
    border-bottom-color: #d8cec0;
    border-radius: 8px;
  }

  @media (max-width: 1180px) {
    .schema-browser-layout {
      grid-template-columns: minmax(240px, 0.3fr) minmax(0, 1fr);
      gap: 18px;
    }

    .memory-workspace.has-preview .browser-workspace-grid {
      grid-template-columns: minmax(300px, 0.85fr) minmax(360px, 1.15fr);
    }
  }

  @media (max-width: 900px) {
    .main-stage.memory-stage {
      padding-right: 14px;
      padding-left: 14px;
    }

    .schema-browser-layout {
      display: flex;
      flex-direction: column;
      gap: 14px;
      overflow: visible;
    }

    .schema-context-panel {
      display: block;
      flex: 0 0 auto;
      overflow: visible;
    }

    .schema-context-panel[open] {
      display: block;
    }

    .schema-context-panel > summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      min-height: 44px;
      border: 1px solid #e3dfd7;
      border-radius: 8px;
      padding: 10px 12px;
      background: #fffdf9;
      color: #302e2a;
      cursor: pointer;
      list-style: none;
    }

    .schema-context-panel > summary::-webkit-details-marker {
      display: none;
    }

    .schema-context-panel > summary::after {
      content: "View";
      flex: 0 0 auto;
      color: #6c675f;
      font-size: 0.82rem;
      font-weight: 780;
    }

    .schema-context-panel[open] > summary::after {
      content: "Hide";
    }

    .schema-context-panel > summary strong,
    .schema-context-panel > summary small {
      display: block;
      line-height: 1.2;
    }

    .schema-context-panel > summary small {
      margin-top: 2px;
      color: #817c74;
      font-size: 0.8rem;
      font-weight: 620;
    }

    .schema-context-panel[open] .doc-relation-overview,
    .schema-context-panel[open] .doc-hero-actions {
      margin-top: 10px;
    }

    .memory-stage .doc-relation-map,
    .memory-stage .doc-relation-map svg {
      height: 148px;
      min-height: 148px;
    }

    .memory-stage .doc-relation-overview {
      gap: 10px;
    }

    .memory-stage .doc-relation-copy {
      display: block;
    }

    .memory-stage .doc-relation-heading {
      display: block;
    }

    .memory-stage .doc-relation-heading > div,
    .memory-stage .doc-relation-stats,
    .memory-stage .doc-relation-list {
      display: none;
    }

    .memory-stage .doc-graph-action {
      width: 100%;
      min-height: 38px;
      padding: 9px 12px;
    }

    .memory-stage .doc-relation-list {
      max-height: none;
      overflow: visible;
      padding-right: 0;
    }

    .browser-workspace-grid,
    .memory-workspace.has-preview .browser-workspace-grid {
      display: block;
    }

    .object-detail-panel {
      margin: 0 0 18px;
      padding: 20px 16px 28px;
    }

    .memory-preview-header {
      display: grid;
      gap: 12px;
    }

    .selected-object-back {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      justify-self: start;
      min-height: 38px;
      border: 1px solid #d8d0c3;
      border-radius: 8px;
      padding: 8px 13px;
      background: #fffaf1;
      color: #302e2a;
      font-weight: 780;
    }

    .main-stage.memory-stage.has-selected-object {
      height: auto;
      min-height: calc(100vh - 68px);
      min-height: calc(100svh - 68px);
      overflow: visible;
    }

    :global(body:has(.main-stage.memory-stage.has-selected-object)) {
      overflow: auto;
    }

    .memory-stage.has-selected-object .memory-page,
    .memory-stage.has-selected-object .schema-browser-layout,
    .memory-stage.has-selected-object .memory-workspace,
    .memory-stage.has-selected-object .browser-workspace-grid {
      display: block;
      height: auto;
      min-height: 0;
      overflow: visible;
    }

    .memory-stage.has-selected-object .list-controls,
    .memory-stage.has-selected-object .schema-context-panel,
    .memory-stage.has-selected-object .warnings,
    .memory-stage.has-selected-object .onboarding-callout,
    .memory-stage.has-selected-object .sectioned-memory {
      display: none;
    }
  }

  /* Collapsed navigation drawer. */
  .viewer-shell {
    display: block;
    min-height: 100vh;
  }

  .sidebar-toggle {
    position: fixed;
    top: 18px;
    left: 18px;
    z-index: 60;
    display: inline-flex;
    align-items: center;
    gap: 10px;
    min-height: 42px;
    border: 1px solid #d8d0c3;
    border-radius: 8px;
    padding: 0 14px 0 12px;
    color: #2f2e2a;
    background: #fffdf9;
    font-size: 0.92rem;
    font-weight: 800;
    box-shadow:
      0 1px 2px rgb(39 31 21 / 6%),
      0 10px 28px rgb(39 31 21 / 8%);
  }

  .sidebar-toggle:hover,
  .sidebar-toggle.open {
    border-color: #262522;
    background: #262522;
    color: #fffefa;
  }

  .sidebar-toggle:focus-visible,
  .sidebar-backdrop:focus-visible {
    outline: 3px solid rgb(47 93 98 / 28%);
    outline-offset: 3px;
  }

  .burger-icon {
    position: relative;
    width: 16px;
    height: 12px;
    border-top: 2px solid currentColor;
    border-bottom: 2px solid currentColor;
  }

  .burger-icon::before {
    position: absolute;
    top: 3px;
    left: 0;
    width: 16px;
    height: 2px;
    background: currentColor;
    content: "";
  }

  .sidebar-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    border: 0;
    padding: 0;
    background: rgb(36 34 30 / 34%);
    cursor: default;
  }

  .sidebar {
    position: fixed;
    inset: 0 auto 0 0;
    z-index: 50;
    display: flex;
    width: min(340px, calc(100vw - 32px));
    height: 100dvh;
    max-height: 100dvh;
    overflow-y: auto;
    flex-direction: column;
    gap: 28px;
    border-right: 1px solid #dedbd2;
    padding: 82px 28px 30px;
    background: #f4f1eb;
    box-shadow:
      24px 0 70px rgb(39 31 21 / 18%),
      3px 0 12px rgb(39 31 21 / 10%);
    scrollbar-gutter: stable;
  }

  .sidebar-menu,
  .sidebar-menu.open {
    position: static;
    display: grid;
    gap: 24px;
    max-height: none;
    overflow: visible;
    border: 0;
    border-radius: 0;
    padding: 0;
    background: transparent;
    box-shadow: none;
  }

  .main-stage {
    width: 100%;
    padding-top: max(88px, clamp(34px, 5vw, 60px));
  }

  .main-stage.memory-stage {
    height: 100vh;
  }

  @media (max-width: 900px) {
    .sidebar {
      position: fixed;
      top: 0;
      height: 100dvh;
      padding: 76px 18px 24px;
      border-bottom: 0;
      background: #f4f1eb;
      box-shadow:
        18px 0 52px rgb(39 31 21 / 18%),
        2px 0 10px rgb(39 31 21 / 10%);
    }

    .brand {
      gap: 10px;
    }

    .brand p:last-child {
      padding-left: 0;
      white-space: normal;
    }

    .sidebar-stats {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }

    .main-stage {
      padding-top: 88px;
    }

    .schema-browser-toolbar {
      align-items: stretch;
      flex-direction: column;
    }

    .schema-sort-field {
      justify-content: space-between;
      width: 100%;
    }

    .schema-sort-select {
      min-width: min(210px, 62vw);
    }
  }

  @media (max-width: 560px) {
    .sidebar-toggle {
      top: 10px;
      left: 10px;
      min-height: 40px;
      padding-inline: 11px 13px;
    }

    .sidebar {
      width: calc(100vw - 20px);
      padding: 70px 14px 22px;
    }

    .main-stage {
      padding-top: 78px;
    }

    .schema-sort-field {
      align-items: stretch;
      flex-direction: column;
      gap: 6px;
    }

    .schema-sort-select {
      width: 100%;
      min-width: 0;
    }
  }

  @media print {
    .sidebar-toggle,
    .sidebar-backdrop,
    .sidebar {
      display: none;
    }
  }
</style>
