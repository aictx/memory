import path from "node:path";

import { memoryError } from "./errors.js";
import { readUtf8FileInsideRoot } from "./fs.js";
import { err, ok, type Result } from "./result.js";
import {
  runSubprocess,
  type RunSubprocessOptions,
  type SubprocessResult
} from "./subprocess.js";
import type { GitState } from "./types.js";

const MEMORY_PATHSPEC = ".memory";
const IGNORED_DIRTY_PATHS = [
  ".memory/index/",
  ".memory/context/",
  ".memory/exports/",
  ".memory/recovery/"
] as const;
const IGNORED_DIRTY_FILES = [".memory/.lock"] as const;
const IGNORED_PROJECT_CHANGE_PREFIXES = [
  ".memory/",
  ".cache/",
  ".next/",
  ".svelte-kit/",
  ".turbo/",
  ".vite/",
  "build/",
  "coverage/",
  "dist/",
  "dist-types/",
  "node_modules/",
  "out/",
  "target/",
  "temp/",
  "tmp/"
] as const;
const IGNORED_PROJECT_CHANGE_FILES = [".memory"] as const;
const LOG_FIELD_SEPARATOR = "\u001f";

export interface GitWrapperOptions {
  runner?: RunSubprocessOptions["runner"];
}

export interface GitRootStatus {
  available: boolean;
  root: string | null;
}

export interface MemoryDirtyState {
  dirty: boolean;
  files: string[];
  unmergedFiles: string[];
}

export interface MemoryDiff {
  diff: string;
  changedFiles: string[];
  untrackedFiles: string[];
}

export interface ProjectChangedFiles {
  changedFiles: string[];
}

export interface CommittedFileChange {
  /** First letter of the `--name-status` code: A, M, D, R, C, or T. */
  status: string;
  /** Current (new) repo-relative path. */
  path: string;
  /** Previous path for renames and copies, otherwise null. */
  oldPath: string | null;
}

export interface TrackedMemoryDirtyFiles {
  files: string[];
}

export interface MemoryLogEntry {
  commit: string;
  shortCommit: string;
  unixTimestamp: number;
  subject: string;
}

export interface MemoryFileAtCommit {
  commit: string;
  path: string;
  contents: string;
}

export interface ProjectFileChange {
  file: string;
  commit: string;
  shortCommit: string;
  timestamp: string;
  subject: string;
}

export interface RecentProjectFileChanges {
  changes: ProjectFileChange[];
}

export interface RecentProjectFileChangesOptions extends GitWrapperOptions {
  files: readonly string[];
  historyWindow?: string | null;
  limit?: number;
}

interface GitCommandOptions extends GitWrapperOptions {
  gitUnavailableOk?: boolean;
}

export async function findGitRoot(
  cwd: string,
  options: GitWrapperOptions = {}
): Promise<Result<GitRootStatus>> {
  const result = await runGit(["rev-parse", "--show-toplevel"], cwd, {
    ...options,
    gitUnavailableOk: true
  });

  if (!result.ok) {
    return result;
  }

  if (result.data.exitCode !== 0) {
    return ok({ available: false, root: null });
  }

  return ok({ available: true, root: result.data.stdout.trim() });
}

export async function getGitState(
  cwd: string,
  options: GitWrapperOptions = {}
): Promise<Result<GitState>> {
  const root = await findGitRoot(cwd, options);

  if (!root.ok) {
    return root;
  }

  if (!root.data.available || root.data.root === null) {
    return ok({
      available: false,
      branch: null,
      commit: null,
      dirty: null
    });
  }

  const projectRoot = root.data.root;
  const [branchResult, commitResult, dirtyResult] = await Promise.all([
    getCurrentGitBranch(projectRoot, options),
    getCurrentCommit(projectRoot, options),
    getMemoryDirtyState(projectRoot, options)
  ]);

  if (!branchResult.ok) {
    return branchResult;
  }

  if (!commitResult.ok) {
    return commitResult;
  }

  if (!dirtyResult.ok) {
    return dirtyResult;
  }

  return ok({
    available: true,
    branch: branchResult.data,
    commit: commitResult.data,
    dirty: dirtyResult.data.dirty
  });
}

