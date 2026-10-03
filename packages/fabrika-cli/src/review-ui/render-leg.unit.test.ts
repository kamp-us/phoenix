import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type CapturedSurface, CaptureError, type UnwrittenSurface} from "../capture/capture.ts";
import {NO_FORCED_FLAGS} from "../capture/flag-override.ts";
import {DESKTOP_VIEWPORT, MOBILE_VIEWPORT} from "../capture/plan.ts";
import {PAGE_ERROR_CAP} from "./manifest.ts";
import {type CaptureShots, makeCaptureRenderLeg} from "./render-leg.ts";
import type {SurfaceRender} from "./render-verb.ts";

const PREVIEW = "https://pr-4321-web.example.test";

const request = {
	surface: "/pano",
	viewport: DESKTOP_VIEWPORT,
	previewUrl: PREVIEW,
	outDir: "/tmp/shots",
	cookies: [],
	forcedFlags: NO_FORCED_FLAGS,
	locale: null,
	scheme: null,
	accent: null,
	interaction: null,
};

const failing =
	(message: string): CaptureShots =>
	() =>
		Effect.fail(new CaptureError({message}));

/**
 * A 24-byte PNG header declaring the given size — enough for `validateCaptureBytes`, no codec
 * needed. The width defaults to the desktop viewport's, because the leg now reads the width back
 * off these very bytes and refuses a shot that is not the width it asked for.
 */
const pngHeader = (width = DESKTOP_VIEWPORT.width, height = 2140): Uint8Array => {
	const bytes = new Uint8Array(24);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	bytes.set([0x49, 0x48, 0x44, 0x52], 12);
	new DataView(bytes.buffer).setUint32(16, width);
	new DataView(bytes.buffer).setUint32(20, height);
	return bytes;
};

const succeeding =
	(shot: Partial<CapturedSurface>): CaptureShots =>
	() =>
		Effect.succeed([
			{
				surface: "/pano",
				route: "/pano",
				state: null,
				localPath: "/tmp/shots/pano.png",
				fileName: "pano.png",
				pngBytes: pngHeader(),
				pageErrors: [],
				...shot,
			},
		]);

const run = (capture: CaptureShots): SurfaceRender =>
	Effect.runSync(makeCaptureRenderLeg(capture)(request));

const authRequest = {...request, surface: "/pano:auth", cookies: []};

/** A shot for the `:auth` request, so its `state` matches what the leg planned. */
const authShot =
	(shot: Partial<CapturedSurface>): CaptureShots =>
	() =>
		Effect.succeed([
			{
				surface: "/pano:auth",
				route: "/pano",
				state: "auth",
				localPath: "/tmp/shots/pano-auth.png",
				fileName: "pano-auth.png",
				pngBytes: pngHeader(),
				pageErrors: [],
				status: 200,
				...shot,
			},
		]);

const runAuth = (capture: CaptureShots): SurfaceRender =>
	Effect.runSync(makeCaptureRenderLeg(capture)(authRequest));

