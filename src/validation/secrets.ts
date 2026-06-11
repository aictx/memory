import fg from "fast-glob";

import { memoryError, type MemoryError, type JsonValue } from "../core/errors.js";
import { readUtf8FileInsideRoot } from "../core/fs.js";
import type { ValidationIssue } from "../core/types.js";

export type SecretSeverity = "block" | "warn";

export interface SecretFinding {
  severity: SecretSeverity;
  rule: string;
  path: string;
  line?: number;
  field?: string;
  message: string;
}

export interface SecretDetectionResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  findings: SecretFinding[];
}

interface SecretRule {
  severity: SecretSeverity;
  rule: string;
  pattern: RegExp;
  message: string;
}

const BLOCK_RULES: readonly SecretRule[] = [
  {
    severity: "block",
    rule: "private_key_block",
    pattern: /-----BEGIN (RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
    message: "Potential private key detected."
  },
  {
    severity: "block",
    rule: "github_token",
    pattern: /gh[pousr]_[A-Za-z0-9_]{36,255}/,
    message: "Potential GitHub token detected."
  },
  {
    severity: "block",
    rule: "github_fine_grained_token",
    pattern: /github_pat_[A-Za-z0-9_]{22,255}/,
    message: "Potential GitHub fine-grained token detected."
  },
  {
    severity: "block",
    rule: "openai_api_key",
    pattern: /sk-[A-Za-z0-9_-]{20,}/,
    message: "Potential OpenAI API key detected."
  },
  {
    severity: "block",
    rule: "stripe_secret_key",
    pattern: /sk_(live|test)_[A-Za-z0-9]{16,}/,
    message: "Potential Stripe secret key detected."
  },
  {
    severity: "block",
    rule: "slack_token",
    pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/,
    message: "Potential Slack token detected."
  },
  {
    severity: "block",
    rule: "aws_access_key",
    pattern: /AKIA[A-Z0-9]{16}/,
    message: "Potential AWS access key detected."
  },
  {
    severity: "block",
    rule: "google_api_key",
    pattern: /AIza[A-Za-z0-9_-]{35}/,
    message: "Potential Google API key detected."
  },
  {
    severity: "block",
    rule: "generic_assignment_secret",
    pattern: /['"]?(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)['"]?\s*[:=]\s*['"][^'"\s]{12,}['"]/i,
    message: "Potential secret assignment detected."
  }
] as const;

const WARN_RULES: readonly SecretRule[] = [
  {
    severity: "warn",
    rule: "jwt_like_token",
    pattern: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
    message: "Potential JWT-like token detected."
  },
  {
    severity: "warn",
    rule: "bearer_token",
    pattern: /bearer\s+[A-Za-z0-9._~+/-]{20,}/i,
    message: "Potential bearer token detected."
  }
] as const;

const HIGH_ENTROPY_PATTERN = /[A-Za-z0-9_\-/+=]{40,}/g;
const HIGH_ENTROPY_THRESHOLD = 4.0;

export function detectSecretsInText(contents: string, path: string): SecretDetectionResult {
  return resultFromFindings(scanText(contents, path, null, true));
}

export function detectSecretsInPatch(value: unknown, path = "<patch>"): SecretDetectionResult {
  const findings: SecretFinding[] = [];
  scanPatchValue(value, path, "", findings);
  return resultFromFindings(findings);
}

export async function scanProjectSecrets(
  projectRoot: string
): Promise<SecretDetectionResult> {
  const paths = (
    await fg(".memory/**/*.{json,jsonl,md}", {
      cwd: projectRoot,
      dot: true,
      ignore: [".memory/index/**", ".memory/context/**"],
      onlyFiles: true,
      unique: true
    })
  ).sort();

  const findings: SecretFinding[] = [];
  const readErrors: ValidationIssue[] = [];

  for (const path of paths) {
    const contents = await readUtf8FileInsideRoot(projectRoot, path);

    if (!contents.ok) {
      readErrors.push(canonicalReadIssue(path, contents.error));
      continue;
    }

    findings.push(...scanText(contents.data, path, null, true));
  }

  const result = resultFromFindings(findings);

  return {
    ...result,
    valid: result.valid && readErrors.length === 0,
    errors: [...readErrors, ...result.errors]
  };
}

export function secretDetectionError(issues: readonly ValidationIssue[]): MemoryError {
  return memoryError(
    "MemorySecretDetected",
    "Secret material detected.",
    validationIssuesDetails(issues)
  );
}

function scanPatchValue(
  value: unknown,
  path: string,
  pointer: string,
  findings: SecretFinding[]
): void {
  if (typeof value === "string") {
    findings.push(...scanText(value, path, pointer === "" ? null : pointer, false));
    return;
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      scanPatchValue(item, path, `${pointer}/${index}`, findings);
    }
    return;
  }

  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      scanPatchValue(item, path, `${pointer}/${escapeJsonPointerToken(key)}`, findings);
    }
  }
}

function scanText(
  contents: string,
  path: string,
  field: string | null,
  includeLineNumbers: boolean
): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = contents.split(/\r\n|\n|\r/);

  for (const [index, line] of lines.entries()) {
    const lineNumber = includeLineNumbers ? index + 1 : undefined;

    for (const rule of [...BLOCK_RULES, ...WARN_RULES]) {
      for (const match of matchRule(rule, line)) {
        if (shouldIgnoreRuleMatch(rule, match, line)) {
          continue;
        }

        findings.push(secretFinding(rule, path, lineNumber, field));
      }
    }

    for (const match of line.matchAll(HIGH_ENTROPY_PATTERN)) {
      const candidate = match[0];
      if (shouldWarnForHighEntropyCandidate(candidate, line)) {
        findings.push(
          secretFinding(
            {
              severity: "warn",
              rule: "high_entropy_string",
              pattern: HIGH_ENTROPY_PATTERN,
              message: "Potential high-entropy secret detected."
            },
            path,
            lineNumber,
            field
          )
        );
      }
    }
  }

  return findings;
}

