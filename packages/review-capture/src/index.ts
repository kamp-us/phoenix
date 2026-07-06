/**
 * @kampus/review-capture — the Playwright-capture + GitHub user-attachments
 * upload helper the review-design gate drives (ADR 0165, epic #1966).
 *
 * The seam #2246 codes against: `captureAndUpload(request)` →
 * `Effect<ShotEvidence[], CaptureError, HttpClient>`, plus `hostedUrls` for the
 * `(previewUrl, surfaces[]) → hostedScreenshotUrl[]` projection.
 */
export type {CapturedShot, CaptureOptions} from "./capture.ts";
export {CaptureError, captureShots} from "./capture.ts";
export type {CaptureAndUploadRequest} from "./orchestrate.ts";
export {captureAndUpload, hostedUrls} from "./orchestrate.ts";
export type {Shot, Surface, Viewport} from "./plan.ts";
export {
	buildCapturePlan,
	DEFAULT_VIEWPORTS,
	DESKTOP_VIEWPORT,
	joinPreviewUrl,
	MOBILE_VIEWPORT,
} from "./plan.ts";
export type {RawUploadResponse, ShotEvidence, UploadAssetOptions} from "./upload.ts";
export {parseUploadResponse, uploadAsset, uploadEndpoint} from "./upload.ts";