describe("captureRenderLeg", () => {
	// The wiring, not the seam: render-verb's own test INJECTS a `Failed` value, so it passes even
	// when the only code that could produce one never does. These drive the real classification with
	// the three messages `captureShots` actually fails with.
	it("keeps a broken browser provision UNKNOWN (Failed), never a proven claim about the surface", () => {
		expect(run(failing("failed to launch chromium"))._tag).toBe("Failed");
		expect(run(failing("failed to close chromium"))._tag).toBe("Failed");
	});

	it("reads a per-shot navigation failure as the proven Unreachable arm", () => {
		expect(run(failing(`failed to capture /pano at ${PREVIEW}/pano`))).toEqual({
			_tag: "Unreachable",
			reason: `failed to capture /pano at ${PREVIEW}/pano`,
		});
	});

	it("falls to UNKNOWN on an unrecognised capture failure", () => {
		expect(run(failing("some future failure mode"))._tag).toBe("Failed");
	});

	it("still routes a 4xx navigation to Unreachable", () => {
		expect(run(succeeding({status: 404}))._tag).toBe("Unreachable");
	});

	it("reports a decodable capture as Rendered", () => {
		expect(run(succeeding({status: 200}))._tag).toBe("Rendered");
	});

	it("collapses a capture's page errors to the cap plus a count of the rest", () => {
		const noisy = Array.from({length: PAGE_ERROR_CAP + 4}, (_, i) => ({
			kind: "console.error" as const,
			text: `Warning: ${i}`,
		}));
		const render = run(succeeding({status: 200, pageErrors: noisy}));
		expect(render).toMatchObject({
			_tag: "Rendered",
			entry: {pageErrors: {rows: noisy.slice(0, PAGE_ERROR_CAP), more: 4}},
		});
	});

	it("keeps a short list whole and still counts zero, so capped-at-length reads as whole", () => {
		const one = [{kind: "console.error" as const, text: "Warning: missing key prop"}];
		expect(run(succeeding({status: 200, pageErrors: one}))).toMatchObject({
			_tag: "Rendered",
			entry: {pageErrors: {rows: one, more: 0}},
		});
	});
});

/**
 * The width half of the same readback discipline: the requested viewport is what the plan
 * asked for, the recorded width is what the bytes say, and a shot that answers the narrow question
 * from desktop pixels is a valid PNG no byte check downstream can tell from the real thing.
 */
describe("captureRenderLeg — the shot's own width", () => {
	const mobileRequest = {...request, viewport: MOBILE_VIEWPORT};
	const runMobile = (capture: CaptureShots): SurfaceRender =>
		Effect.runSync(makeCaptureRenderLeg(capture)(mobileRequest));

	it("plans the shot at the viewport it was handed, never a hardcoded default", () => {
		const planned: number[] = [];
		const spy: CaptureShots = (plan, _outDir, _options) => {
			planned.push(plan[0]?.viewport.width ?? 0);
			return succeeding({status: 200, pngBytes: pngHeader(MOBILE_VIEWPORT.width)})([], "", {});
		};
		runMobile(spy);
		expect(planned).toEqual([MOBILE_VIEWPORT.width]);
	});

	it("records the shot when its bytes read back at the requested width", () => {
		const render = runMobile(succeeding({status: 200, pngBytes: pngHeader(MOBILE_VIEWPORT.width)}));
		expect(render).toMatchObject({_tag: "Rendered", entry: {viewport: "mobile", width: 390}});
	});

	it("refuses a desktop-width shot filed under mobile, naming both widths", () => {
		expect(runMobile(succeeding({status: 200, pngBytes: pngHeader(1280)}))).toEqual({
			_tag: "WrongViewport",
			wanted: 390,
			rendered: 1280,
		});
	});

	// Undecodable comes first: "invalid bytes" is the truer answer than "the wrong width", and a
	// width read off bytes that failed validation would be a number nobody proved.
	it("keeps an invalid capture on the Invalid arm rather than the width one", () => {
		expect(run(succeeding({status: 200, pngBytes: new Uint8Array(0)}))._tag).toBe("Invalid");
	});
});

/**
 * The bytes cannot answer this: an anonymous render of `/pano` is a valid PNG whichever name it is
 * filed under, so every arm below decodes fine and the classification is the only thing separating a
 * signed-in capture from the visitor's.
 */
