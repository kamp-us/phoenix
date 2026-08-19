/**
 * The single source of truth for the worker-owned path set (#861, ADR 0027).
 *
 * Each {@link WorkerRoute} pairs a raw-`Request` route layer with the `runWorkerFirst`
 * glob that must shadow the SPA for it. They live together because they used to live
 * apart: register a route but forget the glob and the SPA shell is served instead — a
 * fail-quiet seam surfacing far from the omission. `worker-routes.unit.test.ts` pins
 * the lockstep.
 */
import type {Layer} from "effect/Layer";
import {fateRoute} from "../features/fate/route.ts";
import {liveRoute} from "../features/fate-live/route.ts";
import {flagsEvaluateRoute, flagsProbeRoute} from "../features/flagship/route.ts";
import {flagsDevApplyRoute, flagsDevPageRoute} from "../features/flagship/route-dev.ts";
import {shellBootRoute} from "../features/flagship/shell-boot-route.ts";
import {mecmuaIndexRoute} from "../features/mecmua/index-route.ts";
import {mecmuaPublicReadRoute} from "../features/mecmua/public-read-route.ts";
import {baseFeedRoute} from "../features/pano/base-feed-route.ts";
import {linkMetadataRoute} from "../features/pano/link-metadata-route.ts";
import {authRoute} from "../features/pasaport/route.ts";
import {rssRoute} from "../features/rss/route.ts";

/**
 * `any` is the element type `Layer.mergeAll` accepts (`Layer<never, any, any>`): each
 * `HttpRouter.add` lifts its handler's `E`/`R` into per-route markers — discharged by
 * `provideRequest` in `app.ts` — so the markers vary per route.
 */
export type WorkerRouteLayer = Layer<never, any, any>;

export interface WorkerRoute {
	readonly path: string;
	readonly glob: string;
	readonly route: WorkerRouteLayer;
}

/**
 * Every raw worker-owned route, each paired with its covering glob. Typed as a
 * non-empty tuple so {@link rawWorkerRouteLayers} satisfies `Layer.mergeAll`'s arity
 * without a cast.
 */
export const rawWorkerRoutes: readonly [WorkerRoute, ...WorkerRoute[]] = [
	{path: "/fate", glob: "/fate", route: fateRoute},
	{path: "/fate/live", glob: "/fate/*", route: liveRoute},
	{path: "/fate/pano/feed", glob: "/fate/*", route: baseFeedRoute},
	// Dark behind `MECMUA_PUBLIC_READ` (404 until flipped).
	{path: "/fate/mecmua/post/:slug", glob: "/fate/*", route: mecmuaPublicReadRoute},
	// Dark behind `MECMUA_PUBLIC_READ` (404 until flipped).
	{path: "/fate/mecmua/index", glob: "/fate/*", route: mecmuaIndexRoute},
	{path: "/api/auth/*", glob: "/api/*", route: authRoute},
	{path: "/api/flags/probe", glob: "/api/*", route: flagsProbeRoute},
	{path: "/api/flags/evaluate", glob: "/api/*", route: flagsEvaluateRoute},
	// Both verbs fail-closed to 404 outside `development` (`route-dev.ts`).
	{path: "/api/flags/dev", glob: "/api/*", route: flagsDevPageRoute},
	{path: "/api/flags/dev", glob: "/api/*", route: flagsDevApplyRoute},
	{path: "/api/pano/link-metadata", glob: "/api/*", route: linkMetadataRoute},
	{path: "/rss.xml", glob: "/rss.xml", route: rssRoute},
	// The edge-render shell catch-all (#2929, ADR 0179). Specific routes above win by
	// find-my-way precedence, so this catches only what they do not.
	{path: "/*", glob: "/*", route: shellBootRoute},
];

/**
 * The `!`-prefixed `run_worker_first` exceptions — globs that keep a matching path
 * edge-direct even though a positive glob would pull it worker-first (the CF
 * spa-shell recipe `["/*", "!/assets/*"]`).
 */
export const assetExceptionGlobs: readonly string[] = ["!/assets/*"];

export const rawWorkerRouteLayers: readonly [WorkerRouteLayer, ...WorkerRouteLayer[]] = [
	rawWorkerRoutes[0].route,
	...rawWorkerRoutes.slice(1).map((r) => r.route),
];

/**
 * Worker-owned paths NOT served as raw routes — the typed-JSON `HttpApi` group.
 * Listed here only so the lockstep test proves a glob covers them too.
 */
export const typedWorkerPaths: readonly string[] = ["/api/health"];

/**
 * Does one POSITIVE glob's covered path set contain another's? `/*` (empty prefix)
 * covers every `/…` glob; an exact glob covers only itself.
 */
const globCovers = (broad: string, narrow: string): boolean => {
	if (!broad.endsWith("/*")) return narrow === broad;
	const prefix = broad.slice(0, -2);
	const base = narrow.endsWith("/*") ? narrow.slice(0, -2) : narrow;
	return base === prefix || base.startsWith(`${prefix}/`);
};

/**
 * Cloudflare's `run_worker_first` REJECTS a redundant positive rule — one another
 * positive already subsumes (`rule '/fate' is invalid; rule '/*' makes it redundant`,
 * PR #2984). So the config MUST be minimized before it reaches the CF API; runtime
 * routing is unchanged.
 */
const minimizePositiveGlobs = (positives: readonly string[]): string[] =>
	positives.filter((g) => !positives.some((other) => other !== g && globCovers(other, g)));

/**
 * The glob set `index.ts` passes to `assets.runWorkerFirst`: deduplicated, minimized
 * positives (CF rejects redundant rules, #2984) then the `!`-exceptions.
 */
export const workerFirstGlobs: readonly string[] = [
	...minimizePositiveGlobs([...new Set(rawWorkerRoutes.map((r) => r.glob))]),
	...assetExceptionGlobs,
];

/**
 * Mirrors Cloudflare's matching for a single POSITIVE glob. Exception-blind — a
 * `!`-prefixed glob is composed by {@link runsWorkerFirst}, not here.
 */
export const globMatches = (glob: string, path: string): boolean => {
	if (glob.endsWith("/*")) {
		const prefix = glob.slice(0, -2);
		return path === prefix || path.startsWith(`${prefix}/`);
	}
	return glob === path;
};

/**
 * Models Cloudflare's `run_worker_first` composition: a path runs worker-first iff
 * some positive glob matches it AND no `!`-exception does.
 */
export const runsWorkerFirst = (globs: readonly string[], path: string): boolean => {
	const positives = globs.filter((g) => !g.startsWith("!"));
	const exceptions = globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1));
	return (
		positives.some((g) => globMatches(g, path)) && !exceptions.some((g) => globMatches(g, path))
	);
};
