import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main, type CliOutputWriter } from "../../../src/cli/main.js";
import {
  startViewerServer,
  VIEWER_LOOPBACK_HOST,
  type StartedViewerServer
} from "../../../src/viewer/server.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("viewer local server", () => {
  it("binds to loopback on random and explicit ports and serves static assets", async () => {
    const projectRoot = await createInitializedProject("memory-viewer-static-project-");
    const assetsDir = await createViewerAssets("memory-viewer-static-assets-");
    const random = await startViewerServer({
      cwd: projectRoot,
      assetsDir,
      token: "unit-token"
    });

    expect(random.ok).toBe(true);
    if (!random.ok) {
      throw new Error(random.error.message);
    }

    try {
      expect(random.data.host).toBe(VIEWER_LOOPBACK_HOST);
      expect(random.data.port).toBeGreaterThan(0);
      const root = await fetch(random.data.url);

      expect(root.status).toBe(200);
      expect(root.headers.get("access-control-allow-origin")).toBeNull();
      await expect(root.text()).resolves.toContain("viewer test asset");

      const script = await fetch(
        `http://${random.data.host}:${random.data.port}/assets/app.js`
      );

      expect(script.status).toBe(200);
      expect(script.headers.get("content-type")).toContain("text/javascript");
      await expect(script.text()).resolves.toContain("viewer asset script");
    } finally {
      await random.data.close();
    }

    const port = await getAvailablePort();
    const explicit = await startViewerServer({
      cwd: projectRoot,
      assetsDir,
      port,
      token: "explicit-token"
    });

    expect(explicit.ok).toBe(true);
    if (!explicit.ok) {
      throw new Error(explicit.error.message);
    }

    try {
      expect(explicit.data.host).toBe(VIEWER_LOOPBACK_HOST);
      expect(explicit.data.port).toBe(port);
    } finally {
      await explicit.data.close();
    }
  });

  it("fails clearly for an unavailable explicit port", async () => {
    const projectRoot = await createInitializedProject("memory-viewer-busy-project-");
    const assetsDir = await createViewerAssets("memory-viewer-busy-assets-");
    const busy = createServer();

    await listenOnLoopback(busy, 0);

    try {
      const address = busy.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const result = await startViewerServer({
        cwd: projectRoot,
        assetsDir,
        port,
        token: "busy-token"
      });

      expect(result.ok).toBe(false);
      if (result.ok) {
        await result.data.close();
        throw new Error("Expected busy port to fail.");
      }

      expect(result.error.code).toBe("MemoryValidationFailed");
      expect(result.error.message).toContain("could not bind");
      expect(result.error.details).toMatchObject({
        host: VIEWER_LOOPBACK_HOST,
        port
      });
    } finally {
      await closeNodeServer(busy);
    }
  });

  it("requires the per-run token for API requests", async () => {
    const started = await startProjectViewer("memory-viewer-token-");

    try {
      const base = `http://${started.host}:${started.port}`;
      const missing = await fetch(`${base}/api/bootstrap`);
      const missingProjects = await fetch(`${base}/api/projects`);
      const wrong = await fetch(`${base}/api/bootstrap?token=wrong`);
      const authorized = await fetch(`${base}/api/bootstrap`, {
        headers: {
          authorization: `Bearer ${started.token}`
        }
      });
      const authorizedProjects = await fetch(`${base}/api/projects`, {
        headers: {
          authorization: `Bearer ${started.token}`
        }
      });

      expect(missing.status).toBe(401);
      expect(missingProjects.status).toBe(401);
      expect(wrong.status).toBe(401);
      expect(authorized.status).toBe(200);
      expect(authorizedProjects.status).toBe(200);
      expect(authorized.headers.get("access-control-allow-origin")).toBeNull();
      await expect(authorized.json()).resolves.toMatchObject({
        ok: true,
        data: {
          counts: {
            objects: expect.any(Number)
          }
        }
      });
      await expect(authorizedProjects.json()).resolves.toMatchObject({
        ok: true,
        data: {
          counts: {
            projects: 1,
            available: 1
          }
        }
      });
    } finally {
      await started.close();
    }
  });

  it("serves an empty project dashboard outside initialized projects", async () => {
    const cwd = await createTempRoot("memory-viewer-empty-cwd-");
    const memoryHome = await createTempRoot("memory-viewer-empty-home-");
    const assetsDir = await createViewerAssets("memory-viewer-empty-assets-");
    const started = await startViewerServer({
      cwd,
      assetsDir,
      memoryHome,
      token: "empty-token"
    });

    expect(started.ok).toBe(true);
    if (!started.ok) {
      throw new Error(started.error.message);
    }

    try {
      const response = await fetch(
        `http://${started.data.host}:${started.data.port}/api/projects?token=${started.data.token}`
      );
      const envelope = await response.json() as {
        ok: true;
        data: { projects: unknown[]; counts: { projects: number } };
      };

      expect(response.status).toBe(200);
      expect(envelope.ok).toBe(true);
      expect(envelope.data.projects).toEqual([]);
      expect(envelope.data.counts.projects).toBe(0);
    } finally {
      await started.data.close();
    }
  });

  it("returns project-scoped bootstrap data", async () => {
    const projectRoot = await createInitializedProject("memory-viewer-project-route-");
    const memoryHome = await createTempRoot("memory-viewer-project-route-home-");
    const assetsDir = await createViewerAssets("memory-viewer-project-route-assets-");
    const started = await startViewerServer({
      cwd: projectRoot,
      assetsDir,
      memoryHome,
      token: "project-route-token"
    });

    expect(started.ok).toBe(true);
    if (!started.ok) {
      throw new Error(started.error.message);
    }

    try {
      const base = `http://${started.data.host}:${started.data.port}`;
      const projectsResponse = await fetch(`${base}/api/projects?token=${started.data.token}`);
      const projectsEnvelope = await projectsResponse.json() as {
        ok: true;
        data: { projects: Array<{ registry_id: string }> };
      };
      const registryId = projectsEnvelope.data.projects[0]?.registry_id;

      expect(registryId).toBeTruthy();

      const bootstrapResponse = await fetch(
        `${base}/api/projects/${encodeURIComponent(registryId ?? "")}/bootstrap?token=${started.data.token}`
      );
      const bootstrapEnvelope = await bootstrapResponse.json() as {
        ok: true;
        data: { counts: { objects: number } };
      };

      expect(bootstrapResponse.status).toBe(200);
      expect(bootstrapEnvelope.ok).toBe(true);
      expect(bootstrapEnvelope.data.counts.objects).toBeGreaterThan(0);
    } finally {
      await started.data.close();
    }
  });

  it("deletes a viewer project by removing .memory and unregistering it", async () => {
    const projectRoot = await createInitializedProject("memory-viewer-delete-project-");
    const memoryHome = await createTempRoot("memory-viewer-delete-home-");
    const assetsDir = await createViewerAssets("memory-viewer-delete-assets-");

    await writeProjectFile(projectRoot, "src/app.ts", "export const kept = true;\n");
    await registerProject(projectRoot, memoryHome);

    const started = await startViewerServer({
      cwd: projectRoot,
      assetsDir,
      memoryHome,
      token: "delete-token"
    });

    expect(started.ok).toBe(true);
    if (!started.ok) {
      throw new Error(started.error.message);
    }

    try {
      const base = `http://${started.data.host}:${started.data.port}`;
      const projectsResponse = await fetch(`${base}/api/projects?token=${started.data.token}`);
      const projectsEnvelope = await projectsResponse.json() as {
        ok: true;
        data: { projects: Array<{ registry_id: string; project_root: string }> };
      };
      const registryId = projectsEnvelope.data.projects[0]?.registry_id;

      expect(registryId).toBeTruthy();

      const deleteResponse = await fetch(
        `${base}/api/projects/${encodeURIComponent(registryId ?? "")}`,
        {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${started.data.token}`
          }
        }
      );
      const deleteEnvelope = await deleteResponse.json() as {
        ok: true;
        data: {
          project: { registry_id: string; project_root: string };
          removed: { registry_id: string } | null;
          destroyed: true;
          entries_removed: string[];
        };
      };

      expect(deleteResponse.status).toBe(200);
      expect(deleteEnvelope.ok).toBe(true);
      expect(deleteEnvelope.data).toMatchObject({
        project: {
          registry_id: registryId,
          project_root: projectRoot
        },
        removed: {
          registry_id: registryId
        },
        destroyed: true,
        entries_removed: [".memory"]
      });
      await expect(pathExists(join(projectRoot, ".memory"))).resolves.toBe(false);
      await expect(readFile(join(projectRoot, "src/app.ts"), "utf8"))
        .resolves.toBe("export const kept = true;\n");

      const refreshed = await fetch(`${base}/api/projects?token=${started.data.token}`);
      const refreshedEnvelope = await refreshed.json() as {
        ok: true;
        data: { projects: unknown[]; counts: { projects: number } };
      };

      expect(refreshed.status).toBe(200);
      expect(refreshedEnvelope.ok).toBe(true);
      expect(refreshedEnvelope.data.projects).toEqual([]);
      expect(refreshedEnvelope.data.counts.projects).toBe(0);
    } finally {
      await started.data.close();
    }
  });

  it("unregisters stale viewer projects whose .memory directory is already missing", async () => {
    const projectRoot = await createInitializedProject("memory-viewer-delete-stale-project-");
    const memoryHome = await createTempRoot("memory-viewer-delete-stale-home-");
    const assetsDir = await createViewerAssets("memory-viewer-delete-stale-assets-");

    await writeProjectFile(projectRoot, "src/kept.ts", "export const kept = true;\n");
    await registerProject(projectRoot, memoryHome);
    await rm(join(projectRoot, ".memory"), { recursive: true, force: true });

    const started = await startViewerServer({
      cwd: projectRoot,
      assetsDir,
      memoryHome,
      token: "delete-stale-token"
    });

    expect(started.ok).toBe(true);
    if (!started.ok) {
      throw new Error(started.error.message);
    }

    try {
      const base = `http://${started.data.host}:${started.data.port}`;
      const projectsResponse = await fetch(`${base}/api/projects?token=${started.data.token}`);
      const projectsEnvelope = await projectsResponse.json() as {
        ok: true;
        data: { projects: Array<{ registry_id: string; available: boolean }> };
      };
      const project = projectsEnvelope.data.projects[0];

      expect(project).toMatchObject({ available: false });

      const deleteResponse = await fetch(
        `${base}/api/projects/${encodeURIComponent(project?.registry_id ?? "")}?token=${started.data.token}`,
        { method: "DELETE" }
      );
      const deleteEnvelope = await deleteResponse.json() as {
        ok: true;
        data: { removed: { registry_id: string } | null; entries_removed: string[] };
      };

      expect(deleteResponse.status).toBe(200);
      expect(deleteEnvelope.ok).toBe(true);
      expect(deleteEnvelope.data.removed).toMatchObject({
        registry_id: project?.registry_id
      });
      expect(deleteEnvelope.data.entries_removed).toEqual([]);
      await expect(readFile(join(projectRoot, "src/kept.ts"), "utf8"))
        .resolves.toBe("export const kept = true;\n");

      const refreshed = await fetch(`${base}/api/projects?token=${started.data.token}`);
      const refreshedEnvelope = await refreshed.json() as {
        ok: true;
        data: { projects: unknown[]; counts: { projects: number } };
      };

      expect(refreshedEnvelope.ok).toBe(true);
      expect(refreshedEnvelope.data.projects).toEqual([]);
      expect(refreshedEnvelope.data.counts.projects).toBe(0);
    } finally {
      await started.data.close();
    }
  });

  it("returns bootstrap data without mutating canonical storage or indexes", async () => {
    const projectRoot = await createInitializedProject("memory-viewer-bootstrap-project-");
    const assetsDir = await createViewerAssets("memory-viewer-bootstrap-assets-");
    const started = await startViewerServer({
      cwd: projectRoot,
      assetsDir,
      token: "bootstrap-token"
    });

    expect(started.ok).toBe(true);
    if (!started.ok) {
      throw new Error(started.error.message);
    }

    try {
      const before = await readCanonicalAndIndexFiles(projectRoot);
      const response = await fetch(
        `http://${started.data.host}:${started.data.port}/api/bootstrap?token=${started.data.token}`
      );
      const envelope = await response.json() as {
        ok: true;
        data: {
          project: { id: string; name: string };
          objects: unknown[];
          relations: unknown[];
          counts: {
            objects: number;
            relations: number;
            stale_objects: number;
            superseded_objects: number;
            source_objects: number;
            synthesis_objects: number;
            active_relations: number;
          };
        };
      };

      expect(response.status).toBe(200);
      expect(envelope.ok).toBe(true);
      expect(envelope.data.project.id).toMatch(/^project\./);
      expect(envelope.data.objects.length).toBe(envelope.data.counts.objects);
      expect(envelope.data.relations.length).toBe(envelope.data.counts.relations);
      expect(envelope.data.counts).toMatchObject({
        stale_objects: expect.any(Number),
        superseded_objects: expect.any(Number),
        active_relations: expect.any(Number)
      });
      await expect(readCanonicalAndIndexFiles(projectRoot)).resolves.toEqual(before);
    } finally {
      await started.data.close();
    }
  });

  it("rejects unsupported methods and local API routes", async () => {
    const started = await startProjectViewer("memory-viewer-reject-");

    try {
      const base = `http://${started.host}:${started.port}`;
      const token = started.token;

      await expect(fetch(`${base}/api/bootstrap?token=${token}`, {
        method: "POST"
      })).resolves.toMatchObject({ status: 405 });
      const projectsResponse = await fetch(`${base}/api/projects?token=${token}`);
      const projectsEnvelope = await projectsResponse.json() as {
        ok: true;
        data: { projects: Array<{ registry_id: string }> };
      };
      const registryId = projectsEnvelope.data.projects[0]?.registry_id;

      expect(registryId).toBeTruthy();
      await expect(fetch(`${base}/api/projects/${encodeURIComponent(registryId ?? "")}?token=${token}`))
        .resolves.toMatchObject({ status: 405 });
      await expect(fetch(`${base}/api/debug?token=${token}`))
        .resolves.toMatchObject({ status: 404 });
      await expect(fetch(`${base}/shell`, { method: "POST" }))
        .resolves.toMatchObject({ status: 405 });
    } finally {
      await started.close();
    }
  });
});

