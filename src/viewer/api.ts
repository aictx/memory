import type { IncomingMessage, ServerResponse } from "node:http";

import {
  deleteViewerProject,
  getViewerProjectBootstrap,
  getViewerBootstrap,
  getViewerProjects,
  type AppResult,
  type ViewerBootstrapData,
  type ViewerProjectDeleteData,
  type ViewerProjectsData
} from "../app/operations.js";
import { memoryError, type MemoryError, type JsonValue } from "../core/errors.js";

export interface ViewerApiContext {
  cwd: string;
  token: string;
  memoryHome?: string;
}

type ViewerApiResult =
  | AppResult<ViewerBootstrapData>
  | AppResult<ViewerProjectsData>
  | AppResult<ViewerProjectDeleteData>;

export async function handleViewerApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: ViewerApiContext
): Promise<void> {
  if (!isAuthorizedApiRequest(request, url, context.token)) {
    writeViewerJsonResponse(response, 401, viewerErrorBody(
      memoryError("MemoryValidationFailed", "Viewer API token is required.")
    ));
    return;
  }

  if (url.pathname === "/api/bootstrap") {
    await handleBootstrapRequest(request, response, context);
    return;
  }

  if (url.pathname === "/api/projects") {
    await handleProjectsRequest(request, response, context);
    return;
  }

  const projectDelete = matchProjectDeleteRoute(url.pathname);

  if (projectDelete !== null) {
    await handleProjectDeleteRequest(request, response, context, projectDelete);
    return;
  }

  const projectBootstrap = matchProjectRoute(url.pathname, "bootstrap");

  if (projectBootstrap !== null) {
    await handleProjectBootstrapRequest(request, response, context, projectBootstrap);
    return;
  }

  writeViewerJsonResponse(response, 404, viewerErrorBody(
    memoryError("MemoryValidationFailed", "Viewer API route is not supported.", {
      path: url.pathname
    })
  ));
}

export function writeViewerJsonResponse(
  response: ServerResponse,
  statusCode: number,
  body: JsonValue
): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(body)}\n`);
}

export function viewerErrorBody(error: MemoryError): JsonValue {
  return {
    ok: false,
    error: error as unknown as JsonValue,
    warnings: []
  };
}

function isAuthorizedApiRequest(
  request: IncomingMessage,
  url: URL,
  token: string
): boolean {
  if (url.searchParams.get("token") === token) {
    return true;
  }

  const authorization = request.headers.authorization;

  return typeof authorization === "string" && authorization === `Bearer ${token}`;
}

async function handleBootstrapRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: ViewerApiContext
): Promise<void> {
  if (request.method !== "GET") {
    writeMethodNotAllowed(response, "GET");
    return;
  }

  const result = await getViewerBootstrap({ cwd: context.cwd });
  writeAppResult(response, result);
}

async function handleProjectsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: ViewerApiContext
): Promise<void> {
  if (request.method !== "GET") {
    writeMethodNotAllowed(response, "GET");
    return;
  }

  const result = await getViewerProjects({
    cwd: context.cwd,
    ...(context.memoryHome === undefined ? {} : { memoryHome: context.memoryHome })
  });
  writeAppResult(response, result);
}

async function handleProjectBootstrapRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: ViewerApiContext,
  registryId: string
): Promise<void> {
  if (request.method !== "GET") {
    writeMethodNotAllowed(response, "GET");
    return;
  }

  const result = await getViewerProjectBootstrap({
    cwd: context.cwd,
    registryId,
    ...(context.memoryHome === undefined ? {} : { memoryHome: context.memoryHome })
  });
  writeAppResult(response, result);
}

async function handleProjectDeleteRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: ViewerApiContext,
  registryId: string
): Promise<void> {
  if (request.method !== "DELETE") {
    writeMethodNotAllowed(response, "DELETE");
    return;
  }

  const result = await deleteViewerProject({
    cwd: context.cwd,
    registryId,
    ...(context.memoryHome === undefined ? {} : { memoryHome: context.memoryHome })
  });
  writeAppResult(response, result);
}

function writeMethodNotAllowed(response: ServerResponse, allow: string): void {
  response.setHeader("Allow", allow);
  writeViewerJsonResponse(response, 405, viewerErrorBody(
    memoryError("MemoryValidationFailed", "HTTP method is not supported for this route.", {
      allow
    })
  ));
}

function writeAppResult(response: ServerResponse, result: ViewerApiResult): void {
  writeViewerJsonResponse(response, statusCodeForAppResult(result), result as unknown as JsonValue);
}

function statusCodeForAppResult(result: ViewerApiResult): number {
  if (result.ok) {
    return 200;
  }

  switch (result.error.code) {
    case "MemoryNotInitialized":
    case "MemoryAlreadyInitializedInvalid":
    case "MemoryUnsupportedStorageVersion":
    case "MemoryConflictDetected":
    case "MemoryDirtyMemory":
    case "MemoryIndexUnavailable":
    case "MemoryLockBusy":
    case "MemoryGitRequired":
      return 412;
    case "MemoryObjectNotFound":
    case "MemoryRelationNotFound":
      return 404;
    case "MemoryInternalError":
    case "MemoryGitOperationFailed":
      return 500;
    default:
      return 400;
  }
}

function matchProjectRoute(pathname: string, suffix: string): string | null {
  const prefix = "/api/projects/";

  if (!pathname.startsWith(prefix) || !pathname.endsWith(`/${suffix}`)) {
    return null;
  }

  const encoded = pathname.slice(prefix.length, pathname.length - suffix.length - 1);

  try {
    const registryId = decodeURIComponent(encoded);
    return registryId === "" || registryId.includes("/") ? null : registryId;
  } catch {
    return null;
  }
}

function matchProjectDeleteRoute(pathname: string): string | null {
  const prefix = "/api/projects/";

  if (!pathname.startsWith(prefix)) {
    return null;
  }

  const encoded = pathname.slice(prefix.length);

  try {
    const registryId = decodeURIComponent(encoded);
    return registryId === "" || registryId.includes("/") ? null : registryId;
  } catch {
    return null;
  }
}