describe("captureRenderLeg — the :auth session proof", () => {
	it("asks for the proof on an :auth surface and for nothing on a bare route", () => {
		const asked: Array<string | undefined> = [];
		const spy: CaptureShots = (_plan, _outDir, options) => {
			asked.push(options?.sessionProbeUrl);
			return authShot({
				sessionProof: {_tag: "SignedIn", userId: "u1", tier: "yazar", emailVerified: true},
			})([], "", {});
		};
		runAuth(spy);
		run(spy);
		expect(asked[0]).toBe(`${PREVIEW}/api/auth/get-session`);
		expect(asked[1]).toBeUndefined();
	});

	it("records the shot only when the proof came back signed in", () => {
		expect(
			runAuth(
				authShot({
					sessionProof: {_tag: "SignedIn", userId: "u1", tier: "yazar", emailVerified: true},
				}),
			)._tag,
		).toBe("Rendered");
	});

	/**
	 * The two visitor answers send a reader to two different places — the signing key, or the
	 * preview's database — so the refusal says which one the probe's own answer named.
	 */
	it("refuses a visitor's render under the :auth name, saying which visitor answer it was", () => {
		const reasonOf = (cause: "BadSignature" | "NoSessionRow"): string => {
			const render = runAuth(authShot({sessionProof: {_tag: "Anonymous", cause}}));
			return render._tag === "Unauthenticated" ? render.reason : `not refused: ${render._tag}`;
		};
		const visitor = "the preview answered the seeded cookie as a visitor: ";
		expect(reasonOf("BadSignature")).toContain(`${visitor}bad signature`);
		expect(reasonOf("BadSignature")).toContain("signing key");
		expect(reasonOf("NoSessionRow")).toContain(`${visitor}missing session row`);
		expect(reasonOf("NoSessionRow")).toContain("was not seeded with this token");
	});

	it("refuses an unreadable probe too — a proof nobody could read is not a proof", () => {
		expect(
			runAuth(authShot({sessionProof: {_tag: "Unreadable", reason: "probe answered 502"}})),
		).toEqual({_tag: "Unauthenticated", reason: "probe answered 502"});
		expect(runAuth(authShot({}))._tag).toBe("Unauthenticated");
	});
});

/**
 * The tier half of the same proof. Every arm here IS signed in and decodes fine — the whole
 * defect is that a yazar's render of a çaylak-only surface is a clean, valid capture of the audience
 * the feature is designed never to show.
 */
describe("captureRenderLeg — the rendered actor's tier", () => {
	const caylakRequest = {...request, surface: "/hosgeldin:auth-caylak"};
	const caylakShot =
		(tier: string): CaptureShots =>
		() =>
			Effect.succeed([
				{
					surface: "/hosgeldin:auth-caylak",
					route: "/hosgeldin",
					state: "auth-caylak",
					localPath: "/tmp/shots/hosgeldin-auth-caylak.png",
					fileName: "hosgeldin-auth-caylak.png",
					pngBytes: pngHeader(),
					pageErrors: [],
					status: 200,
					sessionProof: {_tag: "SignedIn" as const, userId: "u1", tier, emailVerified: true},
				},
			]);
	const runCaylak = (capture: CaptureShots): SurfaceRender =>
		Effect.runSync(makeCaptureRenderLeg(capture)(caylakRequest));

	it("records the shot when the preview reports the tier the surface named", () => {
		expect(runCaylak(caylakShot("çaylak"))._tag).toBe("Rendered");
	});

	it("refuses a yazar's render under the çaylak name — a clean capture of the wrong audience", () => {
		expect(runCaylak(caylakShot("yazar"))).toEqual({
			_tag: "WrongTier",
			wanted: "çaylak",
			rendered: "yazar",
		});
	});

	it("refuses a çaylak's render under the yazar-tier :auth name too — the fence runs both ways", () => {
		expect(
			runAuth(
				authShot({
					sessionProof: {_tag: "SignedIn", userId: "u1", tier: "çaylak", emailVerified: true},
				}),
			),
		).toEqual({_tag: "WrongTier", wanted: "yazar", rendered: "çaylak"});
	});
});

/**
 * The email-verification half of the proof. The unverified çaylak shares its tier with the
 * verified one, so the tier arm alone passes a verified çaylak's clean render under the unverified
 * name — the shot of the write the surface exists to show being refused.
 */
