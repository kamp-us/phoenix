import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type CapturedSurface, CaptureError} from "../capture/capture.ts";
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

	it("collapses a capture's page errors to the cap plus a count of the rest (ADR 0308)", () => {
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
 * The width half of the same readback discipline (#7706): the requested viewport is what the plan
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
 * signed-in capture from the visitor's (#7051).
 */
describe("captureRenderLeg — the :auth session proof", () => {
	it("asks for the proof on an :auth surface and for nothing on a bare route", () => {
		const asked: Array<string | undefined> = [];
		const spy: CaptureShots = (_plan, _outDir, options) => {
			asked.push(options?.sessionProbeUrl);
			return authShot({sessionProof: {_tag: "SignedIn", userId: "u1", tier: "yazar"}})([], "", {});
		};
		runAuth(spy);
		run(spy);
		expect(asked[0]).toBe(`${PREVIEW}/api/auth/get-session`);
		expect(asked[1]).toBeUndefined();
	});

	it("records the shot only when the proof came back signed in", () => {
		expect(
			runAuth(authShot({sessionProof: {_tag: "SignedIn", userId: "u1", tier: "yazar"}}))._tag,
		).toBe("Rendered");
	});

	it("refuses a visitor's render under the :auth name", () => {
		expect(runAuth(authShot({sessionProof: {_tag: "Anonymous"}}))).toEqual({
			_tag: "Unauthenticated",
			reason: "the preview answered the seeded cookie as a visitor",
		});
	});

	it("refuses an unreadable probe too — a proof nobody could read is not a proof", () => {
		expect(
			runAuth(authShot({sessionProof: {_tag: "Unreadable", reason: "probe answered 502"}})),
		).toEqual({_tag: "Unauthenticated", reason: "probe answered 502"});
		expect(runAuth(authShot({}))._tag).toBe("Unauthenticated");
	});
});

/**
 * The tier half of the same proof (#7398). Every arm here IS signed in and decodes fine — the whole
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
					sessionProof: {_tag: "SignedIn" as const, userId: "u1", tier},
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
			runAuth(authShot({sessionProof: {_tag: "SignedIn", userId: "u1", tier: "çaylak"}})),
		).toEqual({_tag: "WrongTier", wanted: "yazar", rendered: "çaylak"});
	});
});

/**
 * One layer over the session proof and for the same reason: a preview that dropped the override
 * cookie renders the flag-off page, and that page is a valid PNG under the flag-on name (#7218).
 */
describe("captureRenderLeg — the forced-flag proof", () => {
	const FORCED = {"phoenix-welcome": true};
	const forcedRequest = {...authRequest, forcedFlags: FORCED};
	const runForced = (capture: CaptureShots): SurfaceRender =>
		Effect.runSync(makeCaptureRenderLeg(capture)(forcedRequest));
	const signedIn = {_tag: "SignedIn", userId: "u1", tier: "yazar"} as const;

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
					overrideProof: {_tag: "Inert", keys: ["phoenix-welcome"]},
				}),
			),
		).toEqual({
			_tag: "OverrideInert",
			reason: "the preview evaluated phoenix-welcome at the default",
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
			runForced(authShot({sessionProof: {_tag: "Anonymous"}, overrideProof: {_tag: "Forced"}}))
				._tag,
		).toBe("Unauthenticated");
	});
});
