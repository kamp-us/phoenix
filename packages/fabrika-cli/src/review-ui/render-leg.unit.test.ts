import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type CapturedSurface, CaptureError} from "../capture/capture.ts";
import {NO_FORCED_FLAGS} from "../capture/flag-override.ts";
import {encodePng, solid} from "../ui/fakes.test-support.ts";
import {PAGE_ERROR_CAP} from "./manifest.ts";
import {type CaptureShots, makeCaptureRenderLeg} from "./render-leg.ts";
import type {SurfaceRender} from "./render-verb.ts";

const PREVIEW = "https://pr-4321-web.example.test";

const request = {
	surface: "/pano",
	previewUrl: PREVIEW,
	outDir: "/tmp/shots",
	cookies: [],
	forcedFlags: NO_FORCED_FLAGS,
};

const failing =
	(message: string): CaptureShots =>
	() =>
		Effect.fail(new CaptureError({message}));

const png = (): Uint8Array => encodePng(8, 4, solid(8, 4, [12, 34, 56, 255]));

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
				pngBytes: png(),
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
				pngBytes: png(),
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
 * The bytes cannot answer this: an anonymous render of `/pano` is a valid PNG whichever name it is
 * filed under, so every arm below decodes fine and the classification is the only thing separating a
 * signed-in capture from the visitor's (#7051).
 */
describe("captureRenderLeg — the :auth session proof", () => {
	it("asks for the proof on an :auth surface and for nothing on a bare route", () => {
		const asked: Array<string | undefined> = [];
		const spy: CaptureShots = (_plan, _outDir, options) => {
			asked.push(options?.sessionProbeUrl);
			return authShot({sessionProof: {_tag: "SignedIn", userId: "u1"}})([], "", {});
		};
		runAuth(spy);
		run(spy);
		expect(asked[0]).toBe(`${PREVIEW}/api/auth/get-session`);
		expect(asked[1]).toBeUndefined();
	});

	it("records the shot only when the proof came back signed in", () => {
		expect(runAuth(authShot({sessionProof: {_tag: "SignedIn", userId: "u1"}}))._tag).toBe(
			"Rendered",
		);
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
 * One layer over the session proof and for the same reason: a preview that dropped the override
 * cookie renders the flag-off page, and that page is a valid PNG under the flag-on name (#7218).
 */
describe("captureRenderLeg — the forced-flag proof", () => {
	const FORCED = {"phoenix-welcome": true};
	const forcedRequest = {...authRequest, forcedFlags: FORCED};
	const runForced = (capture: CaptureShots): SurfaceRender =>
		Effect.runSync(makeCaptureRenderLeg(capture)(forcedRequest));
	const signedIn = {_tag: "SignedIn", userId: "u1"} as const;

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
