/**
 * The blessing-surface pure core (issue #2962, ADR 0183 §5): render the founder
 * gallery, parse decisions, and fold approve/redline verdicts into a golden-pointer
 * move. Asserted with no fs, no network — the human-in-the-loop bless → commit path,
 * including the no-re-render guard (blessed sha comes from the set, never a decision)
 * and the re-bless update path (story 9).
 */
import {assert, describe, it} from "@effect/vitest";
import {applyBlessing, parseBlessDecisions, renderBlessingGallery} from "./blessing-surface.ts";
import type {CandidateSet} from "./candidate-set.ts";
import type {GoldenPointer} from "./golden-pointer.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

const set: CandidateSet = {
	previewUrl: "https://pr-1.web.kamp.us",
	viewport: "desktop",
	forcedFlags: {"sozluk-nav-redesign": true, "pano-feed-v2": false},
	screens: [
		{
			order: 1,
			surfaceId: "/sozluk",
			title: "Sözlük home",
			intent: "sözlük home, seeded corpus",
			sha256: SHA_A,
			url: `https://depo.kamp.us/${SHA_A}.png`,
			fileName: "sozluk.png",
			localPath: "/tmp/shots/sozluk.png",
		},
		{
			order: 2,
			surfaceId: "/pano",
			title: "Pano feed",
			intent: "pano feed, seeded",
			sha256: SHA_B,
			url: `https://depo.kamp.us/${SHA_B}.png`,
			fileName: "pano.png",
			localPath: "/tmp/shots/pano.png",
		},
	],
};

describe("renderBlessingGallery", () => {
	it("renders one section per candidate with the full-res depo embed + sha", () => {
		const md = renderBlessingGallery(set);
		assert.include(md, "### 1. Sözlük home");
		assert.include(md, "### 2. Pano feed");
		assert.include(md, "- surface: `/sozluk`");
		assert.include(md, "- intent: pano feed, seeded");
		assert.include(md, `- golden sha256: \`${SHA_A}\``);
		assert.include(md, `![Sözlük home](https://depo.kamp.us/${SHA_A}.png)`);
	});

	it("renders forced-flag provenance key-sorted and a decision template per surface", () => {
		const md = renderBlessingGallery(set);
		assert.include(md, "`pano-feed-v2=off`, `sozluk-nav-redesign=on`");
		// the template ships the placeholder (forces a real decision), one line per surface
		assert.include(md, "/sozluk\tapprove|redline");
		assert.include(md, "/pano\tapprove|redline");
	});

	it("is deterministic — same set renders byte-identically", () => {
		assert.strictEqual(renderBlessingGallery(set), renderBlessingGallery(set));
	});
});

describe("parseBlessDecisions", () => {
	it("parses surfaceId + verdict lines, ignoring blanks, comments, and fences", () => {
		const decisions = parseBlessDecisions(
			["```", "# my picks", "/sozluk approve", "", "/pano redline", "```"].join("\n"),
		);
		assert.deepStrictEqual(decisions, [
			{surfaceId: "/sozluk", verdict: "approve"},
			{surfaceId: "/pano", verdict: "redline"},
		]);
	});

	it("is case-insensitive on the verdict token", () => {
		assert.deepStrictEqual(parseBlessDecisions("/sozluk APPROVE"), [
			{surfaceId: "/sozluk", verdict: "approve"},
		]);
	});

	it("rejects the un-replaced placeholder and any unknown verdict", () => {
		assert.throws(() => parseBlessDecisions("/sozluk approve|redline"), /must be approve\|redline/);
		assert.throws(() => parseBlessDecisions("/sozluk maybe"), /must be approve\|redline/);
	});

	it("rejects a malformed line (not exactly surfaceId + verdict)", () => {
		assert.throws(() => parseBlessDecisions("/sozluk"), /<surfaceId> <approve\|redline>/);
	});
});