export async function getMemoryDirtyState(
  projectRoot: string,
  options: GitWrapperOptions = {}
): Promise<Result<MemoryDirtyState>> {
  const result = await runGit(
    ["status", "--porcelain=v1", "--", MEMORY_PATHSPEC],
    projectRoot,
    options
  );

  if (!result.ok) {
    return result;
  }

  if (result.data.exitCode !== 0) {
    return gitCommandFailed("Git status failed.", result.data);
  }

  const entries = result.data.stdout
    .split("\n")
    .map(parsePorcelainStatusLine)
    .filter((entry): entry is PorcelainStatusEntry => entry !== null)
    .filter((entry) => !isIgnoredDirtyPath(entry.path));

  const files = uniqueSorted(entries.map((entry) => entry.path));
  const unmergedFiles = uniqueSorted(
    entries.filter((entry) => isUnmergedStatus(entry.status)).map((entry) => entry.path)
  );

  return ok({
    dirty: files.length > 0,
    files,
    unmergedFiles
  });
}

export async function getTrackedMemoryDirtyFiles(
  projectRoot: string,
  options: GitWrapperOptions = {}
): Promise<Result<TrackedMemoryDirtyFiles>> {
  const dirtyState = await getMemoryDirtyState(projectRoot, options);

  if (!dirtyState.ok) {
    return dirtyState;
  }

  const trackedFiles = await filterTrackedFiles(projectRoot, dirtyState.data.files, options);

  if (!trackedFiles.ok) {
    return trackedFiles;
  }

  return ok({
    files: trackedFiles.data
  });
}

export async function filterTrackedFiles(
  projectRoot: string,
  files: readonly string[],
  options: GitWrapperOptions = {}
): Promise<Result<string[]>> {
  const tracked: string[] = [];

  for (const file of files) {
    const trackedFile = await isTrackedFile(projectRoot, file, options);

    if (!trackedFile.ok) {
      return trackedFile;
    }

    if (trackedFile.data) {
      tracked.push(file);
    }
  }

  return ok(tracked);
}

export async function getMemoryDiff(
  projectRoot: string,
  options: GitWrapperOptions = {}
): Promise<Result<MemoryDiff>> {
  const result = await runGit(["diff", "--", MEMORY_PATHSPEC], projectRoot, options);

  if (!result.ok) {
    return result;
  }

  if (result.data.exitCode !== 0) {
    return gitCommandFailed("Git diff failed.", result.data);
  }

  const untrackedFiles = await getUntrackedMemoryFiles(projectRoot, options);

  if (!untrackedFiles.ok) {
    return untrackedFiles;
  }

  const untrackedDiff = await renderUntrackedMemoryDiff(
    projectRoot,
    untrackedFiles.data
  );

  if (!untrackedDiff.ok) {
    return untrackedDiff;
  }

  const trackedChangedFiles = parseDiffChangedFiles(result.data.stdout);

  return ok({
    diff: appendDiff(result.data.stdout, untrackedDiff.data),
    changedFiles: uniqueSorted([...trackedChangedFiles, ...untrackedFiles.data]),
    untrackedFiles: untrackedFiles.data
  });
}

export async function getChangedProjectFiles(
  projectRoot: string,
  options: GitWrapperOptions = {}
): Promise<Result<ProjectChangedFiles>> {
  const result = await runGit(
    ["status", "--porcelain=v1", "--untracked-files=all", "--", "."],
    projectRoot,
    options
  );

  if (!result.ok) {
    return result;
  }

  if (result.data.exitCode !== 0) {
    return gitCommandFailed("Git project status failed.", result.data);
  }

  const changedFiles = result.data.stdout
    .split("\n")
    .map(parseStatusChangedPath)
    .filter((file): file is string => file !== null)
    .filter((file) => !isIgnoredProjectChangePath(file));

  return ok({
    changedFiles: uniqueSorted(changedFiles)
  });
}

