import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  detectSecretsInPatch,
  detectSecretsInText,
  scanProjectSecrets,
  secretDetectionError
} from "../../../src/validation/secrets.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("secret text detection", () => {
  it.each([
    ["private key block", "-----BEGIN OPENSSH PRIVATE KEY-----", "private_key_block"],
    ["GitHub token", `ghp_${"a".repeat(36)}`, "github_token"],
    ["GitHub fine-grained token", `github_pat_${"A".repeat(22)}`, "github_fine_grained_token"],
    ["OpenAI API key", `sk-${"a".repeat(20)}`, "openai_api_key"],
    ["Stripe secret key", `sk_live_${"a".repeat(16)}`, "stripe_secret_key"],
    ["Slack token", `xoxb-${"a".repeat(10)}`, "slack_token"],
    ["AWS access key", `AKIA${"A".repeat(16)}`, "aws_access_key"],
    ["Google API key", `AIza${"A".repeat(35)}`, "google_api_key"],
    ["generic assignment secret", 'api_key = "supersecretvalue"', "generic_assignment_secret"]
  ])("blocks %s without exposing the value", (_label, secret, rule) => {
    const result = detectSecretsInText(
      ["# Example", `Do not save ${secret}`, "End."].join("\n"),
      ".memory/memory/notes/example.md"
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual({
      code: "MemorySecretDetected",
      message: expect.any(String),
      path: ".memory/memory/notes/example.md:2",
      field: null
    });
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        severity: "block",
        rule,
        path: ".memory/memory/notes/example.md",
        line: 2
      })
    );
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("returns warn-level findings without blocking reads", () => {
    const result = detectSecretsInText(
      [
        `Authorization: Bearer ${"a".repeat(20)}`,
        "jwt: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJleGFtcGxlIn0.signature"
      ].join("\n"),
      ".memory/events.jsonl"
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((issue) => issue.code)).toEqual([
      "MemorySecretWarning",
      "MemorySecretWarning"
    ]);
    expect(result.findings.map((finding) => finding.rule)).toEqual([
      "bearer_token",
      "jwt_like_token"
    ]);
  });

  it("warns for long high-entropy strings", () => {
    const secret = "bD82Mfs9GQ+FTuPZ7HGtrjUPRpZ5FmEZG32XLmpNKW==";

    const result = detectSecretsInText(secret, ".memory/memory/notes/example.md");

    expect(result.valid).toBe(true);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "MemorySecretWarning",
        path: ".memory/memory/notes/example.md:1"
      })
    );
    expect(result.findings).toContainEqual(
      expect.objectContaining({ severity: "warn", rule: "high_entropy_string" })
    );
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("ignores low-entropy long strings", () => {
    const result = detectSecretsInText("a".repeat(80), ".memory/memory/notes/example.md");

    expect(result).toEqual({
      valid: true,
      errors: [],
      warnings: [],
      findings: []
    });
  });

  it("ignores OpenAI-looking substrings inside generated Memory relation ids", () => {
    const result = detectSecretsInText(
      `"id": "rel.project-memory-stress-236-jahosk-related-to-architecture-current"`,
      ".memory/relations/project-memory-stress-236-jahosk-related-to-architecture-current.json"
    );

    expect(result).toEqual({
      valid: true,
      errors: [],
      warnings: [],
      findings: []
    });
  });

  it.each([
    ["SHA-256 hash", `content_hash: sha256:${"a".repeat(64)}`],
    ["URL", `Reference: https://example.com/${"aB3dE5fG7hI9jK0lM2nO4pQ6rS8tU1vW3xY5z".repeat(2)}`],
    ["file path", `See docs/${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0"}/index.md`],
    ["object ID", `decision.${"a".repeat(40)}`],
    ["relation ID", `rel.${"a".repeat(40)}`],
    [
      "generated relation ID",
      `"id": "rel.project-memory-cli-init-human-s9ugyz-related-to-architecture-current"`
    ],
    [
      "generated object ID slug",
      `"id": "constraint.published-package-must-exclude-workspace-caches-and-source-only-trees"`
    ],
    ["Markdown heading", `# ${"bD82Mfs9GQ+FTuPZ7HGtrjUPRpZ5FmEZG32XLmpNKW=="}`],
    ["prose sentence", `This generated identifier ${"bD82Mfs9GQ+FTuPZ7HGtrjUPRpZ5FmEZG32XLmpNKW=="} is documented here.`]
  ])("ignores high-entropy candidates that look like %s", (_label, contents) => {
    const result = detectSecretsInText(contents, ".memory/memory/notes/example.md");

    expect(result).toEqual({
      valid: true,
      errors: [],
      warnings: [],
      findings: []
    });
  });

  it("wraps block findings in MemorySecretDetected without exposing values", () => {
    const secret = `sk-${"a".repeat(20)}`;
    const result = detectSecretsInText(secret, ".memory/memory/notes/example.md");

    const error = secretDetectionError(result.errors);

    expect(error.code).toBe("MemorySecretDetected");
    expect(JSON.stringify(error.details)).toContain(".memory/memory/notes/example.md:1");
    expect(JSON.stringify(error.details)).not.toContain(secret);
  });
});

