/**
 * The blessing-surface pure core: render the operator gallery, parse decisions, and
 * fold approve/redline verdicts into a golden-pointer move. Asserted with no fs, no
 * network — the human-in-the-loop bless → commit path, including the no-re-render guard
 * (blessed sha comes from the set, never a decision) and the re-bless update path.
 */
import {assert, describe, it} from "@effect/vitest";
import {applyBlessing, parseBlessDecisions, renderBlessingGallery} from "./blessing-surface.ts";
import type {CandidateSet} from "./candidate-set.ts";
import type {GoldenPointer} from "./golden-pointer.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

const set: CandidateSet = {
	previewUrl: "https://pr-1.preview.example.com",
	viewport: "desktop",
	forcedFlags: {"catalog-nav-redesign": true, "feed-v2": false},
	screens: [
		{
			order: 1,
			surfaceId: "/catalog",
			title: "Catalog home",
			intent: "catalog home, seeded corpus",
			sha256: SHA_A,
			url: `https://assets.example.com/${SHA_A}.png`,
			fileName: "catalog.png",
			localPath: "/tmp/shots/catalog.png",
		},
		{
			order: 2,
			surfaceId: "/feed",
			title: "Feed",
			intent: "feed, seeded",
			sha256: SHA_B,
			url: `https://assets.example.com/${SHA_B}.png`,
			fileName: "feed.png",
			localPath: "/tmp/shots/feed.png",
		},
	],
};

describe("renderBlessingGallery", () => {
	it("renders one section per candidate with the full-res store embed + sha", () => {
		const md = renderBlessingGallery(set);
		assert.include(md, "### 1. Catalog home");
		assert.include(md, "### 2. Feed");
		assert.include(md, "- surface: `/catalog`");
		assert.include(md, "- intent: feed, seeded");
		assert.include(md, `- golden sha256: \`${SHA_A}\``);
		assert.include(md, `![Catalog home](https://assets.example.com/${SHA_A}.png)`);
	});

	it("renders forced-flag provenance key-sorted and a decision template per surface", () => {
		const md = renderBlessingGallery(set);
		assert.include(md, "`catalog-nav-redesign=on`, `feed-v2=off`");
		// the template ships the placeholder (forces a real decision), one line per surface
		assert.include(md, "/catalog\tapprove|redline");
		assert.include(md, "/feed\tapprove|redline");
	});

	it("is deterministic — same set renders byte-identically", () => {
		assert.strictEqual(renderBlessingGallery(set), renderBlessingGallery(set));
	});
});

describe("parseBlessDecisions", () => {
	it("parses surfaceId + verdict lines, ignoring blanks, comments, and fences", () => {
		const decisions = parseBlessDecisions(
			["```", "# my picks", "/catalog approve", "", "/feed redline", "```"].join("\n"),
		);
		assert.deepStrictEqual(decisions, [
			{surfaceId: "/catalog", verdict: "approve"},
			{surfaceId: "/feed", verdict: "redline"},
		]);
	});

	it("is case-insensitive on the verdict token", () => {
		assert.deepStrictEqual(parseBlessDecisions("/catalog APPROVE"), [
			{surfaceId: "/catalog", verdict: "approve"},
		]);
	});

	it("rejects the un-replaced placeholder and any unknown verdict", () => {
		assert.throws(
			() => parseBlessDecisions("/catalog approve|redline"),
			/must be approve\|redline/,
		);
		assert.throws(() => parseBlessDecisions("/catalog maybe"), /must be approve\|redline/);
	});

	it("rejects a malformed line (not exactly surfaceId + verdict)", () => {
		assert.throws(() => parseBlessDecisions("/catalog"), /<surfaceId> <approve\|redline>/);
	});
});

describe("applyBlessing — the bless → pointer-move fold", () => {
	const empty: GoldenPointer = {};

	it("blesses approved surfaces to their candidate sha and leaves redlined ones out", () => {
		const result = applyBlessing({
			set,
			decisions: [
				{surfaceId: "/catalog", verdict: "approve"},
				{surfaceId: "/feed", verdict: "redline"},
			],
			blessedDate: "2026-07-14",
			pointer: empty,
		});
		assert.deepStrictEqual(result.pointer["/catalog"], {
			sha256: SHA_A,
			blessedDate: "2026-07-14",
			intent: "catalog home, seeded corpus",
		});
		assert.isUndefined(result.pointer["/feed"]);
		assert.deepStrictEqual(result.blessed, [{surfaceId: "/catalog", sha256: SHA_A}]);
		assert.deepStrictEqual(result.redlined, ["/feed"]);
	});

	it("no-re-render: the committed sha is the SET's sha, not any decision-supplied value", () => {
		// BlessDecision carries no sha by construction — the pointer can only move to a
		// content-address that was in the candidate set the operator saw.
		const result = applyBlessing({
			set,
			decisions: [
				{surfaceId: "/catalog", verdict: "approve"},
				{surfaceId: "/feed", verdict: "approve"},
			],
			blessedDate: "2026-07-14",
			pointer: empty,
		});
		assert.strictEqual(result.pointer["/catalog"]?.sha256, SHA_A);
		assert.strictEqual(result.pointer["/feed"]?.sha256, SHA_B);
	});

	it("re-bless: moves an existing golden to the new candidate sha, immutably", () => {
		const existing: GoldenPointer = {
			"/catalog": {sha256: SHA_C, blessedDate: "2026-06-01", intent: "old catalog home"},
		};
		const result = applyBlessing({
			set,
			decisions: [
				{surfaceId: "/catalog", verdict: "approve"},
				{surfaceId: "/feed", verdict: "redline"},
			],
			blessedDate: "2026-07-14",
			pointer: existing,
		});
		// the pointer moved to the new sha (explicit committed update, not a silent overwrite)
		assert.strictEqual(result.pointer["/catalog"]?.sha256, SHA_A);
		assert.strictEqual(result.pointer["/catalog"]?.blessedDate, "2026-07-14");
		// input pointer untouched — the audited baseline can't be clobbered under a reader
		assert.strictEqual(existing["/catalog"]?.sha256, SHA_C);
	});

	it("a redline does NOT remove an existing golden — it is just not re-blessed", () => {
		const existing: GoldenPointer = {
			"/feed": {sha256: SHA_C, blessedDate: "2026-06-01", intent: "old feed"},
		};
		const result = applyBlessing({
			set,
			decisions: [
				{surfaceId: "/catalog", verdict: "approve"},
				{surfaceId: "/feed", verdict: "redline"},
			],
			blessedDate: "2026-07-14",
			pointer: existing,
		});
		assert.strictEqual(result.pointer["/feed"]?.sha256, SHA_C);
	});

	it("fails closed on an unaddressed candidate (every screen needs a verdict)", () => {
		assert.throws(
			() =>
				applyBlessing({
					set,
					decisions: [{surfaceId: "/catalog", verdict: "approve"}],
					blessedDate: "2026-07-14",
					pointer: empty,
				}),
			/missing: \/feed/,
		);
	});

	it("fails closed on a decision for a surface not in the candidate set", () => {
		assert.throws(
			() =>
				applyBlessing({
					set,
					decisions: [
						{surfaceId: "/catalog", verdict: "approve"},
						{surfaceId: "/feed", verdict: "redline"},
						{surfaceId: "/absent", verdict: "approve"},
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
						{surfaceId: "/catalog", verdict: "approve"},
						{surfaceId: "/catalog", verdict: "redline"},
						{surfaceId: "/feed", verdict: "redline"},
					],
					blessedDate: "2026-07-14",
					pointer: empty,
				}),
			/duplicate decision/,
		);
	});
});