function matchRule(rule: SecretRule, line: string): string[] {
  const flags = rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`;
  return [...line.matchAll(new RegExp(rule.pattern.source, flags))].map((match) => match[0]);
}

function shouldIgnoreRuleMatch(rule: SecretRule, candidate: string, line: string): boolean {
  return rule.rule === "openai_api_key" && isMemoryIdentifierSubstring(candidate, line);
}

function isMemoryIdentifierSubstring(candidate: string, line: string): boolean {
  const tokens = line.match(/[A-Za-z0-9_.-]+/g) ?? [];

  return tokens.some(
    (token) =>
      token.includes(candidate) &&
      (/^[a-z][a-z0-9_]*\.[a-z0-9][a-z0-9-]*$/.test(token) ||
        /^rel\.[a-z0-9][a-z0-9-]*$/.test(token))
  );
}

function resultFromFindings(findings: readonly SecretFinding[]): SecretDetectionResult {
  const errors = findings.filter((finding) => finding.severity === "block").map(findingToIssue);
  const warnings = findings.filter((finding) => finding.severity === "warn").map(findingToIssue);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    findings: [...findings]
  };
}

function secretFinding(
  rule: SecretRule,
  path: string,
  line: number | undefined,
  field: string | null
): SecretFinding {
  return {
    severity: rule.severity,
    rule: rule.rule,
    path,
    ...(line === undefined ? {} : { line }),
    ...(field === null ? {} : { field }),
    message: rule.message
  };
}

function findingToIssue(finding: SecretFinding): ValidationIssue {
  return {
    code: finding.severity === "block" ? "MemorySecretDetected" : "MemorySecretWarning",
    message: finding.message,
    path: finding.line === undefined ? finding.path : `${finding.path}:${finding.line}`,
    field: finding.field ?? null
  };
}

function canonicalReadIssue(path: string, error: MemoryError): ValidationIssue {
  return {
    code: "CanonicalFileUnsafe",
    message: `Canonical file could not be read safely: ${error.message}`,
    path,
    field: null
  };
}

function shouldWarnForHighEntropyCandidate(candidate: string, line: string): boolean {
  if (shannonEntropy(candidate) < HIGH_ENTROPY_THRESHOLD) {
    return false;
  }

  return !(
    looksLikeMarkdownHeading(line) ||
    looksLikeProse(line) ||
    looksLikeFilePath(candidate, line) ||
    looksLikeUrl(candidate, line) ||
    looksLikeObjectId(candidate, line) ||
    looksLikeRelationId(candidate, line) ||
    looksLikeSha256Hash(candidate, line)
  );
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();

  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }

  return entropy;
}

function looksLikeMarkdownHeading(line: string): boolean {
  return /^#{1,6}\s+\S/.test(line.trim());
}

function looksLikeProse(line: string): boolean {
  const trimmed = line.trim();
  return /\s/.test(trimmed) && /[.!?]$/.test(trimmed);
}

function looksLikeFilePath(candidate: string, line: string): boolean {
  if (candidate.includes("/") && /^[\w.-]+\//.test(candidate)) {
    return true;
  }

  const escaped = escapeRegExp(candidate);
  return (
    new RegExp(`(^|\\s|["'\`])\\.?/?(?:[\\w.-]+/)+${escaped}(/|\\.|[\\s"'\`]|$)`).test(line) ||
    /\.(?:ts|tsx|js|jsx|json|jsonl|md|txt|yaml|yml|sql|sqlite|db)$/.test(candidate)
  );
}

function looksLikeUrl(candidate: string, line: string): boolean {
  return new RegExp(`https?://\\S*${escapeRegExp(candidate)}\\S*`).test(line);
}

function looksLikeObjectId(candidate: string, line: string): boolean {
  if (/^[a-z][a-z0-9_]*\.[a-z0-9][a-z0-9-]*$/.test(candidate)) {
    return true;
  }

  if (!/^[a-z0-9][a-z0-9-]*$/.test(candidate)) {
    return false;
  }

  return new RegExp(`\\b[a-z][a-z0-9_]*\\.${escapeRegExp(candidate)}\\b`).test(line);
}

function looksLikeRelationId(candidate: string, line: string): boolean {
  if (/^rel\.[a-z0-9][a-z0-9-]*$/.test(candidate)) {
    return true;
  }

  if (!/^[a-z0-9][a-z0-9-]*$/.test(candidate)) {
    return false;
  }

  return new RegExp(`\\brel\\.${escapeRegExp(candidate)}\\b`).test(line);
}

function looksLikeSha256Hash(candidate: string, line: string): boolean {
  return (
    /^[a-f0-9]{64}$/i.test(candidate) &&
    new RegExp(`\\bsha256:${escapeRegExp(candidate)}\\b`, "i").test(line)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function escapeJsonPointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validationIssuesDetails(issues: readonly ValidationIssue[]): JsonValue {
  return {
    issues: issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      path: issue.path,
      field: issue.field
    }))
  };
}