/**
 * Lists committed file changes between `base` and HEAD via
 * `git diff --name-status -M`, with rename detection so old→new path pairs
 * are preserved. Entries are returned raw; callers decide which paths to
 * ignore (for example `.memory/**`).
 */
export async function getChangedFilesBetween(
  projectRoot: string,
  base: string,
  options: GitWrapperOptions = {}
): Promise<Result<CommittedFileChange[]>> {
  const revision = validateGitRevision(base);

  if (!revision.ok) {
    return revision;
  }

  const result = await runGit(
    ["diff", "--name-status", "-M", revision.data, "HEAD"],
    projectRoot,
    options
  );

  if (!result.ok) {
    return result;
  }

  if (result.data.exitCode !== 0) {
    return gitCommandFailed("Git committed-change listing failed.", result.data);
  }

  return ok(parseNameStatusLines(result.data.stdout));
}

/**
 * Reports whether `ancestor` is an ancestor of `descendant` using
 * `git merge-base --is-ancestor`. Any non-zero exit (including unknown
 * revisions) is reported as "not an ancestor" so callers can fall back to
 * `getMergeBase` and then to full verification.
 */
export async function isAncestorCommit(
  projectRoot: string,
  ancestor: string,
  descendant: string,
  options: GitWrapperOptions = {}
): Promise<Result<boolean>> {
  const ancestorRevision = validateGitRevision(ancestor);

  if (!ancestorRevision.ok) {
    return ancestorRevision;
  }

  const descendantRevision = validateGitRevision(descendant);

  if (!descendantRevision.ok) {
    return descendantRevision;
  }

  const result = await runGit(
    ["merge-base", "--is-ancestor", ancestorRevision.data, descendantRevision.data],
    projectRoot,
    options
  );

  if (!result.ok) {
    return result;
  }

  return ok(result.data.exitCode === 0);
}

/**
 * Resolves the merge base of two revisions. Returns null when Git cannot
 * compute one (unknown revision or unrelated histories) instead of failing,
 * so callers can degrade to full verification.
 */
export async function getMergeBase(
  projectRoot: string,
  left: string,
  right: string,
  options: GitWrapperOptions = {}
): Promise<Result<string | null>> {
  const leftRevision = validateGitRevision(left);

  if (!leftRevision.ok) {
    return leftRevision;
  }

  const rightRevision = validateGitRevision(right);

  if (!rightRevision.ok) {
    return rightRevision;
  }

  const result = await runGit(
    ["merge-base", leftRevision.data, rightRevision.data],
    projectRoot,
    options
  );

  if (!result.ok) {
    return result;
  }

  if (result.data.exitCode !== 0) {
    return ok(null);
  }

  const base = result.data.stdout.trim();
  return ok(base === "" ? null : base);
}

/**
 * Lists repo-relative file paths known to the working tree: tracked files
 * from `git ls-files` unioned with untracked-but-present files from
 * `git status --porcelain --untracked-files=all` additions, so anchors
 * pointing at brand-new uncommitted files do not read as orphaned.
 *
 * Returns null when the project is not a Git worktree so anchor
 * verification can be skipped silently.
 */
export async function listTrackedFiles(
  projectRoot: string,
  options: GitWrapperOptions = {}
): Promise<Result<string[] | null>> {
  const root = await findGitRoot(projectRoot, options);

  if (!root.ok) {
    return root;
  }

  if (!root.data.available) {
    return ok(null);
  }

  const tracked = await runGit(["ls-files"], projectRoot, options);

  if (!tracked.ok) {
    return tracked;
  }

  if (tracked.data.exitCode !== 0) {
    return gitCommandFailed("Git tracked-file listing failed.", tracked.data);
  }

  const status = await runGit(
    ["status", "--porcelain=v1", "--untracked-files=all", "--", "."],
    projectRoot,
    options
  );

  if (!status.ok) {
    return status;
  }

  if (status.data.exitCode !== 0) {
    return gitCommandFailed("Git untracked-file listing failed.", status.data);
  }

  const trackedFiles = tracked.data.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => unquoteGitPath(line));
  const untrackedFiles = status.data.stdout
    .split("\n")
    .filter((line) => line.startsWith("??"))
    .map(parseStatusChangedPath)
    .filter((file): file is string => file !== null)
    .filter((file) => !file.endsWith("/"));

  return ok(uniqueSorted([...trackedFiles, ...untrackedFiles]));
}

