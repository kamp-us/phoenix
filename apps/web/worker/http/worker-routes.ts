/**
 * The single source of truth for the worker-owned path set (#861, ADR 0027).
 *
 * The set of paths the worker answers — vs. the SPA `assets` binding serving
 * `dist/client` — used to live twice: once as the route layers merged into the
 * `HttpRouter` (`app.ts`), once as the literal `runWorkerFirst` glob (`index.ts`).
 * Coupled only by convention, the two could drift: register a route but forget
 * the glob and `notFoundHandling: "single-page-application"` silently serves the
 * SPA shell on GET (405 on non-GET) — a fail-quiet seam surfacing far from the
 * omission.
 *
 * Here both consumers derive from ONE list. Each {@link WorkerRoute} pairs a
 * raw-`Request` route layer with the `runWorkerFirst` glob that must shadow the
 * SPA for it. The route table reads `.route`; `runWorkerFirst` reads `.glob`
 * (deduplicated, {@link workerFirstGlobs}). Adding a worker-owned route is one
 * edit to {@link rawWorkerRoutes} — the glob can no longer be forgotten, and the
 * lockstep test (`worker-routes.unit.test.ts`) pins that every route's mount path
 * is matched by a derived glob.
 *
 * The edge-render shell route (#2929, ADR 0179) extends this to the CF spa-shell recipe
 * (`["/*", "!/assets/*"]`): a catch-all `/*` glob pulls every non-asset request through
 * the worker, and a `!`-prefixed exception ({@link assetExceptionGlobs}) keeps the built
 * `/assets/*` bundles edge-direct. `globMatches` models a single positive glob;
 * {@link runsWorkerFirst} composes the positives and the `!`-exceptions the way Cloudflare
 * evaluates `run_worker_first` (any positive matches AND no exception matches), so the
 * lockstep test can pin the `!`-exception <-> HTML-route coupling.
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
 * A raw route layer with its per-route requirement markers undischarged. Each
 * `HttpRouter.add` lifts its handler's `E`/`R` into route markers (discharged by
 * `provideRequest` in `app.ts`), so the markers vary per route — `any` here is
 * the same element type `Layer.mergeAll` accepts (`Layer<never, any, any>`).
 */
export type WorkerRouteLayer = Layer<never, any, any>;

/**
 * A worker-owned raw route plus the `runWorkerFirst` glob that keeps the SPA
 * shell from shadowing it. `path` mirrors the route's `HttpRouter.add(_, path, _)`
 * mount — the field the lockstep test checks `glob` against, so a mismatched
 * pairing fails CI.
 */
export interface WorkerRoute {
	/** The route's mount path, mirroring its `HttpRouter.add(_, path, _)`. */
	readonly path: string;
	/** The `runWorkerFirst` glob that must match {@link path}. */
	readonly glob: string;
	/** The route layer merged into the `HttpRouter`. */
	readonly route: WorkerRouteLayer;
}

/**
 * Every raw worker-owned route, each paired with its covering glob. The typed
 * health route (`GET /api/health`) is owned by the `/api/*` glob below; its
 * coverage is asserted in the lockstep test via {@link typedWorkerPaths}.
 *
 * Typed as a non-empty tuple so {@link rawWorkerRouteLayers} satisfies
 * `Layer.mergeAll`'s `[Layer, ...Layer[]]` arity without a cast.
 */
export const rawWorkerRoutes: readonly [WorkerRoute, ...WorkerRoute[]] = [
	{path: "/fate", glob: "/fate", route: fateRoute},
	{path: "/fate/live", glob: "/fate/*", route: liveRoute},
	// The GET-able base feed (#2322, epic #2316 leg B); the `/fate/*` glob already
	// shadows the SPA for it.
	{path: "/fate/pano/feed", glob: "/fate/*", route: baseFeedRoute},
	// The public read of a single published mecmua post (#2498, epic #2467); the
	// `/fate/*` glob already shadows the SPA for it. Dark behind `MECMUA_PUBLIC_READ`
	// (404 until flipped).
	{path: "/fate/mecmua/post/:slug", glob: "/fate/*", route: mecmuaPublicReadRoute},
	// The public chronological index of published mecmua posts (#2512, epic #2467); the
	// `/fate/*` glob already shadows the SPA for it. Dark behind `MECMUA_PUBLIC_READ`
	// (404 until flipped).
	{path: "/fate/mecmua/index", glob: "/fate/*", route: mecmuaIndexRoute},
	{path: "/api/auth/*", glob: "/api/*", route: authRoute},
	{path: "/api/flags/probe", glob: "/api/*", route: flagsProbeRoute},
	{path: "/api/flags/evaluate", glob: "/api/*", route: flagsEvaluateRoute},
	// Dev-only flag-override surface (#622) — statically mounted, but both verbs
	// fail-closed to 404 outside `development` (`route-dev.ts`).
	{path: "/api/flags/dev", glob: "/api/*", route: flagsDevPageRoute},
	{path: "/api/flags/dev", glob: "/api/*", route: flagsDevApplyRoute},
	{path: "/api/pano/link-metadata", glob: "/api/*", route: linkMetadataRoute},
	{path: "/rss.xml", glob: "/rss.xml", route: rssRoute},
	// The edge-render shell catch-all (#2929, ADR 0179): mounted `* /*` so it serves the
	// SPA shell through the worker and injects `window.__BOOT__`, dark behind
	// `PHOENIX_EDGE_SHELL_BOOT`. The `/*` glob pulls every non-asset path worker-first; the
	// `!/assets/*` exception ({@link assetExceptionGlobs}) keeps the built bundles edge-direct.
	// Specific routes above win by find-my-way precedence, so this catches only what they don't.
	{path: "/*", glob: "/*", route: shellBootRoute},
];

