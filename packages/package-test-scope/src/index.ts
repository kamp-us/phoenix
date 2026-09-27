/**
 * `@kampus/package-test-scope` — public barrel. The core lives in `./scope.ts`, the
 * workspace readers in `./workspace.ts`, and the CI shell in `./bin.ts`.
 */
export {
	CROSS_PACKAGE_READS,
	decideScope,
	INFRA_PACKAGE,
	inTestScope,
	type Member,
	SCOPED_EVENTS,
	type Scope,
	type ScopeInput,
	selects,
} from "./scope.ts";
export {parseMember, parseWorkspaceRoots} from "./workspace.ts";
