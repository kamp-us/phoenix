import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type CapturedSurface, CaptureError} from "../capture/capture.ts";
import {type CaptureShots, makeCaptureRenderLeg} from "./render-leg.ts";
import type {SurfaceRender} from "./render-verb.ts";

const PREVIEW = "https://pr-4321-web.example.test";

const request = {surface: "/pano", previewUrl: PREVIEW, outDir: "/tmp/shots"};

const failing =
	(message: string): CaptureShots =>
	() =>
		Effect.fail(new CaptureError({message}));

/** A 24-byte PNG header declaring 8x4 — enough for `validateCaptureBytes`, no codec needed. */
const pngHeader = (): Uint8Array => {
	const bytes = new Uint8Array(24);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	bytes.set([0x49, 0x48, 0x44, 0x52], 12);
	bytes[19] = 8;
	bytes[23] = 4;
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
});
