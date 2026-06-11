import { readFile } from "node:fs/promises";

const repoRootUrl = new URL("../", import.meta.url);
const packageJsonUrl = new URL("package.json", repoRootUrl);
const packageJson = JSON.parse(await readFile(packageJsonUrl, "utf8"));
const options = parseOptions(process.argv.slice(2));
const version = options.version ?? packageJson.version;
const sha256 = options.sha256;

if (typeof version !== "string" || version.length === 0) {
  throw new Error("Pass --version or declare a non-empty package.json version.");
}

if (!isSha256(sha256)) {
  throw new Error("Pass --sha256 with the npm tarball SHA-256.");
}

process.stdout.write(renderFormula({ version, sha256 }));

function renderFormula({ version, sha256 }) {
  return `class Memory < Formula
  desc "Local-first product graph for AI coding agents"
  homepage "https://memory.aictx.dev"
  url "https://registry.npmjs.org/@aictx/memory/-/memory-${version}.tgz"
  sha256 "${sha256}"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args

    node_path = Formula["node"].opt_bin
    (bin/"memory").write_env_script libexec/"bin/memory", PATH: "#{node_path}:$PATH"
    (bin/"memory-mcp").write_env_script libexec/"bin/memory-mcp", PATH: "#{node_path}:$PATH"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/memory --version")
    assert_match "Memory docs:", shell_output("#{bin}/memory docs")
  end
end
`;
}

function parseOptions(args) {
  const result = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--") {
      continue;
    }

    if (arg === "--version") {
      result.version = requireValue(args, index);
      index += 1;
      continue;
    }

    if (arg === "--sha256") {
      result.sha256 = requireValue(args, index);
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return result;
}

function requireValue(args, index) {
  const value = args[index + 1];

  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${args[index]} requires a value.`);
  }

  return value;
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
