/**
 * `@kampus/fabrika-cli/capture` — the screenshot/render/golden-diff machinery the
 * design gates drive (ADR 0165, epic #1966). It lives here, on fabrika's release
 * train, so an adopter repo gets it with fabrika instead of depending on a
 * phoenix-published package (founder ruling on #5061, issue #5063).
 *
 * The same ruling keeps the repo-specific DATA per-repo, and that boundary is what
 * decides where a module lives. Anything naming a *host* or a *credential* — the depo
 * store/fetch of golden bytes, the pointer file, the harness config — is the consuming
 * repo's and is NOT here; phoenix keeps its half in `packages/design-capture/` (ADR 0183).
 * That is not only a taste call: this package is published, so a dependency on a private
 * `@kampus/*` package could not resolve from a clean registry (ADR 0201 §3, enforced by
 * `publish-isolation-guard`). Storing bytes is therefore an injected `StoreLeg` here — the
 * shape, never the store.
 *
 * The seam #2246 codes against: `captureAndUpload(request)` →
 * `Effect<CaptureRecord[], CaptureError, HttpClient>`, each record
 * `{surface, route, state, localPath, hostedUrl, uploadError}` (the `capture`
 * bin emits this per-surface JSON). `hostedUrls` projects the hosted URLs;
 * `resolvePreviewUrl` resolves the preview base from the sticky preview-deploy
 * comment, keyed off the per-app `<!-- preview-deploy:<app> -->` anchor.
 */

// The blessing surface (ADR 0183 §5, epic #2955 stories 2/9, issue #2962): render the
// founder gallery comment from a candidate set, parse the founder's verdicts, and fold
// approve/redline into a golden-pointer move — the human-in-the-loop bless → commit path
// (no re-render: the blessed sha comes from the set the founder saw).
export type {
	ApplyBlessingInput,
	BlessDecision,
	BlessedSurface,
	BlessingResult,
	BlessVerdict,
} from "./blessing-surface.ts";
export {applyBlessing, parseBlessDecisions, renderBlessingGallery} from "./blessing-surface.ts";
// The candidate-render step (ADR 0183 §5, epic #2955 story 1): render the founder
// priority surfaces over a flag-forced preview into a blessing candidate set, staged
// for the founder's bless (#2962) — each candidate anchored to the exact depo sha256
// a later bless commits (the no-re-render guard).
export type {
	CaptureLeg as CandidateCaptureLeg,
	RenderCandidateSetDeps,
	RenderCandidateSetRequest,
	StoredGolden,
	StoreLeg,
} from "./candidate-render.ts";
export {renderCandidateSet} from "./candidate-render.ts";
export type {
	AssembleCandidateSetInput,
	CandidateScreen,
	CandidateSet,
	RenderedCandidate,
} from "./candidate-set.ts";
export {assembleCandidateSet, parseCandidateSet, serializeCandidateSet} from "./candidate-set.ts";
export type {CaptureCookie, CapturedSurface, CaptureOptions} from "./capture.ts";
export {CaptureError, captureShots} from "./capture.ts";
// The golden-baseline seam (ADR 0183): the current-golden pointer in git, the bytes in
// the consuming repo's asset store; pointer → deterministic diff. Consumed by write-code
// (self-check) and review-design (blocking gate) so there is ONE notion of "golden". The
// store/fetch half is NOT here — see the module docblock.
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
export type {CaptureValidity, PngHeader} from "./png.ts";
export {decodePngHeader, validateCaptureBytes} from "./png.ts";
export type {
	PrioritySurfaceKey,
	PrioritySurfaceParams,
	PrioritySurfaceSpec,
	ResolvedPrioritySurface,
} from "./priority-surfaces.ts";
export {
	PRIORITY_SURFACES,
	resolvePrioritySurfaces,
	substituteRouteParams,
} from "./priority-surfaces.ts";
export type {AnnouncementRead, PreviewAnnouncement} from "./resolve.ts";
export {
	announcedApps,
	isPreviewAnnouncement,
	readPreviewAnnouncement,
	resolvePreviewUrl,
} from "./resolve.ts";
export type {
	RawUploadResponse,
	UploadAssetOptions,
	UploadEndpointParams,
	UploadOutcome,
} from "./upload.ts";
export {PNG_CONTENT_TYPE, parseUploadResponse, uploadAsset, uploadEndpoint} from "./upload.ts";