async function getUntrackedMemoryFiles(
  projectRoot: string,
  options: GitWrapperOptions = {}
): Promise<Result<string[]>> {
  const result = await runGit(
    ["status", "--porcelain=v1", "--untracked-files=all", "--", MEMORY_PATHSPEC],
    projectRoot,
    options
  );

  if (!result.ok) {
    return result;
  }

  if (result.data.exitCode !== 0) {
    return gitCommandFailed("Git untracked-file detection failed.", result.data);
  }

  const files = result.data.stdout
    .split("\n")
    .map(parsePorcelainStatusLine)
    .filter((entry): entry is PorcelainStatusEntry => entry !== null)
    .filter((entry) => entry.status === "??")
    .map((entry) => entry.path)
    .filter((file) => file.startsWith(".memory/"))
    .filter((file) => !file.endsWith("/"))
    .filter((file) => !isIgnoredDirtyPath(file));

  return ok(uniqueSorted(files));
}

async function renderUntrackedMemoryDiff(
  projectRoot: string,
  files: readonly string[]
): Promise<Result<string>> {
  const hunks: string[] = [];

  for (const file of files) {
    const contents = await readUtf8FileInsideRoot(projectRoot, file);

    if (!contents.ok) {
      return contents;
    }

    hunks.push(renderNewFileDiff(file, contents.data));
  }

  return ok(hunks.join(""));
}

function renderNewFileDiff(file: string, contents: string): string {
  const lines = [
    `diff --git a/${file} b/${file}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${file}`
  ];
  const bodyLines = diffBodyLines(contents);

  if (bodyLines.length > 0) {
    lines.push(`@@ -0,0 +1,${bodyLines.length} @@`);
    lines.push(...bodyLines.map((line) => `+${line}`));

    if (!contents.endsWith("\n")) {
      lines.push("\\ No newline at end of file");
    }
  }

  return `${lines.join("\n")}\n`;
}

function diffBodyLines(contents: string): string[] {
  if (contents === "") {
    return [];
  }

  const lines = contents.split("\n");

  if (contents.endsWith("\n")) {
    lines.pop();
  }

  return lines;
}

function appendDiff(trackedDiff: string, untrackedDiff: string): string {
  if (trackedDiff === "") {
    return untrackedDiff;
  }

  if (untrackedDiff === "") {
    return trackedDiff;
  }

  return trackedDiff.endsWith("\n")
    ? `${trackedDiff}${untrackedDiff}`
    : `${trackedDiff}\n${untrackedDiff}`;
}

export async function getMemoryLog(
  projectRoot: string,
  options: GitWrapperOptions = {}
): Promise<Result<MemoryLogEntry[]>> {
  const result = await runGit(
    [
      "log",
      `--format=%H${LOG_FIELD_SEPARATOR}%h${LOG_FIELD_SEPARATOR}%ct${LOG_FIELD_SEPARATOR}%s`,
      "--",
      MEMORY_PATHSPEC
    ],
    projectRoot,
    options
  );

  if (!result.ok) {
    return result;
  }

  if (result.data.exitCode !== 0) {
    return gitCommandFailed("Git log failed.", result.data);
  }

  return ok(parseLogEntries(result.data.stdout));
}

export async function showMemoryFileAtCommit(
  projectRoot: string,
  commit: string,
  filePath: string,
  options: GitWrapperOptions = {}
): Promise<Result<MemoryFileAtCommit>> {
  const revision = validateGitRevision(commit);

  if (!revision.ok) {
    return revision;
  }

  const normalizedPath = normalizeMemoryFilePath(filePath);

  if (!normalizedPath.ok) {
    return normalizedPath;
  }

  const result = await runGit(
    ["show", `${revision.data}:${normalizedPath.data}`],
    projectRoot,
    options
  );

  if (!result.ok) {
    return result;
  }

  if (result.data.exitCode !== 0) {
    return gitCommandFailed("Git show failed.", result.data);
  }

  return ok({
    commit: revision.data,
    path: normalizedPath.data,
    contents: result.data.stdout
  });
}

