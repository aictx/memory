import { spawn } from "node:child_process";
import { open as openFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CommanderError, type Command } from "commander";

import {
  getViewerProjects,
  type AppResult
} from "../../app/operations.js";
import { memoryError, type MemoryError } from "../../core/errors.js";
import { err, ok, type Result } from "../../core/result.js";
import { runSubprocess } from "../../core/subprocess.js";
import {
  startViewerServer,
  type StartedViewerServer
} from "../../viewer/server.js";
import { CLI_EXIT_SUCCESS, type CliExitCode } from "../exit.js";
import { renderAppResult } from "../render.js";

type CliOutputWriter = (text: string) => void;

export type ViewerUrlOpener = (url: string) => Promise<void> | void;
export type ViewerDetacher = (options: DetachViewerOptions) => Promise<Result<DetachedViewer>>;

export interface DetachViewerOptions {
  cwd: string;
  port?: number;
  open: boolean;
  memoryHome?: string;
}

export interface DetachedViewer {
  url: string;
  host: string;
  port: number;
  log_path: string;
}

export interface RegisterViewCommandOptions {
  cwd: string;
  stdout: CliOutputWriter;
  stderr: CliOutputWriter;
  assetsDir?: string;
  memoryHome?: string;
  opener?: ViewerUrlOpener;
  detacher?: ViewerDetacher;
  shutdownSignal?: AbortSignal;
}

export interface ViewServerData {
  url: string;
  host: string;
  port: number;
  token_required: true;
  open_attempted: boolean;
  detached: boolean;
  log_path: string | null;
  registry_path: string;
  projects_count: number;
  initial_project_registry_id: string | null;
}

interface ViewCommandFlags {
  port?: string;
  open?: boolean;
  detach?: boolean;
}

export function registerViewCommand(
  program: Command,
  options: RegisterViewCommandOptions
): void {
  program
    .command("view")
    .description("Start the local Memory viewer.")
    .option("--port <number>", "Port to bind on 127.0.0.1.")
    .option("--open", "Open the viewer URL in the default browser.")
    .option("--detach", "Start the viewer in a background process and print its URL.")
    .action(async (flags: ViewCommandFlags, command: Command) => {
      const preflight = await getViewerProjects({
        cwd: options.cwd,
        ...(options.memoryHome === undefined ? {} : { memoryHome: options.memoryHome })
      });

      if (!preflight.ok) {
        renderAndThrowOnFailure(preflight, command, options);
        return;
      }

      const port = parsePort(flags.port);

      if (!port.ok) {
        renderAndThrowOnFailure(errorResult(port.error, preflight), command, options);
        return;
      }

      if (flags.detach === true) {
        const detached = await detachViewer(
          {
            cwd: options.cwd,
            ...(port.data === undefined ? {} : { port: port.data }),
            open: flags.open === true,
            ...(options.memoryHome === undefined ? {} : { memoryHome: options.memoryHome })
          },
          options.detacher
        );

        if (!detached.ok) {
          renderAndThrowOnFailure(errorResult(detached.error, preflight), command, options);
          return;
        }

        const result: AppResult<ViewServerData> = {
          ok: true,
          data: {
            url: detached.data.url,
            host: detached.data.host,
            port: detached.data.port,
            token_required: true,
            open_attempted: flags.open === true,
            detached: true,
            log_path: detached.data.log_path,
            registry_path: preflight.data.registry_path,
            projects_count: preflight.data.counts.projects,
            initial_project_registry_id: preflight.data.current_project_registry_id
          },
          warnings: [...preflight.warnings, ...detached.warnings],
          meta: preflight.meta
        };
        const rendered = renderAppResult(result, {
          json: isJsonMode(command),
          renderData: renderViewData
        });

        options.stdout(rendered.stdout);
        options.stderr(rendered.stderr);
        return;
      }

      const started = await startViewerServer({
        cwd: options.cwd,
        ...(port.data === undefined ? {} : { port: port.data }),
        ...(options.assetsDir === undefined ? {} : { assetsDir: options.assetsDir }),
        ...(options.memoryHome === undefined ? {} : { memoryHome: options.memoryHome })
      });

      if (!started.ok) {
        renderAndThrowOnFailure(errorResult(started.error, preflight), command, options);
        return;
      }

      const openAttempted = flags.open === true;
      const openWarnings = openAttempted
        ? await openViewer(started.data.url, options.opener)
        : [];
      const result: AppResult<ViewServerData> = {
        ok: true,
        data: {
          url: started.data.url,
          host: started.data.host,
          port: started.data.port,
          token_required: true,
          open_attempted: openAttempted,
          detached: false,
          log_path: null,
          registry_path: preflight.data.registry_path,
          projects_count: preflight.data.counts.projects,
          initial_project_registry_id: preflight.data.current_project_registry_id
        },
        warnings: [...preflight.warnings, ...openWarnings],
        meta: preflight.meta
      };
      const rendered = renderAppResult(result, {
        json: isJsonMode(command),
        renderData: renderViewData
      });

      options.stdout(rendered.stdout);
      options.stderr(rendered.stderr);
      await waitForShutdown(started.data, options.shutdownSignal);
    });
}

function renderAndThrowOnFailure(
  result: AppResult<ViewServerData>,
  command: Command,
  options: RegisterViewCommandOptions
): void {
  const rendered = renderAppResult(result, {
    json: isJsonMode(command),
    renderData: renderViewData
  });

  options.stdout(rendered.stdout);
  options.stderr(rendered.stderr);

  if (rendered.exitCode !== CLI_EXIT_SUCCESS) {
    throwCommandFailed(rendered.exitCode);
  }
}

