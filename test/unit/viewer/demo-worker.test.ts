import { describe, expect, it } from "vitest";

import worker, { type DemoWorkerEnv } from "../../../src/viewer/demo-worker.js";

const env: DemoWorkerEnv = {
  ASSETS: {
    fetch: async (request: Request) => new Response(`asset:${new URL(request.url).pathname}`)
  }
};

describe("viewer demo Worker", () => {
  it("serves the seeded projects route for the public demo token", async () => {
    const response = await worker.fetch(request("/api/projects?token=demo"), env);
    const body = await response.json() as {
      ok: true;
      data: {
        projects: Array<{ registry_id: string; available: boolean; project: { id: string; name: string } }>;
        current_project_registry_id: string | null;
      };
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.current_project_registry_id).toBe("demo");
    expect(body.data.projects).toHaveLength(1);
    expect(body.data.projects[0]).toMatchObject({
      registry_id: "demo",
      available: true,
      project: {
        id: "project.todo-app",
        name: "Todo App"
      }
    });
  });

  it("serves seeded Todo App bootstrap data with objects, facets, and relations", async () => {
    const response = await worker.fetch(request("/api/projects/demo/bootstrap?token=demo"), env);
    const body = await response.json() as {
      ok: true;
      data: {
        project: { id: string; name: string };
        objects: Array<{ id: string; type: string; facets: { category: string } | null }>;
        relations: Array<{ from: string; to: string }>;
      };
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.project).toEqual({
      id: "project.todo-app",
      name: "Todo App"
    });
    expect(body.data.objects.map((object) => object.id)).toContain("concept.quick-add");
    expect(body.data.objects.map((object) => object.id)).not.toContain("project.memory");
    expect(body.data.objects.find((object) => object.id === "workflow.post-task-verification")).toMatchObject({
      type: "workflow",
      facets: { category: "testing" }
    });
    expect(body.data.relations.length).toBeGreaterThan(0);
  });

  it("requires the demo token for API routes", async () => {
    const response = await worker.fetch(request("/api/projects"), env);
    const body = await response.json() as { ok: false; error: { code: string } };

    expect(response.status).toBe(401);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("MemoryValidationFailed");
  });

  it("blocks write routes in the public demo", async () => {
    const deleteResponse = await worker.fetch(request("/api/projects/demo?token=demo", {
      method: "DELETE"
    }), env);
    const deleteBody = await deleteResponse.json() as { ok: false; error: { message: string } };

    expect(deleteResponse.status).toBe(403);
    expect(deleteBody.ok).toBe(false);
    expect(deleteBody.error.message).toContain("read-only");
  });

  it("passes non-API requests through to static assets", async () => {
    const response = await worker.fetch(request("/?token=demo"), env);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("asset:/");
  });
});

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://demo.aictx.dev${path}`, init);
}