export async function getRecentProjectFileChanges(
  projectRoot: string,
  options: RecentProjectFileChangesOptions
): Promise<Result<RecentProjectFileChanges>> {
  const files = uniqueSorted(
    options.files
      .map(normalizeProjectFilePath)
      .filter((file): file is string => file !== null)
  );

  if (files.length === 0) {
    return ok({ changes: [] });
  }

  const limit = options.limit ?? 50;

  if (!Number.isSafeInteger(limit) || limit < 1) {
    return err(
      memoryError("MemoryValidationFailed", "Git file history limit must be positive.", {
        field: "limit",
        actual: limit
      })
    );
  }

  const args = [
    "log",
    `--format=%H${LOG_FIELD_SEPARATOR}%h${LOG_FIELD_SEPARATOR}%aI${LOG_FIELD_SEPARATOR}%s`,
    `--max-count=${limit}`,
    ...historyWindowArgs(options.historyWindow),
    "--name-only",
    "--",
    ...files
  ];
  const result = await runGit(args, projectRoot, options);

  if (!result.ok) {
    return result;
  }

  if (result.data.exitCode !== 0) {
    return gitCommandFailed("Git file history failed.", result.data);
  }

  return ok({
    changes: parseProjectFileChanges(result.data.stdout, new Set(files))
  });
}

export async function restoreMemoryFromCommit(
  projectRoot: string,
  commit: string,
  options: GitWrapperOptions = {}
): Promise<Result<void>> {
  const revision = validateGitRevision(commit);

  if (!revision.ok) {
    return revision;
  }

  const result = await runGit(
    ["restore", "--source", revision.data, "--", MEMORY_PATHSPEC],
    projectRoot,
    options
  );

  if (!result.ok) {
    return result;
  }

  if (result.data.exitCode !== 0) {
    return gitCommandFailed("Git restore failed.", result.data);
  }

  return ok(undefined);
}

export async function getCurrentGitBranch(
  projectRoot: string,
  options: GitWrapperOptions = {}
): Promise<Result<string | null>> {
  const result = await runGit(["symbolic-ref", "--short", "-q", "HEAD"], projectRoot, options);

  if (!result.ok) {
    return result;
  }

  if (result.data.exitCode === 0) {
    const branch = result.data.stdout.trim();
    return ok(branch === "" ? null : branch);
  }

  if (result.data.exitCode === 1) {
    return ok(null);
  }

  return gitCommandFailed("Git branch detection failed.", result.data);
}

async function getCurrentCommit(
  projectRoot: string,
  options: GitWrapperOptions
): Promise<Result<string>> {
  const result = await runGit(["rev-parse", "HEAD"], projectRoot, options);

  if (!result.ok) {
    return result;
  }

  if (result.data.exitCode !== 0) {
    return gitCommandFailed("Git commit detection failed.", result.data);
  }

  return ok(result.data.stdout.trim());
}

async function runGit(
  args: readonly string[],
  cwd: string,
  options: GitCommandOptions
): Promise<Result<SubprocessResult>> {
  const subprocessOptions: RunSubprocessOptions = { cwd };

  if (options.runner !== undefined) {
    subprocessOptions.runner = options.runner;
  }

  const result = await runSubprocess("git", args, subprocessOptions);

  if (!result.ok) {
    return err(
      memoryError("MemoryGitOperationFailed", "Git operation failed.", {
        message: result.error.message
      })
    );
  }

  if (
    result.data.exitCode !== 0 &&
    options.gitUnavailableOk !== true &&
    isGitUnavailableResult(result.data)
  ) {
    return err(memoryError("MemoryGitRequired", "Git is required for this operation."));
  }

  return result;
}

interface PorcelainStatusEntry {
  status: string;
  path: string;
}

