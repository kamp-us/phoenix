/**
 * `@kampus/app-boundary-guard` — public barrel. The rule and its verdict live in
 * `./app-boundary.ts`; the CI shell is `./bin.ts`.
 */
export {
	APP_SCOPE,
	DEPENDENCY_FIELDS,
	type DependencyField,
	dependencyFindings,
	EXIT,
	type Finding,
	importFindings,
	isApp,
	judge,
	parseManifest,
	parseWorkspaceGlobs,
	render,
	type ScanResult,
	type Verdict,
	type WorkspaceGlob,
	type WorkspaceGlobs,
} from "./app-boundary.ts";