describe("captureRenderLeg — the rendered actor's email verification", () => {
	const unverifiedRequest = {...request, surface: "/hosgeldin:auth-caylak-unverified"};
	const unverifiedShot =
		(tier: string, emailVerified: boolean): CaptureShots =>
		() =>
			Effect.succeed([
				{
					surface: "/hosgeldin:auth-caylak-unverified",
					route: "/hosgeldin",
					state: "auth-caylak-unverified",
					localPath: "/tmp/shots/hosgeldin-auth-caylak-unverified.png",
					fileName: "hosgeldin-auth-caylak-unverified.png",
					pngBytes: pngHeader(),
					pageErrors: [],
					status: 200,
					sessionProof: {_tag: "SignedIn" as const, userId: "u1", tier, emailVerified},
				},
			]);
	const runUnverified = (capture: CaptureShots): SurfaceRender =>
		Effect.runSync(makeCaptureRenderLeg(capture)(unverifiedRequest));

	it("records the shot when the preview reports an email-unverified çaylak", () => {
		expect(runUnverified(unverifiedShot("çaylak", false))._tag).toBe("Rendered");
	});

	it("refuses a verified çaylak's render under the unverified name", () => {
		expect(runUnverified(unverifiedShot("çaylak", true))).toEqual({
			_tag: "WrongVerification",
			wanted: false,
		});
	});

	it("refuses an unverified yazar's render on the tier arm first", () => {
		expect(runUnverified(unverifiedShot("yazar", false))).toEqual({
			_tag: "WrongTier",
			wanted: "çaylak",
			rendered: "yazar",
		});
	});

	it("refuses an unverified çaylak's render under the verified :auth-caylak name too", () => {
		const caylak = {...request, surface: "/hosgeldin:auth-caylak"};
		const shot: CaptureShots = () =>
			Effect.succeed([
				{
					surface: "/hosgeldin:auth-caylak",
					route: "/hosgeldin",
					state: "auth-caylak",
					localPath: "/tmp/shots/hosgeldin-auth-caylak.png",
					fileName: "hosgeldin-auth-caylak.png",
					pngBytes: pngHeader(),
					pageErrors: [],
					status: 200,
					sessionProof: {
						_tag: "SignedIn" as const,
						userId: "u1",
						tier: "çaylak",
						emailVerified: false,
					},
				},
			]);
		expect(Effect.runSync(makeCaptureRenderLeg(shot)(caylak))).toEqual({
			_tag: "WrongVerification",
			wanted: true,
		});
	});
});

/**
 * One layer over the session proof and for the same reason: a preview that dropped the override
 * cookie renders the flag-off page, and that page is a valid PNG under the flag-on name.
 */
describe("captureRenderLeg — the forced-flag proof", () => {
	const FORCED = {"welcome-banner": true};
	const forcedRequest = {...authRequest, forcedFlags: FORCED};
	const runForced = (capture: CaptureShots): SurfaceRender =>
		Effect.runSync(makeCaptureRenderLeg(capture)(forcedRequest));
	const signedIn = {_tag: "SignedIn", userId: "u1", tier: "yazar", emailVerified: true} as const;

	it("asks the preview's own evaluation seam, and asks nothing when no flag is forced", () => {
		const asked: Array<unknown> = [];
		const spy: CaptureShots = (_plan, _outDir, options) => {
			asked.push(options?.flagProbe);
			return authShot({sessionProof: signedIn, overrideProof: {_tag: "Forced"}})([], "", {});
		};
		runForced(spy);
		runAuth(spy);
		expect(asked[0]).toEqual({url: `${PREVIEW}/api/flags/evaluate`, flags: FORCED});
		expect(asked[1]).toBeUndefined();
	});

	it("records the shot only when every forced key came back forced", () => {
		expect(
			runForced(authShot({sessionProof: signedIn, overrideProof: {_tag: "Forced"}}))._tag,
		).toBe("Rendered");
	});

	it("refuses a default-state render under the forced name, naming the inert keys", () => {
		expect(
			runForced(
				authShot({
					sessionProof: signedIn,
					overrideProof: {_tag: "Inert", keys: ["welcome-banner"]},
				}),
			),
		).toEqual({
			_tag: "OverrideInert",
			reason: "the preview evaluated welcome-banner at the default",
		});
	});

	it("refuses an unreadable probe and an absent one — neither is a proof", () => {
		expect(
			runForced(
				authShot({
					sessionProof: signedIn,
					overrideProof: {_tag: "Unreadable", reason: "probe answered 502"},
				}),
			),
		).toEqual({_tag: "OverrideInert", reason: "probe answered 502"});
		expect(runForced(authShot({sessionProof: signedIn}))._tag).toBe("OverrideInert");
	});

	it("keeps the session refusal ahead of the override one — a visitor's page proves no flag", () => {
		expect(
			runForced(
				authShot({
					sessionProof: {_tag: "Anonymous", cause: "NoSessionRow"},
					overrideProof: {_tag: "Forced"},
				}),
			)._tag,
		).toBe("Unauthenticated");
	});
});