describe("applyBlessing — the bless → pointer-move fold", () => {
	const empty: GoldenPointer = {};

	it("blesses approved surfaces to their candidate sha and leaves redlined ones out", () => {
		const result = applyBlessing({
			set,
			decisions: [
				{surfaceId: "/sozluk", verdict: "approve"},
				{surfaceId: "/pano", verdict: "redline"},
			],
			blessedDate: "2026-07-14",
			pointer: empty,
		});
		assert.deepStrictEqual(result.pointer["/sozluk"], {
			sha256: SHA_A,
			blessedDate: "2026-07-14",
			intent: "sözlük home, seeded corpus",
		});
		assert.isUndefined(result.pointer["/pano"]);
		assert.deepStrictEqual(result.blessed, [{surfaceId: "/sozluk", sha256: SHA_A}]);
		assert.deepStrictEqual(result.redlined, ["/pano"]);
	});

	it("no-re-render: the committed sha is the SET's sha, not any decision-supplied value", () => {
		// BlessDecision carries no sha by construction — the pointer can only move to a
		// content-address that was in the candidate set the founder saw (ADR 0183 §5).
		const result = applyBlessing({
			set,
			decisions: [
				{surfaceId: "/sozluk", verdict: "approve"},
				{surfaceId: "/pano", verdict: "approve"},
			],
			blessedDate: "2026-07-14",
			pointer: empty,
		});
		assert.strictEqual(result.pointer["/sozluk"]?.sha256, SHA_A);
		assert.strictEqual(result.pointer["/pano"]?.sha256, SHA_B);
	});

	it("re-bless (story 9): moves an existing golden to the new candidate sha, immutably", () => {
		const existing: GoldenPointer = {
			"/sozluk": {sha256: SHA_C, blessedDate: "2026-06-01", intent: "old sözlük home"},
		};
		const result = applyBlessing({
			set,
			decisions: [
				{surfaceId: "/sozluk", verdict: "approve"},
				{surfaceId: "/pano", verdict: "redline"},
			],
			blessedDate: "2026-07-14",
			pointer: existing,
		});
		// the pointer moved to the new sha (explicit committed update, not a silent overwrite)
		assert.strictEqual(result.pointer["/sozluk"]?.sha256, SHA_A);
		assert.strictEqual(result.pointer["/sozluk"]?.blessedDate, "2026-07-14");
		// input pointer untouched — the audited baseline can't be clobbered under a reader
		assert.strictEqual(existing["/sozluk"]?.sha256, SHA_C);
	});

	it("a redline does NOT remove an existing golden — it is just not re-blessed", () => {
		const existing: GoldenPointer = {
			"/pano": {sha256: SHA_C, blessedDate: "2026-06-01", intent: "old pano"},
		};
		const result = applyBlessing({
			set,
			decisions: [
				{surfaceId: "/sozluk", verdict: "approve"},
				{surfaceId: "/pano", verdict: "redline"},
			],
			blessedDate: "2026-07-14",
			pointer: existing,
		});
		assert.strictEqual(result.pointer["/pano"]?.sha256, SHA_C);
	});

	it("fails closed on an unaddressed candidate (every screen needs a verdict)", () => {
		assert.throws(
			() =>
				applyBlessing({
					set,
					decisions: [{surfaceId: "/sozluk", verdict: "approve"}],
					blessedDate: "2026-07-14",
					pointer: empty,
				}),
			/missing: \/pano/,
		);
	});

	it("fails closed on a decision for a surface not in the candidate set", () => {
		assert.throws(
			() =>
				applyBlessing({
					set,
					decisions: [
						{surfaceId: "/sozluk", verdict: "approve"},
						{surfaceId: "/pano", verdict: "redline"},
						{surfaceId: "/kunye", verdict: "approve"},
					],
					blessedDate: "2026-07-14",
					pointer: empty,
				}),
			/no such candidate/,
		);
	});

	it("fails closed on a duplicate decision for the same surface", () => {
		assert.throws(
			() =>
				applyBlessing({
					set,
					decisions: [
						{surfaceId: "/sozluk", verdict: "approve"},
						{surfaceId: "/sozluk", verdict: "redline"},
						{surfaceId: "/pano", verdict: "redline"},
					],
					blessedDate: "2026-07-14",
					pointer: empty,
				}),
			/duplicate decision/,
		);
	});
});