async function startProjectViewer(prefix: string): Promise<StartedViewerServer> {
  const projectRoot = await createInitializedProject(`${prefix}project-`);
  const assetsDir = await createViewerAssets(`${prefix}assets-`);
  const memoryHome = await createTempRoot(`${prefix}home-`);
  const started = await startViewerServer({
    cwd: projectRoot,
    assetsDir,
    memoryHome,
    token: "api-token"
  });

  expect(started.ok).toBe(true);
  if (!started.ok) {
    throw new Error(started.error.message);
  }

  return started.data;
}

async function createViewerAssets(prefix: string): Promise<string> {
  const assetsRoot = await createTempRoot(prefix);

  await writeProjectFile(
    assetsRoot,
    "index.html",
    "<!doctype html><html><body>viewer test asset<script src=\"./assets/app.js\"></script></body></html>\n"
  );
  await writeProjectFile(
    assetsRoot,
    "assets/app.js",
    "console.log('viewer asset script');\n"
  );

  return assetsRoot;
}

async function createInitializedProject(prefix: string): Promise<string> {
  const projectRoot = await createTempRoot(prefix);
  const output = createCapturedOutput();
  const exitCode = await main(["node", "memory", "init", "--json"], {
    ...output.writers,
    cwd: projectRoot
  });

  expect(exitCode).toBe(0);
  expect(output.stderr()).toBe("");

  return projectRoot;
}

