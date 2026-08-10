/**
 * The candidate-set assembly + (de)serialize core (issue #2961 AC 2/3): the set is
 * assembled in founder order with the exact depo sha256 per surface (ADR 0183 §5's
 * no-re-render anchor), serialized deterministically, and round-trips through parse;
 * a partial/mismatched render fails closed.
 */
import {assert, describe, it} from "@effect/vitest";
import {
	assembleCandidateSet,
	parseCandidateSet,
	type RenderedCandidate,
	serializeCandidateSet,
} from "./candidate-set.ts";
import {parseSurfaceSpec} from "./plan.ts";
import type {ResolvedPrioritySurface} from "./priority-surfaces.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

const surfaces: readonly ResolvedPrioritySurface[] = [
	{
		order: 1,
		key: "global-shell-subnav",
		title: "Global shell + product subnav",
		intent: "shell",
		surface: parseSurfaceSpec("/sozluk"),
	},
	{
		order: 2,
		key: "pano-feed",
		title: "Pano feed",
		intent: "feed",
		surface: parseSurfaceSpec("/pano"),
	},
];

const rendered: readonly RenderedCandidate[] = [
	{
		surfaceId: "/pano",
		sha256: SHA_B,
		url: `https://depo.kamp.us/${SHA_B}.png`,
		fileName: "pano@desktop.png",
		localPath: "/out/pano@desktop.png",
	},
	{
		surfaceId: "/sozluk",
		sha256: SHA_A,
		url: `https://depo.kamp.us/${SHA_A}.png`,
		fileName: "sozluk@desktop.png",
		localPath: "/out/sozluk@desktop.png",
	},
];

describe("assembleCandidateSet", () => {
	it("joins by surface-id and preserves founder order (not render order)", () => {
		const set = assembleCandidateSet({
			previewUrl: "https://pr-1.workers.dev",
			viewport: "desktop",
			forcedFlags: {"golden-screens": true},
			surfaces,
			rendered,
		});
		assert.deepStrictEqual(
			set.screens.map((s) => [s.order, s.surfaceId, s.sha256]),
			[
				[1, "/sozluk", SHA_A],
				[2, "/pano", SHA_B],
			],
		);
	});

	it("carries the bless intent + full-res depo url per candidate", () => {
		const set = assembleCandidateSet({
			previewUrl: "https://pr-1.workers.dev",
			viewport: "desktop",
			forcedFlags: {},
			surfaces,
			rendered,
		});
		assert.strictEqual(set.screens[0]?.intent, "shell");
		assert.strictEqual(set.screens[0]?.url, `https://depo.kamp.us/${SHA_A}.png`);
	});

	it("fails closed when a priority surface has no rendered candidate", () => {
		assert.throws(
			() =>
				assembleCandidateSet({
					previewUrl: "https://pr-1.workers.dev",
					viewport: "desktop",
					forcedFlags: {},
					surfaces,
					rendered: [rendered[1] as RenderedCandidate], // only /sozluk
				}),
			/count.*!=.*priority-surface count/,
		);
	});

	it("fails closed on a duplicate rendered candidate", () => {
		assert.throws(
			() =>
				assembleCandidateSet({
					previewUrl: "https://pr-1.workers.dev",
					viewport: "desktop",
					forcedFlags: {},
					surfaces,
					rendered: [rendered[1] as RenderedCandidate, rendered[1] as RenderedCandidate],
				}),
			/duplicate rendered candidate/,
		);
	});

	it("rejects a non-sha256 content-address (a .png/URL slipped in)", () => {
		assert.throws(
			() =>
				assembleCandidateSet({
					previewUrl: "https://pr-1.workers.dev",
					viewport: "desktop",
					forcedFlags: {},
					surfaces: [surfaces[0] as ResolvedPrioritySurface],
					rendered: [
						{...(rendered[1] as RenderedCandidate), surfaceId: "/sozluk", sha256: `${SHA_A}.png`},
					],
				}),
			/64-hex sha256 stem/,
		);
	});
});

describe("serializeCandidateSet / parseCandidateSet", () => {
	const set = assembleCandidateSet({
		previewUrl: "https://pr-1.workers.dev",
		viewport: "desktop",
		forcedFlags: {"golden-screens": true, "pano-draft": false},
		surfaces,
		rendered,
	});

	it("round-trips through serialize → parse", () => {
		assert.deepStrictEqual(parseCandidateSet(serializeCandidateSet(set)), set);
	});

	it("serializes deterministically (sorted flag keys, trailing newline)", () => {
		const text = serializeCandidateSet(set);
		assert.strictEqual(serializeCandidateSet(set), text);
		assert.isTrue(text.endsWith("\n"));
		assert.isBelow(text.indexOf("golden-screens"), text.indexOf("pano-draft"));
	});

	it("parse fails closed on a malformed screen", () => {
		assert.throws(
			() =>
				parseCandidateSet(
					'{"previewUrl":"x","viewport":"d","forcedFlags":{},"screens":[{"order":1}]}',
				),
			/screen\[0\] is malformed/,
		);
	});

	it("parse fails closed on a bad sha256 in a screen", () => {
		const bad = JSON.stringify({
			previewUrl: "x",
			viewport: "d",
			forcedFlags: {},
			screens: [
				{
					order: 1,
					surfaceId: "/sozluk",
					title: "t",
					intent: "i",
					sha256: "nope",
					url: "u",
					fileName: "f",
					localPath: "l",
				},
			],
		});
		assert.throws(() => parseCandidateSet(bad), /not a 64-hex stem/);
	});
});
