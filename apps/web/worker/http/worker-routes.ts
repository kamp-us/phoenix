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
 */
import type {Layer} from "effect/Layer";
import {fateRoute} from "../features/fate/route.ts";
import {liveRoute} from "../features/fate-live/route.ts";
import {flagsEvaluateRoute, flagsProbeRoute} from "../features/flagship/route.ts";
import {flagsDevApplyRoute, flagsDevPageRoute} from "../features/flagship/route-dev.ts";
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
	// shadows the SPA for it. Dark behind `PANO_BASE_FEED` (404 until flipped).
	{path: "/fate/pano/feed", glob: "/fate/*", route: baseFeedRoute},
	// The public read of a single published mecmua post (#2498, epic #2467); the
	// `/fate/*` glob already shadows the SPA for it. Dark behind `MECMUA_PUBLIC_READ`
	// (404 until flipped).
	{path: "/fate/mecmua/post/:slug", glob: "/fate/*", route: mecmuaPublicReadRoute},
	{path: "/api/auth/*", glob: "/api/*", route: authRoute},
	{path: "/api/flags/probe", glob: "/api/*", route: flagsProbeRoute},
	{path: "/api/flags/evaluate", glob: "/api/*", route: flagsEvaluateRoute},
	// Dev-only flag-override surface (#622) — statically mounted, but both verbs
	// fail-closed to 404 outside `development` (`route-dev.ts`).
	{path: "/api/flags/dev", glob: "/api/*", route: flagsDevPageRoute},
	{path: "/api/flags/dev", glob: "/api/*", route: flagsDevApplyRoute},
	{path: "/api/pano/link-metadata", glob: "/api/*", route: linkMetadataRoute},
	{path: "/rss.xml", glob: "/rss.xml", route: rssRoute},
];

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
 * The deduplicated `runWorkerFirst` glob set, derived from {@link rawWorkerRoutes}.
 * This is what `index.ts` passes to `assets.runWorkerFirst`.
 */
export const workerFirstGlobs: readonly string[] = [...new Set(rawWorkerRoutes.map((r) => r.glob))];

/**
 * Does a `runWorkerFirst` glob match a mount path? Mirrors Cloudflare's
 * `runWorkerFirst` matching: a trailing `/*` matches the prefix and anything
 * under it; otherwise an exact path match. Used by the lockstep test to prove
 * coverage — kept deliberately small (the prod matcher is Cloudflare's, not ours).
 */
export const globMatches = (glob: string, path: string): boolean => {
	if (glob.endsWith("/*")) {
		const prefix = glob.slice(0, -2);
		return path === prefix || path.startsWith(`${prefix}/`);
	}
	return glob === path;
};
