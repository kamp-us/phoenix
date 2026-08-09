/**
 * The candidate-render orchestration (issue #2961 AC 1/2): drive the injected
 * capture + depo-store legs over the founder priority set and fold the results into a
 * candidate set — no browser, no depo. Proves the surfaces are shot in founder order
 * over the flag-forced preview, each candidate's emitted sha256 IS the stored one
 * (the ADR 0183 §5 no-re-render anchor), and the forced-flag state is recorded.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {type CaptureLeg, renderCandidateSet, type StoreLeg} from "./candidate-render.ts";
import {type CapturedSurface, CaptureError, type CaptureOptions} from "./capture.ts";
import type {StoredGolden} from "./golden-store.ts";
import type {Shot} from "./plan.ts";

/** A fake capture leg: returns stub captures with per-surface deterministic bytes. */
const fakeCapture = (): {leg: CaptureLeg; calls: {shots: readonly Shot[]}[]} => {
	const calls: {shots: readonly Shot[]}[] = [];
	const leg: CaptureLeg = (shots, outDir, _options: CaptureOptions) => {
		calls.push({shots});
		return Effect.succeed(
			shots.map(
				(s, i): CapturedSurface => ({
					surface: s.surface.surface,
					route: s.surface.route,
					state: s.surface.state,
					localPath: `${outDir}/${s.fileName}`,
					fileName: s.fileName,
					// distinct bytes per surface so the store leg yields a distinct sha per surface
					pngBytes: new Uint8Array([i + 1]),
					pageErrors: [],
				}),
			),
		);
	};
	return {leg, calls};
};

/** A fake depo store leg: content-address is a deterministic 64-hex from the first byte. */
const fakeStore = (): StoreLeg => (pngBytes) => {
	const stem = String(pngBytes[0] ?? 0).padStart(64, "0");
	return Effect.succeed<StoredGolden>({sha256: stem, url: `https://depo.kamp.us/${stem}.png`});
};

describe("renderCandidateSet", () => {
	it("renders the priority surfaces over the preview in founder order and stores each", async () => {
		const {leg, calls} = fakeCapture();
		const set = await Effect.runPromise(
			renderCandidateSet(
				{
					previewUrl: "https://pr-1.workers.dev",
					params: {termSlug: "amortisman"},
					outDir: "/out",
					forcedFlags: {"golden-screens": true},
				},
				{capture: leg, store: fakeStore()},
			),
		);
		// shot over the preview, in founder order
		assert.deepStrictEqual(
			calls[0]?.shots.map((s) => s.url),
			[
				"https://pr-1.workers.dev/sozluk",
				"https://pr-1.workers.dev/sozluk/amortisman",
				"https://pr-1.workers.dev/pano",
			],
		);
		assert.deepStrictEqual(
			set.screens.map((s) => [s.order, s.surfaceId]),
			[
				[1, "/sozluk"],
				[2, "/sozluk/amortisman"],
				[3, "/pano"],
			],
		);
	});

	it("emits the EXACT stored sha256 per candidate (the no-re-render anchor, ADR 0183 §5)", async () => {
		const {leg} = fakeCapture();
		const set = await Effect.runPromise(
			renderCandidateSet(
				{previewUrl: "https://pr-1.workers.dev", params: {termSlug: "x"}, outDir: "/out"},
				{capture: leg, store: fakeStore()},
			),
		);
		// bytes were [1],[2],[3] → stems "…001","…002","…003" → matching urls
		assert.deepStrictEqual(
			set.screens.map((s) => s.sha256),
			[String(1).padStart(64, "0"), String(2).padStart(64, "0"), String(3).padStart(64, "0")],
		);
		for (const s of set.screens) {
			assert.strictEqual(s.url, `https://depo.kamp.us/${s.sha256}.png`);
		}
	});

	it("records the forced-flag state + viewport as provenance", async () => {
		const {leg} = fakeCapture();
		const set = await Effect.runPromise(
			renderCandidateSet(
				{
					previewUrl: "https://pr-1.workers.dev",
					params: {termSlug: "x"},
					outDir: "/out",
					forcedFlags: {"golden-screens": true},
				},
				{capture: leg, store: fakeStore()},
			),
		);
		assert.deepStrictEqual(set.forcedFlags, {"golden-screens": true});
		assert.strictEqual(set.viewport, "desktop");
		assert.strictEqual(set.previewUrl, "https://pr-1.workers.dev");
	});

	it("short-circuits a capture failure (nothing to bless from a broken render)", async () => {
		const failing: CaptureLeg = () => Effect.fail(new CaptureError({message: "boom"}));
		const exit = await Effect.runPromiseExit(
			renderCandidateSet(
				{previewUrl: "https://pr-1.workers.dev", params: {termSlug: "x"}, outDir: "/out"},
				{capture: failing, store: fakeStore()},
			),
		);
		assert.isTrue(exit._tag === "Failure");
	});

	it("wraps a plan-build failure (unfilled term slug) as a CaptureError in-channel", async () => {
		const {leg} = fakeCapture();
		const exit = await Effect.runPromiseExit(
			renderCandidateSet(
				// empty termSlug ⇒ resolvePrioritySurfaces throws on the :slug route
				{previewUrl: "https://pr-1.workers.dev", params: {termSlug: ""}, outDir: "/out"},
				{capture: leg, store: fakeStore()},
			),
		);
		assert.isTrue(exit._tag === "Failure");
	});
});
