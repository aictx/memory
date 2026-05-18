# Agent guidance

Verification workflows:
- pnpm run typecheck: package.json script `typecheck`: `tsc --noEmit && svelte-check --tsconfig viewer/tsconfig.json`
- pnpm run test:local: package.json script `test:local`: `pnpm typecheck && pnpm test:package`
- pnpm run test:watch: package.json script `test:watch`: `vitest`
- pnpm run test: package.json script `test`: `vitest run`
- pnpm run test:package: package.json script `test:package`: `vitest run test/integration/release/packaging.test.ts`
- pnpm run build: package.json script `build`: `pnpm build:guidance && pnpm build:version && pnpm build:code && pnpm build:schemas && pnpm build:viewer`

Memory repair workflow:
- Use `memory suggest --after-task "<task>" --json` when the save/no-save choice is unclear; inspect `recommended_actions` and optional `repair_candidates` as advisory templates, not automatic truth.
- Treat possible-stale audit findings as prompts to verify against current code, tests, docs, and user corrections before updating, marking stale, or superseding memory.
- Use `memory audit --json` or the viewer Maintenance screen to review stale source origins, missing file references, unresolved active conflicts, weak provenance, and supersession chains.

Update this synthesis when agent instructions, conventions, repair guidance, or verification workflows change.