/**
 * The same class one axis over: a seed the app never read paints the default-locale page, a valid
 * PNG under the requested locale's name.
 */
describe("captureRenderLeg — the locale proof", () => {
	const SEED = {storageKey: "app.locale", value: "en"};
	const localeRequest = {...request, locale: SEED};
	const runLocale = (capture: CaptureShots): SurfaceRender =>
		Effect.runSync(makeCaptureRenderLeg(capture)(localeRequest));

	it("hands the seed to the capture, and seeds nothing when no locale was asked for", () => {
		const asked: Array<unknown> = [];
		const spy: CaptureShots = (_plan, _outDir, options) => {
			asked.push(options?.locale);
			return succeeding({localeProof: {_tag: "Seeded"}})([], "", {});
		};
		runLocale(spy);
		run(spy);
		expect(asked).toEqual([SEED, undefined]);
	});

	it("records the shot only when the page's lang named the seeded value", () => {
		expect(runLocale(succeeding({localeProof: {_tag: "Seeded"}}))._tag).toBe("Rendered");
	});

	it("refuses a default-locale render under the seeded name, naming the lang it read", () => {
		expect(runLocale(succeeding({localeProof: {_tag: "Mismatch", rendered: "tr"}}))).toEqual({
			_tag: "WrongLocale",
			wanted: "en",
			reason: `the page's lang read back "tr"`,
		});
	});

	it("refuses an unreadable lang and an absent proof — neither is a proof", () => {
		expect(
			runLocale(succeeding({localeProof: {_tag: "Unreadable", reason: "lang read failed: x"}})),
		).toEqual({_tag: "WrongLocale", wanted: "en", reason: "lang read failed: x"});
		expect(runLocale(succeeding({}))).toEqual({
			_tag: "WrongLocale",
			wanted: "en",
			reason: "the capture returned no locale proof",
		});
	});

	it("keeps a crash ahead of the locale proof — a page that threw set no lang", () => {
		expect(
			runLocale(
				succeeding({
					localeProof: {_tag: "Mismatch", rendered: "tr"},
					pageErrors: [{kind: "pageerror", text: "TypeError: x is null"}],
				}),
			)._tag,
		).toBe("Crashed");
	});
});

/**
 * One axis further: an emulated preference the app overrode paints the other scheme, a valid PNG
 * under the requested scheme's name.
 */
