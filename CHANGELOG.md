# Changelog

All notable changes to `@aictx/memory` should be documented here.

This project is pre-1.0. Minor versions may include breaking changes when they
are called out in the release notes.

## Unreleased

- Added advisory stale/conflict maintenance signals to `memory audit`,
  repair-oriented candidates to `memory suggest --after-task`, and a viewer
  Maintenance screen for reviewable memory hygiene.
- Added storage v4 source `origin` metadata, `supports`/`challenges` relation
  predicates, and the CLI-only `memory wiki` workflow for source-backed ingest,
  filing, linting, and event logs.
- Added open source community health files and issue/PR templates.
- Added CI, CodeQL, OpenSSF Scorecard, Dependabot, and npm provenance release
  workflow configuration.
- Added Homebrew formula publishing through the release workflow and documented
  `brew install aictx/tap/memory`.
- Narrowed npm package files so bundled docs no longer include Astro build
  output or tool caches.
- Added package metadata for repository, homepage, issues, and npm discovery.

## 0.1.26 - 2026-05-07

- Current published npm package before the open source readiness pass.