function parsePorcelainStatusLine(line: string): PorcelainStatusEntry | null {
  const status = line.slice(0, 2);
  const path = parseStatusChangedPath(line);

  if (path === null || (!path.startsWith(".memory/") && path !== ".memory")) {
    return null;
  }

  return { status, path };
}

function parseStatusChangedPath(line: string): string | null {
  if (line.length < 4) {
    return null;
  }

  const rawPath = line.slice(3);
  return unquoteGitPath(
    rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) ?? rawPath : rawPath
  );
}

function isUnmergedStatus(status: string): boolean {
  return ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(status);
}

function isIgnoredDirtyPath(filePath: string): boolean {
  return (
    IGNORED_DIRTY_FILES.includes(filePath as (typeof IGNORED_DIRTY_FILES)[number]) ||
    IGNORED_DIRTY_PATHS.some((ignoredPath) => filePath.startsWith(ignoredPath))
  );
}

export function isIgnoredProjectChangePath(filePath: string): boolean {
  return (
    IGNORED_PROJECT_CHANGE_FILES.includes(
      filePath as (typeof IGNORED_PROJECT_CHANGE_FILES)[number]
    ) || IGNORED_PROJECT_CHANGE_PREFIXES.some((ignoredPath) => filePath.startsWith(ignoredPath))
  );
}

function parseNameStatusLines(stdout: string): CommittedFileChange[] {
  const changes: CommittedFileChange[] = [];

  for (const line of stdout.split("\n")) {
    if (line === "") {
      continue;
    }

    const fields = line.split("\t");
    const status = fields[0]?.charAt(0) ?? "";

    if (status === "") {
      continue;
    }

    if ((status === "R" || status === "C") && fields.length >= 3) {
      const oldPath = unquoteGitPath(fields[1] ?? "");
      const newPath = unquoteGitPath(fields[2] ?? "");

      if (newPath !== "") {
        changes.push({
          status,
          path: newPath,
          oldPath: oldPath === "" ? null : oldPath
        });
      }

      continue;
    }

    const path = unquoteGitPath(fields[1] ?? "");

    if (path !== "") {
      changes.push({ status, path, oldPath: null });
    }
  }

  return changes;
}

function parseDiffChangedFiles(diff: string): string[] {
  const files: string[] = [];

  for (const line of diff.split("\n")) {
    if (!line.startsWith("diff --git ")) {
      continue;
    }

    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);

    if (match?.[2] !== undefined && match[2].startsWith(".memory/")) {
      files.push(unquoteGitPath(match[2]));
    }
  }

  return uniqueSorted(files);
}

function parseLogEntries(stdout: string): MemoryLogEntry[] {
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [commit = "", shortCommit = "", timestamp = "0", subject = ""] =
        line.split(LOG_FIELD_SEPARATOR);

      return {
        commit,
        shortCommit,
        unixTimestamp: Number.parseInt(timestamp, 10),
        subject
      };
    });
}

function parseProjectFileChanges(
  stdout: string,
  requestedFiles: ReadonlySet<string>
): ProjectFileChange[] {
  const changes: ProjectFileChange[] = [];
  let current:
    | {
        commit: string;
        shortCommit: string;
        timestamp: string;
        subject: string;
      }
    | null = null;

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();

    if (line === "") {
      continue;
    }

    if (line.includes(LOG_FIELD_SEPARATOR)) {
      const [commit = "", shortCommit = "", timestamp = "", subject = ""] =
        line.split(LOG_FIELD_SEPARATOR);

      current = {
        commit,
        shortCommit,
        timestamp,
        subject
      };
      continue;
    }

    if (current === null) {
      continue;
    }

    const file = normalizeProjectFilePath(line);

    if (file === null || (!requestedFiles.has(".") && !requestedFiles.has(file))) {
      continue;
    }

    changes.push({
      file,
      ...current
    });
  }

  return uniqueProjectFileChanges(changes);
}