describe("captureRenderLeg — the scheme proof", () => {
	const DARK = {scheme: "dark", rootAttribute: "data-theme"} as const;
	const schemeRequest = {...request, scheme: DARK};
	const runScheme = (capture: CaptureShots): SurfaceRender =>
		Effect.runSync(makeCaptureRenderLeg(capture)(schemeRequest));

	it("plans the shot in the requested scheme, and plans no scheme when none was asked for", () => {
		const planned: Array<{readonly scheme: unknown; readonly fileName: string}> = [];
		const spy: CaptureShots = (plan) => {
			planned.push(...plan.map((shot) => ({scheme: shot.scheme, fileName: shot.fileName})));
			return succeeding({schemeProof: {_tag: "Proven", scheme: "dark"}})([], "", {});
		};
		runScheme(spy);
		run(spy);
		expect(planned).toEqual([
			{scheme: DARK, fileName: "pano@desktop-dark.png"},
			{scheme: undefined, fileName: "pano@desktop.png"},
		]);
	});

	it("records the requested and the proven scheme on the entry, and neither without a request", () => {
		const proven = runScheme(succeeding({schemeProof: {_tag: "Proven", scheme: "dark"}}));
		expect(proven._tag === "Rendered" && proven.entry.scheme).toEqual({
			requested: "dark",
			proven: "dark",
		});
		const plain = run(succeeding({}));
		expect(plain._tag === "Rendered" && "scheme" in plain.entry).toBe(false);
	});

	it("refuses the other scheme under the requested name, naming what the page published", () => {
		expect(runScheme(succeeding({schemeProof: {_tag: "Mismatch", rendered: "light"}}))).toEqual({
			_tag: "WrongScheme",
			wanted: "dark",
			reason: `the page's data-theme read back "light"`,
		});
	});

	it("refuses an unreadable attribute and an absent proof — neither is a proof", () => {
		const unreadable = "the page's root carries no data-theme attribute";
		expect(runScheme(succeeding({schemeProof: {_tag: "Unreadable", reason: unreadable}}))).toEqual({
			_tag: "WrongScheme",
			wanted: "dark",
			reason: unreadable,
		});
		expect(runScheme(succeeding({}))).toEqual({
			_tag: "WrongScheme",
			wanted: "dark",
			reason: "the capture returned no scheme proof",
		});
	});

	it("keeps a crash ahead of the scheme proof — a page that threw published no scheme", () => {
		expect(
			runScheme(
				succeeding({
					schemeProof: {_tag: "Mismatch", rendered: "light"},
					pageErrors: [{kind: "pageerror", text: "TypeError: x is null"}],
				}),
			)._tag,
		).toBe("Crashed");
	});
});

/**
 * One axis further again: an app that re-asserts its own accent paints that one, a valid PNG under
 * the requested accent's name.
 */
describe("captureRenderLeg — the accent proof", () => {
	const AMBER = {rootAttribute: "data-color-theme", value: "amber"};
	const accentRequest = {...request, accent: AMBER};
	const runAccent = (capture: CaptureShots): SurfaceRender =>
		Effect.runSync(makeCaptureRenderLeg(capture)(accentRequest));

	it("hands the accent to the capture and keeps the file name, and sets nothing when none was asked for", () => {
		const asked: Array<{readonly accent: unknown; readonly fileName: string | undefined}> = [];
		const spy: CaptureShots = (plan, _outDir, options) => {
			asked.push({accent: options?.accent, fileName: plan[0]?.fileName});
			return succeeding({accentProof: {_tag: "Proven", accent: "amber"}})([], "", {});
		};
		runAccent(spy);
		run(spy);
		expect(asked).toEqual([
			{accent: AMBER, fileName: "pano@desktop.png"},
			{accent: undefined, fileName: "pano@desktop.png"},
		]);
	});

	it("records the requested and the proven accent on the entry, and neither without a request", () => {
		const proven = runAccent(succeeding({accentProof: {_tag: "Proven", accent: "amber"}}));
		expect(proven._tag === "Rendered" && proven.entry.accent).toEqual({
			requested: "amber",
			proven: "amber",
		});
		const plain = run(succeeding({}));
		expect(plain._tag === "Rendered" && "accent" in plain.entry).toBe(false);
	});

	it("refuses another accent under the requested name, naming what the root carried", () => {
		expect(runAccent(succeeding({accentProof: {_tag: "Mismatch", rendered: "ember"}}))).toEqual({
			_tag: "WrongAccent",
			wanted: "amber",
			reason: `the page's data-color-theme read back "ember"`,
		});
	});

	it("refuses an unreadable attribute and an absent proof — neither is a proof", () => {
		const unreadable = "the page's root carries no data-color-theme attribute";
		expect(runAccent(succeeding({accentProof: {_tag: "Unreadable", reason: unreadable}}))).toEqual({
			_tag: "WrongAccent",
			wanted: "amber",
			reason: unreadable,
		});
		expect(runAccent(succeeding({}))).toEqual({
			_tag: "WrongAccent",
			wanted: "amber",
			reason: "the capture returned no accent proof",
		});
	});

	it("keeps a crash ahead of the accent proof — a page that threw is a red render", () => {
		expect(
			runAccent(
				succeeding({
					accentProof: {_tag: "Mismatch", rendered: "ember"},
					pageErrors: [{kind: "pageerror", text: "TypeError: x is null"}],
				}),
			)._tag,
		).toBe("Crashed");
	});
});

