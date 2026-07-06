/**
 * The seam #2246 (the review-design skill) codes against: capture a UI PR's
 * changed surfaces over its preview deploy and host each as a GitHub attachment,
 * returning per-shot evidence.
 *
 *   captureAndUpload(request) : Effect<ShotEvidence[], CaptureError, HttpClient>
 *
 * Each `ShotEvidence` is `hosted` (a GitHub asset URL to embed) or `unhosted` (a
 * marked fallback carrying a diagnostic — never a silent drop). `hostedUrls`
 * projects the `(previewUrl, surfaces[]) → hostedScreenshotUrl[]` shape when only
 * the embeddable URLs are wanted; the full `ShotEvidence[]` preserves the
 * fallback so the caller can surface a no-hosted-evidence note.
 */
import {Effect} from "effect";
import type {HttpClient} from "effect/unstable/http/HttpClient";
import {CaptureError, type CaptureOptions, captureShots} from "./capture.ts";
import {buildCapturePlan, type Surface, type Viewport} from "./plan.ts";
import {type ShotEvidence, uploadAsset} from "./upload.ts";

export interface CaptureAndUploadRequest {
	/** The per-PR preview base URL (from the `preview-deploy` bot comment). */
	readonly previewUrl: string;
	/** The changed UI surfaces to shoot — each a stable label + a preview route. */
	readonly surfaces: readonly Surface[];
	/** The target repo's numeric id (`gh api repos/OWNER/REPO --jq .id`). */
	readonly repositoryId: number;
	/** A GitHub token with write access to the target repo. */
	readonly token: string;
	/** Deterministic viewports to shoot each surface at (default desktop + mobile). */
	readonly viewports?: readonly Viewport[];
	/** Passed through to the Playwright capture (timeout, full-page). */
	readonly captureOptions?: CaptureOptions;
}

/**
 * Capture then upload: build the plan, shoot every entry over the preview, and
 * upload each PNG to GitHub user-attachments. Returns one `ShotEvidence` per
 * shot, in plan order. The upload leg never fails the effect (its channel is
 * `never`) — a broken endpoint yields `unhosted` entries, so only a genuine
 * capture failure (`CaptureError`) short-circuits.
 */
export const captureAndUpload = (
	request: CaptureAndUploadRequest,
): Effect.Effect<readonly ShotEvidence[], CaptureError, HttpClient> =>
	Effect.try({
		try: () => buildCapturePlan(request.previewUrl, request.surfaces, request.viewports),
		catch: (cause) => new CaptureError({message: "failed to build capture plan", cause}),
	}).pipe(
		Effect.flatMap((plan) => captureShots(plan, request.captureOptions ?? {})),
		Effect.flatMap((captured) =>
			Effect.forEach(
				captured,
				(shot) =>
					uploadAsset({
						label: shot.label,
						pngBytes: shot.pngBytes,
						repositoryId: request.repositoryId,
						token: request.token,
						fileName: `${shot.label}.png`,
					}),
				{concurrency: 1},
			),
		),
	);

/** Project the hosted asset URLs out of an evidence list (drops `unhosted`). */
export const hostedUrls = (evidence: readonly ShotEvidence[]): readonly string[] =>
	evidence.flatMap((e) => (e._tag === "hosted" ? [e.hostedUrl] : []));