describe("patch secret detection", () => {
  it("recursively scans patch string fields and reports JSON pointer fields", () => {
    const secret = `sk-${"a".repeat(20)}`;
    const result = detectSecretsInPatch({
      source: {
        kind: "agent",
        task: "Document integration"
      },
      changes: [
        {
          op: "create_object",
          title: "Integration credential handling",
          body: `The test key was ${secret}.`
        }
      ]
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual({
      code: "MemorySecretDetected",
      message: "Potential OpenAI API key detected.",
      path: "<patch>",
      field: "/changes/0/body"
    });
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        severity: "block",
        rule: "openai_api_key",
        path: "<patch>",
        field: "/changes/0/body"
      })
    );
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("escapes JSON pointer path tokens", () => {
    const result = detectSecretsInPatch({
      "secret/key": `ghp_${"a".repeat(36)}`,
      "tilde~key": "safe"
    });

    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: "<patch>",
        field: "/secret~1key"
      })
    );
  });
});

describe("project secret scanning", () => {
  it("scans canonical JSON, JSONL, and Markdown files", async () => {
    const projectRoot = await createProjectRoot();
    await writeProjectFile(projectRoot, ".memory/config.json", `{"api_key":"${"x".repeat(12)}"}`);
    await writeProjectFile(projectRoot, ".memory/events.jsonl", `{"reason":"Bearer ${"a".repeat(20)}"}`);
    await writeProjectFile(projectRoot, ".memory/memory/notes/example.md", `sk-test text\nsk-${"a".repeat(20)}`);

    const result = await scanProjectSecrets(projectRoot);

    expect(result.valid).toBe(false);
    expect(result.errors.map((issue) => issue.path).sort()).toEqual([
      ".memory/config.json:1",
      ".memory/memory/notes/example.md:2"
    ]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ path: ".memory/events.jsonl:1" })
    );
  });

  it("ignores generated files and non-canonical extensions by default", async () => {
    const projectRoot = await createProjectRoot();
    await writeProjectFile(projectRoot, ".memory/index/generated.json", `sk-${"a".repeat(20)}`);
    await writeProjectFile(projectRoot, ".memory/context/context-pack.md", `sk-${"a".repeat(20)}`);
    await writeProjectFile(projectRoot, ".memory/.lock", `sk-${"a".repeat(20)}`);
    await writeProjectFile(projectRoot, ".memory/memory/notes/example.txt", `sk-${"a".repeat(20)}`);

    const result = await scanProjectSecrets(projectRoot);

    expect(result).toEqual({
      valid: true,
      errors: [],
      warnings: [],
      findings: []
    });
  });

  it("does not mutate files while scanning", async () => {
    const projectRoot = await createProjectRoot();
    const path = ".memory/memory/notes/example.md";
    await writeProjectFile(projectRoot, path, `sk-${"a".repeat(20)}`);
    const absolutePath = join(projectRoot, path);
    const beforeContents = await readFile(absolutePath, "utf8");
    const beforeStat = await stat(absolutePath);

    await scanProjectSecrets(projectRoot);

    const afterContents = await readFile(absolutePath, "utf8");
    const afterStat = await stat(absolutePath);
    expect(afterContents).toBe(beforeContents);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });
});

async function createProjectRoot(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "memory-secrets-"));
  tempRoots.push(projectRoot);
  return projectRoot;
}

async function writeProjectFile(projectRoot: string, path: string, contents: string): Promise<void> {
  const absolutePath = join(projectRoot, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents, "utf8");
}
