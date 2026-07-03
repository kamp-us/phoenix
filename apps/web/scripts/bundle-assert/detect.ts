/**
 * The pure node-core detector: given the worker bundle's module graph, decide
 * whether it reaches any forbidden Node-only module (ADR 0118, #1502 AC2, #1836).
 *
 * No IO, no bundler — total over its inputs, so the whole assertion's logic is
 * unit-testable without rolldown or a filesystem (`bundle.ts` is the impure
 * boundary that produces the {@link BundleGraph}; `main.ts` is the thin bin).
 *
 * Two detection surfaces, because a Node module reaches the bundle two ways:
 *   - a `node:*` builtin survives as a KEPT-EXTERNAL import specifier (the
 *     cloudflare plugin leaves workerd builtins external), so we match it against
 *     the bundle's external imports;
 *   - an npm package (winston / pino / @sentry/node-core) gets its source pulled
 *     into a chunk, so its resolved file path appears in a chunk's `moduleIds`.
 *
 * The allowlist is the load-bearing subtlety. `node:child_process` is ALREADY in
 * the known-good phoenix worker bundle: `@effect/platform-node`'s `NodeServices`
 * statically imports it (workerd ships a throwing stub; the worker never spawns a
 * child), so forbidding it outright would red `main`. It is therefore forbidden
 * *and* allowlisted-with-a-reason — the regression this gate actually guards is a
 * `@sentry/node-core` barrel re-entering the graph (getsentry/sentry-javascript#20038,
 * ADR 0118), which is absent today and never allowlisted.
 */

/** The bundle's reachable module graph, lowered from rolldown's output chunks. */
export interface BundleGraph {
	/** Resolved file paths of every module bundled into a chunk. */
	readonly moduleIds: ReadonlyArray<string>;
	/** Kept-external import specifiers across all chunks (includes surviving `node:*`). */
	readonly externalImports: ReadonlyArray<string>;
}

/** A forbidden module that is nonetheless tolerated, with the reason it is safe. */
export interface AllowlistEntry {
	readonly module: string;
	readonly reason: string;
}

export interface DetectConfig {
	/** Modules whose presence in the bundle is a violation (extensible — AC4). */
	readonly forbidden: ReadonlyArray<string>;
	/** Forbidden-but-tolerated modules; each carries the reason it stays out of the fail set. */
	readonly allowlist: ReadonlyArray<AllowlistEntry>;
}

export interface Offender {
	readonly module: string;
	readonly via: "external-import" | "module-graph";
	/** The concrete specifier or module-id path that matched. */
	readonly evidence: string;
}

export interface DetectResult {
	readonly status: "pass" | "fail";
	readonly offenders: ReadonlyArray<Offender>;
	/** Forbidden modules that ARE present but were allowlisted (informational). */
	readonly allowlisted: ReadonlyArray<string>;
	readonly scanned: {readonly moduleIds: number; readonly externalImports: number};
}

/**
 * The default forbidden set (ADR 0118, #1502 AC2). The four named modules plus
 * `@sentry/node-core` — the barrel root that transitively pulls winston/pino and
 * the workerd-hostile `node:*` set. Extensible: append a module here, or pass
 * `--forbidden` to {@link main}. `node:child_process` is listed *and* allowlisted
 * below (present in the known-good bundle via `@effect/platform-node`).
 */
export const DEFAULT_FORBIDDEN: ReadonlyArray<string> = [
	"node:child_process",
	"node:inspector",
	"winston",
	"pino",
	"@sentry/node-core",
];

export const DEFAULT_ALLOWLIST: ReadonlyArray<AllowlistEntry> = [
	{
		module: "node:child_process",
		reason:
			"@effect/platform-node's NodeServices statically imports node:child_process; workerd provides a throwing stub and the worker never spawns a child, so it loads and serves fine. Present in the known-good bundle (ADR 0118 / #1502). The real regression guard is @sentry/node-core re-entering the graph, which is never allowlisted.",
	},
];

/** Does a `node:*` builtin survive as a kept-external import? */
const matchExternal = (module: string, externals: ReadonlyArray<string>): string | undefined =>
	externals.find((e) => e === module || e === `${module}/` || e.startsWith(`${module}/`));

/**
 * Does an npm package's source sit in the bundle? Matches the resolved module-id
 * path (`…/node_modules/<pkg>/…`, scoped names included) or a kept-external
 * specifier equal to / under the bare name.
 */
const matchPackage = (
	pkg: string,
	graph: BundleGraph,
): {via: Offender["via"]; evidence: string} | undefined => {
	const idHit = graph.moduleIds.find((id) => id.includes(`/node_modules/${pkg}/`));
	if (idHit !== undefined) return {via: "module-graph", evidence: idHit};
	const extHit = graph.externalImports.find((e) => e === pkg || e.startsWith(`${pkg}/`));
	if (extHit !== undefined) return {via: "external-import", evidence: extHit};
	return undefined;
};

/**
 * Scan the bundle graph for forbidden modules. A `node:*` entry is matched
 * against external imports; anything else is treated as an npm package matched
 * against the module graph. A present-but-allowlisted forbidden module is
 * recorded (not an offender). `status` is `fail` iff any non-allowlisted forbidden
 * module is present.
 */
export const detectNodeCore = (graph: BundleGraph, config: DetectConfig): DetectResult => {
	const allowed = new Set(config.allowlist.map((a) => a.module));
	const offenders: Offender[] = [];
	const allowlisted: string[] = [];

	for (const module of config.forbidden) {
		const match = module.startsWith("node:")
			? (() => {
					const e = matchExternal(module, graph.externalImports);
					return e === undefined ? undefined : {via: "external-import" as const, evidence: e};
				})()
			: matchPackage(module, graph);
		if (match === undefined) continue;
		if (allowed.has(module)) {
			allowlisted.push(module);
			continue;
		}
		offenders.push({module, via: match.via, evidence: match.evidence});
	}

	return {
		status: offenders.length === 0 ? "pass" : "fail",
		offenders,
		allowlisted,
		scanned: {moduleIds: graph.moduleIds.length, externalImports: graph.externalImports.length},
	};
};

/** The run-evidence `checks[]` entry name this assertion folds into (ADR 0054 §2). */
export const CHECK_NAME = "bundle-node-core-free";

/** Shape the detect result as an ADR 0054 §2 `Check` the run-evidence manifest folds in. */
export const toCheck = (
	result: DetectResult,
): {name: string; status: "pass" | "fail"; exitCode: number} => ({
	name: CHECK_NAME,
	status: result.status,
	exitCode: result.status === "pass" ? 0 : 1,
});