function errorResult(
  error: MemoryError,
  preflight: Extract<AppResult<unknown>, { ok: true }>
): AppResult<ViewServerData> {
  return {
    ok: false,
    error,
    warnings: preflight.warnings,
    meta: preflight.meta
  };
}

function parsePort(value: string | undefined): Result<number | undefined> {
  if (value === undefined) {
    return ok(undefined);
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return err(
      memoryError("MemoryValidationFailed", "Viewer port must be an integer from 1 to 65535.", {
        port: value
      })
    );
  }

  return ok(parsed);
}

function renderViewData(data: ViewServerData): string {
  return [
    `Memory viewer: ${data.url}`,
    `Memory project registry: ${data.registry_path}`,
    `Memory viewer projects: ${data.projects_count}`,
    ...(data.log_path === null ? [] : [`Memory viewer log: ${data.log_path}`])
  ].join("\n");
}

function isJsonMode(command: Command): boolean {
  const options = command.optsWithGlobals() as { json?: unknown };
  return options.json === true;
}

async function openViewer(
  url: string,
  opener: ViewerUrlOpener | undefined
): Promise<string[]> {
  try {
    if (opener !== undefined) {
      await opener(url);
      return [];
    }

    await openWithDefaultBrowser(url);
    return [];
  } catch (error) {
    return [`Viewer server started, but the browser could not be opened: ${messageFromUnknown(error)}`];
  }
}

async function openWithDefaultBrowser(url: string): Promise<void> {
  const command = browserOpenCommand(url);
  const result = await runSubprocess(command.command, command.args);

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  if (result.data.exitCode !== 0) {
    throw new Error(result.data.stderr.trim() || `exit code ${result.data.exitCode}`);
  }
}

export async function detachViewer(
  options: DetachViewerOptions,
  detacher: ViewerDetacher | undefined
): Promise<Result<DetachedViewer>> {
  if (detacher !== undefined) {
    return detacher(options);
  }

  const logPath = join(tmpdir(), `memory-viewer-${process.pid}-${Date.now()}.log`);
  const log = await openFile(logPath, "a");
  const cliPath = resolveDetachedCliPath(import.meta.url);
  const args = [
    cliPath,
    "view",
    ...(options.port === undefined ? [] : ["--port", String(options.port)]),
    ...(options.open ? ["--open"] : [])
  ];
  const child = spawn(process.execPath, args, {
    cwd: options.cwd,
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
    env: {
      ...process.env,
      ...(options.memoryHome === undefined ? {} : { MEMORY_HOME: options.memoryHome })
    }
  });

  child.unref();
  await log.close();

  const url = await waitForDetachedViewerUrl(logPath);

  if (!url.ok) {
    return url;
  }

  const parsed = new URL(url.data);

  return ok({
    url: url.data,
    host: parsed.hostname,
    port: Number(parsed.port),
    log_path: logPath
  });
}

export interface StartViewerFlags {
  view?: boolean;
  open?: boolean;
}

export interface StartViewerRunOptions {
  json: boolean;
}

export async function maybeStartViewer(
  cwd: string,
  flags: StartViewerFlags,
  viewerDetacher: ViewerDetacher | undefined,
  options: StartViewerRunOptions
): Promise<Result<DetachedViewer | null>> {
  if (!shouldStartViewer(flags, options)) {
    return {
      ok: true,
      data: null,
      warnings: []
    };
  }

  return detachViewer(
    {
      cwd,
      open: flags.open === true
    },
    viewerDetacher
  );
}

function shouldStartViewer(flags: StartViewerFlags, options: StartViewerRunOptions): boolean {
  if (flags.view === false) {
    return false;
  }

  return flags.view === true || flags.open === true || !options.json;
}

export function resolveDetachedCliPath(moduleUrl: string): string {
  const currentPath = fileURLToPath(moduleUrl);

  if (basename(currentPath) === "main.js") {
    return currentPath;
  }

  return join(dirname(dirname(currentPath)), "main.js");
}

async function waitForDetachedViewerUrl(logPath: string): Promise<Result<string>> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 5_000) {
    const contents = await readFile(logPath, "utf8").catch(() => "");
    const match = contents.match(/Memory viewer: (?<url>http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/);

    if (match?.groups?.url !== undefined) {
      return ok(match.groups.url);
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return err(
    memoryError("MemoryValidationFailed", "Detached viewer did not report a URL.", {
      log_path: logPath
    })
  );
}

function browserOpenCommand(url: string): { command: string; args: string[] } {
  if (process.platform === "darwin") {
    return { command: "open", args: [url] };
  }

  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url] };
  }

  return { command: "xdg-open", args: [url] };
}

function waitForShutdown(
  server: StartedViewerServer,
  shutdownSignal: AbortSignal | undefined
): Promise<void> {
  if (shutdownSignal === undefined) {
    return new Promise(() => {
      // Keep the CLI action alive while the HTTP server owns the process lifetime.
    });
  }

  if (shutdownSignal.aborted) {
    return server.close();
  }

  return new Promise((resolve, reject) => {
    shutdownSignal.addEventListener(
      "abort",
      () => {
        server.close().then(resolve, reject);
      },
      { once: true }
    );
  });
}

function throwCommandFailed(exitCode: CliExitCode): never {
  throw new CommanderError(
    exitCode,
    "memory.command.failed",
    "Memory command failed."
  );
}

function messageFromUnknown(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
