/**
 * The thin orchestration of the local render-and-capture harness: resolve the
 * local base, build the dev-override cookie + the crop/downscale plan (all pure,
 * `plan.ts`), then drive the capture leg over it. The Playwright leg is the
 * injected seam — `@kampus/design-capture`'s `captureShots` by default — so the
 * orchestration is unit-tested with a fake leg (no real browser), the exact
 * pure-core + injected-impure-leg idiom the capture package already follows.
 *
 * Rendered against an empty local D1 (no seeding — designed-empty states are the
 * in-scope composition defect class, #2941): the harness targets a running
 * `alchemy dev` build and adds nothing to it; whatever data the local worker
 * serves is what renders.
 */
import {
	type CapturedSurface,
	CaptureError,
	type CaptureOptions,
	captureShots,
	type Shot,
	type Surface,
} from "@kampus/design-capture";
import {Effect} from "effect";
import {buildLocalShots, buildOverrideCookies, resolveLocalBase} from "./plan.ts";

/**
 * The injected Playwright capture leg — the `captureShots` shape. Defaulted to
 * `@kampus/design-capture`'s real leg; the unit test injects a fake to prove the
 * orchestration without a browser.
 */
export type CaptureLeg = (
	shots: readonly Shot[],
	outDir: string,
	options: CaptureOptions,
) => Effect.Effect<readonly CapturedSurface[], CaptureError>;

export interface LocalRenderRequest {
	/** The composed UI surfaces to render, each a route + optional state variant. */
	readonly surfaces: readonly Surface[];
	/** Directory the per-surface PNG bytes are written to. */
	readonly outDir: string;
	/** The localhost base to render over (default: the Vite dev origin). */
	readonly base?: string;
	/** Flag keys to force on/off locally via the dev-override cookie (default: none). */
	readonly overrides?: Readonly<Record<string, boolean>>;
	/** Per-surface changed-region clips (keyed by surface token) for crop/downscale. */
	readonly regions?: Readonly<Record<string, import("./plan.ts").CaptureDirective["clip"]>>;
	/** Override the longest-edge downscale budget (default {@link LONGEST_EDGE_BUDGET}). */
	readonly budget?: number;
	/** Viewport to render each surface at (default desktop). */
	readonly viewport?: import("@kampus/design-capture").Viewport;
	/** Per-navigation timeout in ms, passed through to the capture leg. */
	readonly navigationTimeoutMs?: number;
}

/** The seams the harness is parameterized over — the fake capture leg in the unit test. */
export interface LocalRenderDeps {
	readonly capture?: CaptureLeg;
}

/**
 * Render the composed UI surfaces over a running local `alchemy dev` build and
 * write per-surface PNG(s) to disk. Resolves + validates the local base, seeds
 * the dev-override cookie so flag-gated surfaces render, computes the
 * crop/downscale plan, and hands it to the capture leg. Returns one
 * `CapturedSurface` per surface (its `localPath` is the on-disk PNG the
 * downstream evidence-attach step, #2964, uploads).
 */
export const renderLocal = (
	request: LocalRenderRequest,
	deps: LocalRenderDeps = {},
): Effect.Effect<readonly CapturedSurface[], CaptureError> => {
	const capture = deps.capture ?? captureShots;
	// The pure setup can throw (an invalid/non-loopback base, an empty/duplicate
	// surface set, an off-page clip); wrap it so those surface as a CaptureError
	// in-channel rather than escaping synchronously before the Effect is returned.
	return Effect.try({
		try: () => {
			const base = resolveLocalBase(request.base);
			const regions =
				request.regions === undefined
					? undefined
					: Object.fromEntries(
							Object.entries(request.regions).flatMap(([k, v]) =>
								v === undefined ? [] : [[k, v]],
							),
						);
			const shots = buildLocalShots(base, request.surfaces, {
				...(request.viewport === undefined ? {} : {viewport: request.viewport}),
				...(request.budget === undefined ? {} : {budget: request.budget}),
				...(regions === undefined ? {} : {regions}),
			});
			const cookies = buildOverrideCookies(base, request.overrides ?? {});
			const options: CaptureOptions = {
				...(request.navigationTimeoutMs === undefined
					? {}
					: {navigationTimeoutMs: request.navigationTimeoutMs}),
				...(cookies.length === 0 ? {} : {cookies}),
			};
			return {shots, options};
		},
		catch: (cause) => new CaptureError({message: "failed to build local render plan", cause}),
	}).pipe(Effect.flatMap(({shots, options}) => capture(shots, request.outDir, options)));
};
