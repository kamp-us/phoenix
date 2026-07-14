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
// The golden-baseline seam (ADR 0183): bytes in depo, the current-golden pointer in
// git; store → resolve → deterministic diff. Consumed by write-code (self-check) and
// review-design (blocking gate) so there is ONE notion of "golden".
export type {DiffOptions, DiffRegion, DiffResult, RasterImage, Rect} from "./golden-diff.ts";
export {diffRasters} from "./golden-diff.ts";
export {loadGoldenPointer, serializeGoldenPointer} from "./golden-fs.ts";
export type {BlessInput, GoldenEntry, GoldenPointer} from "./golden-pointer.ts";
export {
	blessedSurfaces,
	blessSurface,
	isSha256Hex,
	resolveGoldenEntry,
} from "./golden-pointer.ts";
export type {StoredGolden} from "./golden-store.ts";
export {
	fetchGoldenBytes,
	GoldenFetchError,
	resolveGoldenBytes,
	resolveGoldenUrl,
	storeGolden,
} from "./golden-store.ts";
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