async function registerProject(projectRoot: string, memoryHome: string): Promise<void> {
  const output = createCapturedOutput();
  const exitCode = await main(["node", "memory", "projects", "add", "--json"], {
    ...output.writers,
    cwd: projectRoot,
    registry: {
      memoryHome
    }
  });

  expect(exitCode).toBe(0);
  expect(output.stderr()).toBe("");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readCanonicalAndIndexFiles(projectRoot: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};

  for (const root of [
    ".memory/config.json",
    ".memory/events.jsonl",
    ".memory/memory",
    ".memory/relations",
    ".memory/schema",
    ".memory/index"
  ]) {
    Object.assign(files, await readFilesRecursivelyIfExists(projectRoot, join(projectRoot, root)));
  }

  return files;
}

async function readFilesRecursivelyIfExists(
  projectRoot: string,
  absolutePath: string
): Promise<Record<string, string>> {
  const pathStat = await stat(absolutePath).catch(() => null);

  if (pathStat === null) {
    return {};
  }

  if (pathStat.isFile()) {
    return {
      [relative(projectRoot, absolutePath)]: (await readFile(absolutePath)).toString("base64")
    };
  }

  const entries = await readdir(absolutePath, { withFileTypes: true });
  const files: Record<string, string> = {};

  for (const entry of entries) {
    const child = join(absolutePath, entry.name);

    if (entry.isDirectory()) {
      Object.assign(files, await readFilesRecursivelyIfExists(projectRoot, child));
      continue;
    }

    if (entry.isFile()) {
      files[relative(projectRoot, child)] = (await readFile(child)).toString("base64");
    }
  }

  return files;
}

async function writeProjectFile(
  root: string,
  relativePath: string,
  contents: string
): Promise<void> {
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const resolvedRoot = await realpath(root);
  tempRoots.push(resolvedRoot);
  return resolvedRoot;
}

async function getAvailablePort(): Promise<number> {
  const server = createServer();

  await listenOnLoopback(server, 0);

  try {
    const address = server.address();

    if (typeof address === "object" && address !== null) {
      return address.port;
    }

    throw new Error("Server did not bind to a TCP port.");
  } finally {
    await closeNodeServer(server);
  }
}

function listenOnLoopback(server: ReturnType<typeof createServer>, port: number): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, VIEWER_LOOPBACK_HOST, () => {
      resolveListen();
    });
  });
}

function closeNodeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }

      resolveClose();
    });
  });
}

function createCapturedOutput(): {
  writers: { stdout: CliOutputWriter; stderr: CliOutputWriter };
  stdout: () => string;
  stderr: () => string;
} {
  let stdout = "";
  let stderr = "";

  return {
    writers: {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      }
    },
    stdout: () => stdout,
    stderr: () => stderr
  };
}