/**
 * A hover the page never registered paints the surface at rest, a valid PNG under the interacted
 * name — so the interacted entry exists only when the capture came back proven, and a refused
 * interaction came back with no bytes at all.
 */
describe("captureRenderLeg — the interaction proof", () => {
	const SIL = {
		label: "sil-highlighted",
		steps: [
			{verb: "click", locator: 'role=button[name="Aç"]'},
			{verb: "hover", locator: 'role=menuitem[name="Sil"]'},
		],
	} as const;
	const interactRequest = {...request, interaction: SIL};
	const runInteract = (capture: CaptureShots): SurfaceRender =>
		Effect.runSync(makeCaptureRenderLeg(capture)(interactRequest));
	const REFUSED = {
		_tag: "Refused",
		step: 'hover:role=menuitem[name="Sil"]',
		reason: 'role=menuitem[name="Sil"] does not match :hover',
	} as const;
	const unwritten =
		(shot: Partial<UnwrittenSurface>): CaptureShots =>
		() =>
			Effect.succeed([
				{
					surface: "/pano",
					route: "/pano",
					state: null,
					fileName: "pano~sil-highlighted@desktop.png",
					pageErrors: [],
					status: 200,
					interactionProof: REFUSED,
					...shot,
				},
			]);

	it("plans the shot with its interaction and label, and plans neither for a shot at rest", () => {
		const planned: Array<{readonly interaction: unknown; readonly fileName: string}> = [];
		const spy: CaptureShots = (plan) => {
			planned.push(
				...plan.map((shot) => ({interaction: shot.interaction, fileName: shot.fileName})),
			);
			return succeeding({interactionProof: {_tag: "Proven", proven: ["x"]}})([], "", {});
		};
		runInteract(spy);
		run(spy);
		expect(planned).toEqual([
			{interaction: SIL, fileName: "pano~sil-highlighted@desktop.png"},
			{interaction: undefined, fileName: "pano@desktop.png"},
		]);
	});

	it("records the label, the steps it ran and what the page proved, and nothing on a shot at rest", () => {
		const proven = runInteract(
			succeeding({
				interactionProof: {_tag: "Proven", proven: ['role=menuitem[name="Sil"] matches :hover']},
			}),
		);
		expect(proven._tag === "Rendered" && proven.entry.interaction).toEqual({
			label: "sil-highlighted",
			steps: ['click:role=button[name="Aç"]', 'hover:role=menuitem[name="Sil"]'],
			proven: ['role=menuitem[name="Sil"] matches :hover'],
		});
		const plain = run(succeeding({}));
		expect(plain._tag === "Rendered" && "interaction" in plain.entry).toBe(false);
	});

	it("refuses a refused interaction, naming the step that stopped it", () => {
		expect(runInteract(unwritten({}))).toEqual({
			_tag: "Uninteracted",
			reason: `hover:role=menuitem[name="Sil"]: role=menuitem[name="Sil"] does not match :hover`,
		});
	});

	it("refuses an absent proof — a capture that says nothing about the interaction proved nothing", () => {
		expect(runInteract(succeeding({}))).toEqual({
			_tag: "Uninteracted",
			reason: "the capture returned no interaction proof",
		});
	});

	it("keeps a crash ahead of the interaction proof — a page that threw is a red render", () => {
		expect(
			runInteract(unwritten({pageErrors: [{kind: "pageerror", text: "TypeError: x is null"}]}))
				._tag,
		).toBe("Crashed");
	});

	it("keeps an unreachable page ahead of it too — a 404 has no menu to open", () => {
		expect(runInteract(unwritten({status: 404}))._tag).toBe("Unreachable");
	});
});