function historyWindowArgs(historyWindow: string | null | undefined): string[] {
  if (historyWindow === null || historyWindow === undefined) {
    return [];
  }

  const match = /^([1-9][0-9]{0,3})([dwmy])$/u.exec(historyWindow);

  if (match === null || match[1] === undefined || match[2] === undefined) {
    return [];
  }

  const unit = new Map([
    ["d", "days"],
    ["w", "weeks"],
    ["m", "months"],
    ["y", "years"]
  ]).get(match[2]);

  if (unit === undefined) {
    return [];
  }

  return [`--since=${match[1]} ${unit} ago`];
}

function normalizeProjectFilePath(filePath: string): string | null {
  const slashPath = filePath.trim().replaceAll("\\", "/").replace(/^\.\//u, "");

  if (
    slashPath === "" ||
    path.posix.isAbsolute(slashPath) ||
    slashPath.startsWith("../") ||
    slashPath.includes("/../") ||
    slashPath.includes("\0") ||
    slashPath.includes("://") ||
    isIgnoredProjectChangePath(slashPath)
  ) {
    return null;
  }

  return path.posix.normalize(slashPath);
}

async function isTrackedFile(
  projectRoot: string,
  file: string,
  options: GitWrapperOptions
): Promise<Result<boolean>> {
  const result = await runGit(["ls-files", "--error-unmatch", "--", file], projectRoot, options);

  if (!result.ok) {
    return result;
  }

  if (result.data.exitCode === 0) {
    return ok(true);
  }

  if (result.data.exitCode === 1) {
    return ok(false);
  }

  return gitCommandFailed("Git tracked-file detection failed.", result.data);
}

function normalizeMemoryFilePath(filePath: string): Result<string> {
  const slashPath = filePath.replaceAll("\\", "/");

  if (path.posix.isAbsolute(slashPath)) {
    return invalidMemoryPath(filePath);
  }

  const prefixedPath = slashPath.startsWith(".memory/") ? slashPath : `.memory/${slashPath}`;
  const normalizedPath = path.posix.normalize(prefixedPath);

  if (
    normalizedPath === ".memory" ||
    !normalizedPath.startsWith(".memory/") ||
    normalizedPath.includes("\0")
  ) {
    return invalidMemoryPath(filePath);
  }

  return ok(normalizedPath);
}

function validateGitRevision(revision: string): Result<string> {
  if (
    revision.length === 0 ||
    revision.startsWith("-") ||
    revision.includes(":") ||
    revision.includes("\0") ||
    /\s/.test(revision)
  ) {
    return err(
      memoryError("MemoryValidationFailed", "Git revision is not a safe commit or ref.", {
        revision
      })
    );
  }

  return ok(revision);
}

function invalidMemoryPath(filePath: string): Result<string> {
  return err(
    memoryError("MemoryValidationFailed", "Git file path must stay inside .memory/.", {
      path: filePath
    })
  );
}

function gitCommandFailed<T>(message: string, result: SubprocessResult): Result<T> {
  return err(
    memoryError("MemoryGitOperationFailed", message, {
      command: result.command,
      args: [...result.args],
      exitCode: result.exitCode,
      stderr: result.stderr.trim()
    })
  );
}

function isGitUnavailableResult(result: SubprocessResult): boolean {
  const stderr = result.stderr.toLowerCase();
  return (
    stderr.includes("not a git repository") ||
    stderr.includes("not a git worktree") ||
    stderr.includes("outside repository")
  );
}

function unquoteGitPath(filePath: string): string {
  if (filePath.length >= 2 && filePath.startsWith('"') && filePath.endsWith('"')) {
    return filePath.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }

  return filePath;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function uniqueProjectFileChanges(
  changes: readonly ProjectFileChange[]
): ProjectFileChange[] {
  const byKey = new Map<string, ProjectFileChange>();

  for (const change of changes) {
    byKey.set(`${change.file}\0${change.commit}`, change);
  }

  return [...byKey.values()].sort(
    (left, right) =>
      right.timestamp.localeCompare(left.timestamp) ||
      left.file.localeCompare(right.file) ||
      left.commit.localeCompare(right.commit)
  );
}
