/**
 * `@kampus/worker-relevance` — public barrel. The pure verdict for whether a PR's
 * diff can affect the `apps/web` worker (issue #1014); the core + its fail-safe
 * design live in `./worker-relevance.ts`, the CI shell in `./bin.ts`.
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
