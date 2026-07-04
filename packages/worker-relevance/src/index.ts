/**
 * `@kampus/worker-relevance` — the pure verdict for whether a PR's diff can affect
 * the `apps/web` worker (issue #1014). The core (`classify`/`inputFromEnv`) is a
 * pure, IO-free, zero-runtime-dependency classifier; `bin.ts` is the thin Node shell
 * the `changes` job runs to gate the worker `integration`/`e2e` tiers off a diff
 * confined to worker-irrelevant packages — including a `pnpm-lock.yaml` delta
 * confined to their importer blocks — fail-safe to running.
 */
export {
	type ClassifyInput,
	type ClassifyResult,
	classify,
	extractKampusPackages,
	INTEGRATION_RELEVANT_PACKAGES,
	inputFromEnv,
	LOCKFILE,
	parseChangedFiles,
	parseTestImportedPackages,
	type Verdict,
} from "./worker-relevance.ts";
