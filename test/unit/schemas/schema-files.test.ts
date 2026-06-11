import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = process.cwd();

const schemaFiles = [
  "config.schema.json",
  "object.schema.json",
  "relation.schema.json",
  "event.schema.json",
  "patch.schema.json"
] as const;

async function readSchema(file: (typeof schemaFiles)[number]): Promise<Record<string, unknown>> {
  const contents = await readFile(join(root, "src", "schemas", file), "utf8");
  return JSON.parse(contents) as Record<string, unknown>;
}

describe("bundled schema files", () => {
  it("match the storage spec filenames", async () => {
    const files = await readdir(join(root, "src", "schemas"));
    const schemaJsonFiles = files.filter((file) => file.endsWith(".schema.json")).sort();

    expect(schemaJsonFiles).toEqual([...schemaFiles].sort());
  });

  it("parse as JSON Schema Draft 2020-12 with canonical v5 ids", async () => {
    for (const file of schemaFiles) {
      const schema = await readSchema(file);

      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(schema.$id).toBe(`https://aictx.dev/schemas/v5/${file}`);
    }
  });

  it("copies bundled schemas into dist/schemas", async () => {
    const targetDir = join(root, "dist", "schemas");

    await rm(targetDir, { recursive: true, force: true });
    await mkdir(targetDir, { recursive: true });
    await execFileAsync("node", ["scripts/copy-schemas.mjs"], { cwd: root });

    for (const file of schemaFiles) {
      const source = await readFile(join(root, "src", "schemas", file), "utf8");
      const copied = await readFile(join(targetDir, file), "utf8");

      expect(copied).toBe(source);
    }
  });
});
