/**
 * The candidate-render step (epic #2955 story 1, issue #2961): render the founder's
 * priority surfaces over a flag-forced preview into a deterministic candidate set
 * staged for blessing — it does NOT bless (that is the founder's step, #2962).
 *
 * Thin orchestration over pure cores: resolve the priority surfaces
 * (`priority-surfaces.ts`), shoot them over the preview via the reused capture leg
 * (`capture.ts` — the same flake canon the review-design gate uses), PUT each
 * candidate's bytes to depo up front (so the emitted `sha256` IS what a later bless
 * commits — ADR 0183 §5 no-re-render guard), and fold the results into the candidate
 * set (`candidate-set.ts`). Both impure legs are injected seams — the unit test
 * drives the whole orchestration with fakes, no browser and no depo (the
 * pure-core + injected-impure-leg idiom `renderLocal`/`captureAndUpload` already use).
 */
import {Effect} from "effect";
import {assembleCandidateSet, type CandidateSet, type RenderedCandidate} from "./candidate-set.ts";
import {type CapturedSurface, CaptureError, type CaptureOptions, captureShots} from "./capture.ts";
import type {StoredGolden} from "./golden-store.ts";
import {buildCapturePlan, DEFAULT_VIEWPORT, type Shot, type Viewport} from "./plan.ts";
import {
	type PrioritySurfaceParams,
	type PrioritySurfaceSpec,
	resolvePrioritySurfaces,
} from "./priority-surfaces.ts";

/**
 * The injected Playwright capture leg — `captureShots`' shape. Defaulted to the real
 * leg; the unit test injects a fake to prove the orchestration without a browser.
 */
export type CaptureLeg = (
	shots: readonly Shot[],
	outDir: string,
	options: CaptureOptions,
) => Effect.Effect<readonly CapturedSurface[], CaptureError>;

/**
 * The injected depo store leg — PUT candidate bytes, get back `{ sha256, url }`. Its
 * error/requirement channels are the caller's (the bin provides the real
 * `storeGolden` + depo layer; the test injects a fake with neither), so this module's
 * `renderCandidateSet` stays parametric over both and needs no service at its edge.
 */
export type StoreLeg<E = never, R = never> = (
	pngBytes: Uint8Array,
) => Effect.Effect<StoredGolden, E, R>;

export interface RenderCandidateSetRequest {
	/** The flag-forced preview base URL to render the candidates over. */
	readonly previewUrl: string;
	/** Concrete data the priority routes need — the seeded sözlük term slug. */
	readonly params: PrioritySurfaceParams;
	/** Directory the per-candidate PNG bytes are written to. */
	readonly outDir: string;
	/**
	 * The forced flag state the preview is rendered under (flag key → on/off),
	 * recorded on the set as provenance. This step consumes an already-forced
	 * preview; it does not force flags (#2955).
	 */
	readonly forcedFlags?: Readonly<Record<string, boolean>>;
	/** Viewport to shoot each candidate at (default desktop). */
	readonly viewport?: Viewport;
	/** Passed through to the capture leg (timeout, full-page). */
	readonly captureOptions?: CaptureOptions;
	/** Override the priority set (test seam); defaults to the founder set. */
	readonly specs?: readonly PrioritySurfaceSpec[];
}

export interface RenderCandidateSetDeps<E = never, R = never> {
	readonly capture?: CaptureLeg;
	/** REQUIRED — the depo store leg (there is no browser-free default that PUTs bytes). */
	readonly store: StoreLeg<E, R>;
}

/**
 * Render the priority surfaces into a candidate set. Resolves the founder-ordered
 * surfaces, shoots them over the preview, stores each candidate's bytes to depo, and
 * assembles the set — one candidate screen per priority surface, in founder order,
 * each anchored to the exact `sha256` a later bless commits. A capture failure
 * short-circuits (nothing to bless from a broken render); a store failure propagates
 * in the leg's own error channel.
 */
export const renderCandidateSet = <E = never, R = never>(
	request: RenderCandidateSetRequest,
	deps: RenderCandidateSetDeps<E, R>,
): Effect.Effect<CandidateSet, CaptureError | E, R> => {
	const capture = deps.capture ?? captureShots;
	const viewport = request.viewport ?? DEFAULT_VIEWPORT;
	return Effect.try({
		try: () => {
			const surfaces = resolvePrioritySurfaces(request.params, request.specs);
			const plan = buildCapturePlan(
				request.previewUrl,
				surfaces.map((s) => s.surface),
				viewport,
			);
			return {surfaces, plan};
		},
		catch: (cause) => new CaptureError({message: "failed to build candidate-render plan", cause}),
	}).pipe(
		Effect.flatMap(({surfaces, plan}) =>
			capture(plan, request.outDir, request.captureOptions ?? {}).pipe(
				Effect.flatMap((captured) =>
					Effect.forEach(
						captured,
						(shot): Effect.Effect<RenderedCandidate, E, R> =>
							deps.store(shot.pngBytes).pipe(
								Effect.map(
									(stored): RenderedCandidate => ({
										surfaceId: shot.surface,
										sha256: stored.sha256,
										url: stored.url,
										fileName: shot.fileName,
										localPath: shot.localPath,
									}),
								),
							),
						{concurrency: 1},
					),
				),
				Effect.map((rendered) =>
					assembleCandidateSet({
						previewUrl: request.previewUrl,
						viewport: viewport.label,
						forcedFlags: request.forcedFlags ?? {},
						surfaces,
						rendered,
					}),
				),
			),
		),
	);
};