/**
 * The `!`-prefixed `run_worker_first` exceptions — globs that keep a matching path
 * edge-direct even though a positive glob would pull it worker-first. Cloudflare's
 * `run_worker_first` reads a `!`-prefixed entry as an exclusion (the spa-shell recipe
 * `["/*", "!/assets/*"]`), so `/assets/*` (the Vite-hashed bundles) stays served by the
 * `ASSETS` binding at the edge while `/*` routes everything else through the worker.
 * Kept a module constant so {@link workerFirstGlobs} carries it into `runWorkerFirst` and
 * {@link runsWorkerFirst} / the lockstep test model it.
 */
export const assetExceptionGlobs: readonly string[] = ["!/assets/*"];

/**
 * The raw route layers as a non-empty tuple — `app.ts` spreads this into
 * `Layer.mergeAll`. Derived from {@link rawWorkerRoutes} so the merged route set
 * and the {@link workerFirstGlobs} can't diverge.
 */
export const rawWorkerRouteLayers: readonly [WorkerRouteLayer, ...WorkerRouteLayer[]] = [
	rawWorkerRoutes[0].route,
	...rawWorkerRoutes.slice(1).map((r) => r.route),
];

/**
 * Worker-owned paths NOT served as raw routes — the typed-JSON `HttpApi` group
 * (`health.ts`), which `app.ts` merges separately. Listed here only so the
 * lockstep test proves a glob covers them too.
 */
export const typedWorkerPaths: readonly string[] = ["/api/health"];

/**
 * Does one POSITIVE glob's covered path set contain another's? A prefix glob `/p/*` covers any
 * glob whose base (its own prefix, or an exact path) is `/p` or sits under `/p/`; an exact glob
 * covers only itself. `/*` (empty prefix) therefore covers every `/…` glob. Used to drop
 * redundant positives below.
 */
const globCovers = (broad: string, narrow: string): boolean => {
	if (!broad.endsWith("/*")) return narrow === broad;
	const prefix = broad.slice(0, -2);
	const base = narrow.endsWith("/*") ? narrow.slice(0, -2) : narrow;
	return base === prefix || base.startsWith(`${prefix}/`);
};

/**
 * Cloudflare's `run_worker_first` REJECTS a redundant positive rule — one another positive rule
 * already subsumes (`BadRequest: rule '/fate' is invalid; rule '/*' makes it redundant`, PR #2984).
 * With the catch-all `/*` in the derived set, every specific worker-route glob is redundant, so the
 * config MUST be minimized to the broadest positives before it reaches the CF API. Runtime routing
 * is unchanged: `/*` already routes every non-asset path worker-first (the `!`-exception keeps the
 * built bundles edge-direct), and find-my-way precedence dispatches the specific routes.
 */
const minimizePositiveGlobs = (positives: readonly string[]): string[] =>
	positives.filter((g) => !positives.some((other) => other !== g && globCovers(other, g)));

/**
 * The `runWorkerFirst` glob set `index.ts` passes to `assets.runWorkerFirst`: the deduplicated
 * positives from {@link rawWorkerRoutes}, MINIMIZED so no positive is redundant under a broader
 * one (CF rejects redundant rules — #2984), followed by the {@link assetExceptionGlobs}
 * `!`-exceptions. With the `/*` catch-all present this collapses to `["/*", "!/assets/*"]`.
 */
export const workerFirstGlobs: readonly string[] = [
	...minimizePositiveGlobs([...new Set(rawWorkerRoutes.map((r) => r.glob))]),
	...assetExceptionGlobs,
];

/**
 * Does a single POSITIVE `runWorkerFirst` glob match a mount path? Mirrors Cloudflare's
 * matching: a trailing `/*` matches the prefix and anything under it; otherwise an exact
 * path match. Deliberately small (the prod matcher is Cloudflare's, not ours) and
 * exception-blind — a `!`-prefixed glob is composed by {@link runsWorkerFirst}, not here.
 */
export const globMatches = (glob: string, path: string): boolean => {
	if (glob.endsWith("/*")) {
		const prefix = glob.slice(0, -2);
		return path === prefix || path.startsWith(`${prefix}/`);
	}
	return glob === path;
};

/**
 * Would a path run worker-first under a glob set that may carry `!`-exceptions? Models
 * Cloudflare's `run_worker_first` composition: a path runs worker-first iff some positive
 * glob matches it AND no `!`-exception matches it. So `["/*", "!/assets/*"]` routes every
 * path worker-first except `/assets/*` (the built bundles), which stays edge-direct. The
 * lockstep test uses this to pin the `!`-exception <-> HTML-route coupling.
 */
export const runsWorkerFirst = (globs: readonly string[], path: string): boolean => {
	const positives = globs.filter((g) => !g.startsWith("!"));
	const exceptions = globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1));
	return (
		positives.some((g) => globMatches(g, path)) && !exceptions.some((g) => globMatches(g, path))
	);
};
