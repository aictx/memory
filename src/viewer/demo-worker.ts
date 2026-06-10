import demoData from "./demo-data.generated.json" with { type: "json" };

type DemoJson =
  | null
  | boolean
  | number
  | string
  | DemoJson[]
  | { [key: string]: DemoJson };

type DemoEnvelopeData =
  | typeof demoData.projects
  | typeof demoData.bootstrap;

export interface DemoWorkerEnv {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
}

interface DemoError {
  code: string;
  message: string;
  details?: DemoJson;
}

const DEMO_ROUTE_PREFIX = `/api/projects/${demoData.registry_id}`;
const API_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8"
};

export default {
  async fetch(request: Request, env: DemoWorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    if (!isAuthorizedDemoRequest(request, url)) {
      return jsonError(401, {
        code: "MemoryValidationFailed",
        message: "Viewer API token is required."
      });
    }

    if (url.pathname === "/api/projects") {
      return methodGuard(request, "GET", () => jsonOk(demoData.projects));
    }

    if (url.pathname === `${DEMO_ROUTE_PREFIX}/bootstrap`) {
      return methodGuard(request, "GET", () => jsonOk(demoData.bootstrap));
    }

    if (isReadOnlyBlockedRoute(url.pathname, request.method)) {
      return jsonError(403, {
        code: "MemoryValidationFailed",
        message: "The public demo viewer is read-only."
      });
    }

    return jsonError(404, {
      code: "MemoryValidationFailed",
      message: "Viewer API route is not supported.",
      details: {
        path: url.pathname
      }
    });
  }
};

function isAuthorizedDemoRequest(request: Request, url: URL): boolean {
  if (url.searchParams.get("token") === demoData.token) {
    return true;
  }

  return request.headers.get("authorization") === `Bearer ${demoData.token}`;
}

function methodGuard(
  request: Request,
  method: string,
  handler: () => Response | Promise<Response>
): Response | Promise<Response> {
  if (request.method !== method) {
    return jsonError(405, {
      code: "MemoryValidationFailed",
      message: "HTTP method is not supported for this demo route.",
      details: {
        allow: method
      }
    }, {
      allow: method
    });
  }

  return handler();
}

function isReadOnlyBlockedRoute(pathname: string, method: string): boolean {
  return method === "DELETE" && isProjectDeleteRoute(pathname);
}

function isProjectDeleteRoute(pathname: string): boolean {
  const prefix = "/api/projects/";
  const projectId = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : "";

  return projectId !== "" && !projectId.includes("/");
}

function jsonOk(data: DemoEnvelopeData): Response {
  return Response.json({
    ok: true,
    data,
    warnings: [],
    meta: demoData.meta
  }, {
    headers: API_HEADERS
  });
}

function jsonError(status: number, error: DemoError, headers: HeadersInit = {}): Response {
  return Response.json({
    ok: false,
    error,
    warnings: []
  }, {
    status,
    headers: {
      ...API_HEADERS,
      ...headers
    }
  });
}
