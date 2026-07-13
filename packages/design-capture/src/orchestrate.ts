/**
 * The seam #2246 (the review-design skill) codes against: capture a UI PR's
 * changed surfaces over its preview deploy, host each as a GitHub attachment,
 * and return one record per surface.
 *
 *   captureAndUpload(request) : Effect<CaptureRecord[], CaptureError, HttpClient>
 *
 * Each `CaptureRecord` is `{surface, route, state, localPath, hostedUrl,
 * uploadError}`:
 *   - `localPath` is ALWAYS present when capture succeeded — the PRIMARY judged
 *     artifact (the gate reads the local PNG bytes), decoupled from upload.
 *   - `hostedUrl` is the GitHub user-attachments URL when upload succeeded, else
 *     `null` (the fallback fired).
 *   - `uploadError` is the diagnostic when the (undocumented) upload endpoint
 *     failed, else `null`.
 *
 * Only a genuine CAPTURE failure short-circuits (`CaptureError`); the upload leg
 * never fails the effect, so a broken endpoint degrades `hostedUrl`/`uploadError`
 * but never loses `localPath` and never breaks the gate (ADR 0165).
 */
import {Effect} from "effect";
import type {HttpClient} from "effect/unstable/http/HttpClient";
import {type CapturedSurface, CaptureError, type CaptureOptions, captureShots} from "./capture.ts";
import type {PageError} from "./page-errors.ts";
import {buildCapturePlan, type Surface, type Viewport} from "./plan.ts";
import {type UploadOutcome, uploadAsset} from "./upload.ts";

/** One captured surface: the always-present local artifact + the upload outcome. */
export interface CaptureRecord {
	readonly surface: string;
	readonly route: string;
	readonly state: string | null;
	/** The on-disk PNG the gate judges — never null on a successful capture. */
	readonly localPath: string;
	/** The GitHub-hosted evidence URL, or `null` when the upload fell back. */
	readonly hostedUrl: string | null;
	/** The upload diagnostic when the fallback fired, else `null`. */
	readonly uploadError: string | null;
	/** Runtime errors thrown into the page during the render — the #2594 crash signal. */
	readonly pageErrors: readonly PageError[];
}

export interface CaptureAndUploadRequest {
	/** The per-PR preview base URL (from the `preview-deploy` bot comment). */
	readonly previewUrl: string;
	/** The changed UI surfaces to shoot — each a route + optional state. */
	readonly surfaces: readonly Surface[];
	/** Directory the PNG bytes are written to (the `localPath` root). */
	readonly outDir: string;
	/** The target repo's numeric id (`gh api repos/OWNER/REPO --jq .id`). */
	readonly repositoryId: number;
	/** A GitHub token with write access to the target repo. */
	readonly token: string;
	/** The viewport to shoot each surface at (default desktop). */
	readonly viewport?: Viewport;
	/** Passed through to the Playwright capture (timeout, full-page). */
	readonly captureOptions?: CaptureOptions;
}

/**
 * PURE: fold an upload outcome onto a captured surface. `localPath` is copied
 * straight through and is never conditional on the upload (ADR 0165).
 */
export const mergeRecord = (captured: CapturedSurface, outcome: UploadOutcome): CaptureRecord => ({
	surface: captured.surface,
	route: captured.route,
	state: captured.state,
	localPath: captured.localPath,
	hostedUrl: outcome.hostedUrl,
	uploadError: outcome.uploadError,
	pageErrors: captured.pageErrors,
});

/**
 * Capture then upload: build the plan, shoot every entry over the preview
 * (writing each PNG to `outDir`), and upload each. Returns one `CaptureRecord`
 * per surface, in plan order — `localPath` always set, `hostedUrl`/`uploadError`
 * reflecting the upload. Only a `CaptureError` short-circuits.
 */
export const captureAndUpload = (
	request: CaptureAndUploadRequest,
): Effect.Effect<readonly CaptureRecord[], CaptureError, HttpClient> =>
	Effect.try({
		try: () => buildCapturePlan(request.previewUrl, request.surfaces, request.viewport),
		catch: (cause) => new CaptureError({message: "failed to build capture plan", cause}),
	}).pipe(
		Effect.flatMap((plan) => captureShots(plan, request.outDir, request.captureOptions ?? {})),
		Effect.flatMap((captured) =>
			Effect.forEach(
				captured,
				(shot) =>
					uploadAsset({
						pngBytes: shot.pngBytes,
						repositoryId: request.repositoryId,
						token: request.token,
						fileName: shot.fileName,
					}).pipe(Effect.map((outcome) => mergeRecord(shot, outcome))),
				{concurrency: 1},
			),
		),
	);

/** Project the hosted asset URLs out of the records (drops the fallbacks). */
export const hostedUrls = (records: readonly CaptureRecord[]): readonly string[] =>
	records.flatMap((r) => (r.hostedUrl === null ? [] : [r.hostedUrl]));
