import type {CapturedSurface, CaptureOptions, Shot} from "@kampus/design-capture";
import {parseSurfaceSpec} from "@kampus/design-capture";
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type CaptureLeg, renderLocal} from "./render.ts";

/** A fake capture leg: records the plan + options it was handed, returns stub captures. */
const recordingLeg = () => {
	const calls: {shots: readonly Shot[]; outDir: string; options: CaptureOptions}[] = [];
	const leg: CaptureLeg = (shots, outDir, options) => {
		calls.push({shots, outDir, options});
		return Effect.succeed(
			shots.map(
				(s): CapturedSurface => ({
					surface: s.surface.surface,
					route: s.surface.route,
					state: s.surface.state,
					localPath: `${outDir}/${s.fileName}`,
					fileName: s.fileName,
					pngBytes: new Uint8Array(),
					pageErrors: [],
				}),
			),
		);
	};
	return {leg, calls};
};

describe("renderLocal", () => {
	it("drives the injected leg over the local plan and returns per-surface captures", async () => {
		const {leg, calls} = recordingLeg();
		const captured = await Effect.runPromise(
			renderLocal({surfaces: [parseSurfaceSpec("/sozluk")], outDir: "/tmp/shots"}, {capture: leg}),
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.shots[0]!.url).toBe("http://localhost:3000/sozluk");
		expect(captured[0]!.localPath).toBe("/tmp/shots/sozluk@desktop.png");
	});

	it("seeds the dev-override cookie only when overrides are given", async () => {
		const {leg, calls} = recordingLeg();
		await Effect.runPromise(
			renderLocal(
				{
					surfaces: [parseSurfaceSpec("/sozluk")],
					outDir: "/tmp/shots",
					overrides: {"pano-draft-save": true},
				},
				{capture: leg},
			),
		);
		const cookies = calls[0]!.options.cookies ?? [];
		expect(cookies).toHaveLength(1);
		expect(cookies[0]!.name).toBe("phoenix_flag_overrides");
		expect(JSON.parse(decodeURIComponent(cookies[0]!.value))).toEqual({"pano-draft-save": true});
	});

	it("passes no cookie when no overrides are given", async () => {
		const {leg, calls} = recordingLeg();
		await Effect.runPromise(
			renderLocal({surfaces: [parseSurfaceSpec("/sozluk")], outDir: "/tmp/shots"}, {capture: leg}),
		);
		expect(calls[0]!.options.cookies).toBeUndefined();
	});

	it("attaches the crop/downscale directive to the shot", async () => {
		const {leg, calls} = recordingLeg();
		await Effect.runPromise(
			renderLocal(
				{
					surfaces: [parseSurfaceSpec("/sozluk")],
					outDir: "/tmp/shots",
					regions: {"/sozluk": {x: 0, y: 0, width: 1000, height: 2800}},
				},
				{capture: leg},
			),
		);
		const shot = calls[0]!.shots[0]!;
		expect(shot.clip).toEqual({x: 0, y: 0, width: 1000, height: 2800});
		expect(shot.deviceScaleFactor).toBe(0.5);
	});

	it("fails in-channel (CaptureError) on a non-loopback base — never renders a remote origin", async () => {
		const {leg} = recordingLeg();
		const exit = await Effect.runPromiseExit(
			renderLocal(
				{surfaces: [parseSurfaceSpec("/sozluk")], outDir: "/tmp/shots", base: "https://kamp.us"},
				{capture: leg},
			),
		);
		expect(exit._tag).toBe("Failure");
	});
});
