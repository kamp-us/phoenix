/**
 * The production {@link RenderLeg}: drive the fabrika-owned capture machinery over one surface and
 * classify what came back.
 *
 * Nothing here renders, screenshots, validates bytes or reads page errors on its own — every one of
 * those is the capture module's (`../capture/`), imported the way `build`'s verbs import `wire`.
 * What this file owns is the **classification**: turning a capture into one of the proven outcomes
 * `render`'s exit codes route on.
 *
 * **One `captureShots` call per surface**, which costs a browser launch per surface and buys the
 * thing the contract requires: per-surface outcomes. A single batched call fails the whole effect on
 * the first bad shot, so a mixed set could report at most one surface's fate and the rest would go
 * unenumerated — the "judged nothing, found nothing wrong" shape (#3925) in a different disguise.
 */
import {Effect} from "effect";
import {SESSION_PROBE_PATH} from "../capture/auth.ts";
import {captureShots} from "../capture/capture.ts";
import {FLAG_PROBE_PATH, isForcing} from "../capture/flag-override.ts";
import {isRenderCrash} from "../capture/page-errors.ts";
import {buildCapturePlan, joinPreviewUrl, parseSurfaceSpec} from "../capture/plan.ts";
import {validateCaptureBytes} from "../capture/png.ts";
import {tierOf} from "../capture/states.ts";
import {capAndCount} from "../evidence.ts";
import {PAGE_ERROR_CAP, sha256Hex} from "./manifest.ts";
import type {RenderLeg, SurfaceRender} from "./render-verb.ts";

/**
 * A navigation that served no response, or a status the machinery could not attach, is UNREACHABLE
 * rather than fine: the alternative is judging an error page's pixels as composition.
 */
const UNREACHABLE_FLOOR = 400;

/**
 * `captureShots` fails per-shot with `failed to capture <surface> at <url>` and per-run with
 * `failed to launch chromium` / `failed to close chromium`. Only the per-shot one is a fact about
 * the surface; the other two say the machinery never ran, which is UNKNOWN.
 *
 * Matched as an ALLOW-LIST on purpose: an unrecognised message falls to `Failed` (UNKNOWN), so a
 * new failure mode in the capture module degrades to "could not tell" and can never become a proven
 * accusation against the PR — a reviewer with no chromium installed must not be told a surface is
 * dark-flagged or routeless (#4493).
 */
const NAVIGATION_FAILURE_PREFIX = "failed to capture ";

/** The capture call, injectable so the classification below is testable without a browser. */
export type CaptureShots = typeof captureShots;

export const makeCaptureRenderLeg =
	(capture: CaptureShots = captureShots): RenderLeg =>
	(request) =>
		Effect.gen(function* () {
			const plan = yield* Effect.try({
				try: () =>
					buildCapturePlan(
						request.previewUrl,
						[parseSurfaceSpec(request.surface)],
						request.viewport,
					),
				catch: (cause) => String(cause),
			}).pipe(Effect.catch((reason) => Effect.succeed(reason)));
			if (typeof plan === "string") {
				return {_tag: "Failed", reason: plan} satisfies SurfaceRender;
			}

			// A seeded session is asked to prove itself, because pixels cannot: a cookie that does not
			// authenticate renders the visitor's page, and that is a valid PNG under the `:auth` name.
			const wantedTier = tierOf(plan[0]?.surface.state ?? null);
			// Same reason one layer over: an override the preview dropped renders the flag-off page,
			// and that page is a valid PNG under the flag-on name.
			const forcing = isForcing(request.forcedFlags);
			const captured = yield* capture(plan, request.outDir, {
				cookies: request.cookies,
				...(wantedTier !== null
					? {sessionProbeUrl: joinPreviewUrl(request.previewUrl, SESSION_PROBE_PATH)}
					: {}),
				...(forcing
					? {
							flagProbe: {
								url: joinPreviewUrl(request.previewUrl, FLAG_PROBE_PATH),
								flags: request.forcedFlags,
							},
						}
					: {}),
			}).pipe(Effect.catch((error) => Effect.succeed(error.message)));
			if (typeof captured === "string") {
				return captured.startsWith(NAVIGATION_FAILURE_PREFIX)
					? ({_tag: "Unreachable", reason: captured} satisfies SurfaceRender)
					: ({_tag: "Failed", reason: captured} satisfies SurfaceRender);
			}
			const shot = captured[0];
			if (shot === undefined) {
				return {
					_tag: "Failed",
					reason: "the capture machinery returned no surface",
				} as SurfaceRender;
			}
			if (shot.status !== undefined && shot.status >= UNREACHABLE_FLOOR) {
				return {_tag: "Unreachable", reason: `status ${shot.status}`} satisfies SurfaceRender;
			}
			// Classified before the bytes: an anonymous shot under a signed-in name is a valid PNG of
			// the wrong page, so validating it first would answer a question nobody asked.
			if (wantedTier !== null) {
				const proof = shot.sessionProof;
				if (proof === undefined || proof._tag !== "SignedIn") {
					return {
						_tag: "Unauthenticated",
						reason:
							proof === undefined
								? "the capture returned no session proof"
								: proof._tag === "Anonymous"
									? "the preview answered the seeded cookie as a visitor"
									: proof.reason,
					} satisfies SurfaceRender;
				}
				// Signed in is not the whole question. A surface whose audience is defined by NOT
				// clearing a floor renders perfectly for somebody above it, so the tier the preview
				// itself reports back decides whether these are the pixels the surface id named.
				if (proof.tier !== wantedTier) {
					return {
						_tag: "WrongTier",
						wanted: wantedTier,
						rendered: proof.tier,
					} satisfies SurfaceRender;
				}
			}
			if (forcing) {
				const proof = shot.overrideProof;
				if (proof === undefined || proof._tag !== "Forced") {
					return {
						_tag: "OverrideInert",
						reason:
							proof === undefined
								? "the capture returned no override proof"
								: proof._tag === "Inert"
									? `the preview evaluated ${proof.keys.join(", ")} at the default`
									: proof.reason,
					} satisfies SurfaceRender;
				}
			}
			const crash = shot.pageErrors.find(isRenderCrash);
			if (crash !== undefined) {
				return {_tag: "Crashed", firstError: crash.text} satisfies SurfaceRender;
			}
			const validity = validateCaptureBytes(shot.pngBytes);
			if (validity._tag === "Invalid") {
				return {_tag: "Invalid", detail: validity.reason} satisfies SurfaceRender;
			}
			// The width comes off the PNG header, never echoed from the request — the same readback
			// discipline the tier proof runs one layer up. A shot the browser took at another width is
			// a valid image of a layout nobody asked about.
			if (validity.width !== request.viewport.width) {
				return {
					_tag: "WrongViewport",
					wanted: request.viewport.width,
					rendered: validity.width,
				} satisfies SurfaceRender;
			}
			return {
				_tag: "Rendered",
				entry: {
					surface: request.surface,
					viewport: request.viewport.label,
					path: shot.localPath,
					width: validity.width,
					height: validity.height,
					sha256: sha256Hex(shot.pngBytes),
					// `console.error` output is recorded, never a gate outcome — and this list is only ever
					// written from a successfully-read error channel (v1's extractor returned empty on a
					// parse failure, fusing "no crashes" with "never looked"). It is collapsed at the one
					// point an entry is built, so neither output channel can hold the uncollapsed rows.
					pageErrors: capAndCount(shot.pageErrors, PAGE_ERROR_CAP),
				},
			} satisfies SurfaceRender;
		});

export const captureRenderLeg: RenderLeg = makeCaptureRenderLeg();
