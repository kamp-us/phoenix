/**
 * @kampus/design-capture — the Playwright-capture + GitHub user-attachments
 * upload helper the review-design gate drives (ADR 0165, epic #1966).
 *
 * The seam #2246 codes against: `captureAndUpload(request)` →
 * `Effect<CaptureRecord[], CaptureError, HttpClient>`, each record
 * `{surface, route, state, localPath, hostedUrl, uploadError}` (the `capture`
 * bin emits this per-surface JSON). `hostedUrls` projects the hosted URLs;
 * `resolvePreviewUrl` resolves the preview base from the sticky preview-deploy
 * comment, keyed off the per-app `<!-- preview-deploy:<app> -->` anchor.
 */
export type {CaptureCookie, CapturedSurface, CaptureOptions} from "./capture.ts";
export {CaptureError, captureShots} from "./capture.ts";
export type {CaptureAndUploadRequest, CaptureRecord} from "./orchestrate.ts";
export {captureAndUpload, hostedUrls, mergeRecord} from "./orchestrate.ts";
export type {PageError, SurfacePageErrors} from "./page-errors.ts";
export {isRenderCrash, renderCrashFailure, toPageError} from "./page-errors.ts";
export type {CaptureClip, Shot, Surface, Viewport} from "./plan.ts";
export {
	buildCapturePlan,
	DEFAULT_VIEWPORT,
	DESKTOP_VIEWPORT,
	joinPreviewUrl,
	MOBILE_VIEWPORT,
	parseSurfaceSpec,
	surfaceFileName,
} from "./plan.ts";
export {resolvePreviewUrl} from "./resolve.ts";
export type {RawUploadResponse, UploadAssetOptions, UploadOutcome} from "./upload.ts";
export {parseUploadResponse, uploadAsset, uploadEndpoint} from "./upload.ts";
