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
 * unenumerated — the "judged nothing, found nothing wrong" shape in a different disguise.
 */
import {Effect} from "effect";
import {SESSION_PROBE_PATH, type VisitorCause} from "../capture/auth.ts";
import {captureShots, isWritten} from "../capture/capture.ts";
import {FLAG_PROBE_PATH, isForcing} from "../capture/flag-override.ts";
import {stepToken} from "../capture/interaction.ts";
import {isRenderCrash} from "../capture/page-errors.ts";
import {buildCapturePlan, joinPreviewUrl, parseSurfaceSpec} from "../capture/plan.ts";
import {validateCaptureBytes} from "../capture/png.ts";
import {CAPTURE_IDENTITIES, identityOf} from "../capture/states.ts";
import {capAndCount} from "../evidence.ts";
import {type CaptureEntry, PAGE_ERROR_CAP, sha256Hex} from "./manifest.ts";
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
 * dark-flagged or routeless.
 */
const NAVIGATION_FAILURE_PREFIX = "failed to capture ";

/**
 * What each visitor answer means and where its fix is. Each line states the evidence it rests on —
 * what the probe's response did to the session cookie — so a reader can check the inference.
 */
const VISITOR_CAUSE: Readonly<Record<VisitorCause, string>> = {
	BadSignature:
		"bad signature — its answer left the session cookie alone, which is how the worker answers a cookie whose signature it rejects, so the signing key this run used is not the one this preview verifies with",
	NoSessionRow:
		"missing session row — its answer expired the session cookie, which is how the worker answers a signature it accepts for a token with no live session, so this preview's database was not seeded with this token, or the seeded session has expired",
};

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
						request.scheme,
						request.interaction,
					),
				catch: (cause) => String(cause),
			}).pipe(Effect.catch((reason) => Effect.succeed(reason)));
			if (typeof plan === "string") {
				return {_tag: "Failed", reason: plan} satisfies SurfaceRender;
			}

			// A seeded session is asked to prove itself, because pixels cannot: a cookie that does not
			// authenticate renders the visitor's page, and that is a valid PNG under the `:auth` name.
			const wantedIdentity = identityOf(plan[0]?.surface.state ?? null);
			const wanted = wantedIdentity === null ? null : CAPTURE_IDENTITIES[wantedIdentity];
			// Same reason one layer over: an override the preview dropped renders the flag-off page,
			// and that page is a valid PNG under the flag-on name.
			const forcing = isForcing(request.forcedFlags);
			const captured = yield* capture(plan, request.outDir, {
				cookies: request.cookies,
				...(wanted !== null
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
				...(request.locale === null ? {} : {locale: request.locale}),
				...(request.accent === null ? {} : {accent: request.accent}),
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
			if (wanted !== null) {
				const proof = shot.sessionProof;
				if (proof === undefined || proof._tag !== "SignedIn") {
					return {
						_tag: "Unauthenticated",
						reason:
							proof === undefined
								? "the capture returned no session proof"
								: proof._tag === "Anonymous"
									? `the preview answered the seeded cookie as a visitor: ${VISITOR_CAUSE[proof.cause]}`
									: proof.reason,
					} satisfies SurfaceRender;
				}
				// Signed in is not the whole question. A surface whose audience is defined by NOT
				// clearing a floor renders perfectly for somebody above it, so the tier the preview
				// itself reports back decides whether these are the pixels the surface id named.
				if (proof.tier !== wanted.tier) {
					return {
						_tag: "WrongTier",
						wanted: wanted.tier,
						rendered: proof.tier,
					} satisfies SurfaceRender;
				}
				// The same floor on the other axis: a verified çaylak renders the write an unverified
				// one is refused, so the pixels are the wrong audience's either way round.
				if (proof.emailVerified !== wanted.emailVerified) {
					return {
						_tag: "WrongVerification",
						wanted: wanted.emailVerified,
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
			// After the crash check, unlike the two proofs above: this one is read off the page itself,
			// and a page that threw before setting its `lang` is a red render, not an unseeded one. A
			// seed the app never read renders the default locale, a valid PNG under the seeded name.
			if (request.locale !== null) {
				const proof = shot.localeProof;
				if (proof === undefined || proof._tag !== "Seeded") {
					return {
						_tag: "WrongLocale",
						wanted: request.locale.value,
						reason:
							proof === undefined
								? "the capture returned no locale proof"
								: proof._tag === "Mismatch"
									? `the page's lang read back "${proof.rendered}"`
									: proof.reason,
					} satisfies SurfaceRender;
				}
			}
			// Read off the page like the locale, and for the same reason after the crash check. The
			// emulated preference is only the request: an app holding a stored choice paints its own
			// scheme, a valid PNG under the requested name.
			let scheme: CaptureEntry["scheme"];
			if (request.scheme !== null) {
				const proof = shot.schemeProof;
				if (proof === undefined || proof._tag !== "Proven") {
					return {
						_tag: "WrongScheme",
						wanted: request.scheme.scheme,
						reason:
							proof === undefined
								? "the capture returned no scheme proof"
								: proof._tag === "Mismatch"
									? `the page's ${request.scheme.rootAttribute} read back "${proof.rendered}"`
									: proof.reason,
					} satisfies SurfaceRender;
				}
				scheme = {requested: request.scheme.scheme, proven: proof.scheme};
			}
			// Read off the page like the scheme, and for the same reason after the crash check. Setting the
			// attribute is only the request: an app that re-asserts its own accent paints that one, a valid
			// PNG under the requested name.
			let accent: CaptureEntry["accent"];
			if (request.accent !== null) {
				const proof = shot.accentProof;
				if (proof === undefined || proof._tag !== "Proven") {
					return {
						_tag: "WrongAccent",
						wanted: request.accent.value,
						reason:
							proof === undefined
								? "the capture returned no accent proof"
								: proof._tag === "Mismatch"
									? `the page's ${request.accent.rootAttribute} read back "${proof.rendered}"`
									: proof.reason,
					} satisfies SurfaceRender;
				}
				accent = {requested: request.accent.value, proven: proof.accent};
			}
			// Last of the page proofs and after the crash check, for the scheme's reason: a page that threw
			// is a red render, and the steps ran on the page the other page proofs answered about.
			// A refused interaction wrote no file, so there are no bytes past this point to judge.
			if (!isWritten(shot)) {
				return {
					_tag: "Uninteracted",
					reason: `${shot.interactionProof.step}: ${shot.interactionProof.reason}`,
				} satisfies SurfaceRender;
			}
			let interaction: CaptureEntry["interaction"];
			if (request.interaction !== null) {
				const proof = shot.interactionProof;
				if (proof === undefined) {
					return {
						_tag: "Uninteracted",
						reason: "the capture returned no interaction proof",
					} satisfies SurfaceRender;
				}
				const [first, ...rest] = request.interaction.steps;
				interaction = {
					label: request.interaction.label,
					steps: [stepToken(first), ...rest.map(stepToken)],
					proven: proof.proven,
				};
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
					...(scheme === undefined ? {} : {scheme}),
					...(accent === undefined ? {} : {accent}),
					...(interaction === undefined ? {} : {interaction}),
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
