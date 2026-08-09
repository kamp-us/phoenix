import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {assert, describe, it} from "@effect/vitest";
import {Result} from "effect";
import {decodeIncidentProvenance} from "./incident-provenance.ts";
import {
	decodeRuledKeeps,
	KEEP_VERDICT,
	publishedFigure,
	publishedFigureViolations,
	ruledKeepsViolations,
	summarize,
	withCoverage,
} from "./ruled-keeps.ts";

const read = (leaf: string) =>
	readFileSync(fileURLToPath(new URL(`./incident-corpus/${leaf}`, import.meta.url)), "utf8");

const keeps = () => {
	const result = decodeRuledKeeps(read("ruled-keeps.json"));
	assert.isTrue(Result.isSuccess(result), "incident-corpus/ruled-keeps.json must decode to Ok");
	if (!Result.isSuccess(result)) throw new Error("unreachable");
	return result.success;
};

const provenance = () => {
	const result = decodeIncidentProvenance(read("provenance.json"));
	assert.isTrue(Result.isSuccess(result), "incident-corpus/provenance.json must decode to Ok");
	if (!Result.isSuccess(result)) throw new Error("unreachable");
	return result.success;
};

// The 7 the #4642 scope delta named borderline, and the 14 it re-bucketed to kill-scope.
const BORDERLINE = [4338, 3330, 4285, 4163, 4145, 3945, 3709];
const REBUCKETED = [
	4617, 4480, 4409, 4360, 4290, 4222, 4141, 4118, 4077, 4075, 4055, 3990, 3938, 3766,
];

describe("ruled KEEP corpus — the enumeration is the artifact, not a join to re-run", () => {
	it("decodes and holds its own integrity rules", () => {
		assert.deepStrictEqual(ruledKeepsViolations(keeps()), []);
	});

	it("enumerates the 66 ruled members, not the published 74", () => {
		const summary = summarize(withCoverage(keeps(), provenance()));
		assert.strictEqual(summary.members, 66);
		assert.strictEqual(summary.pending, 1);
	});

	it("every member carries the KEEP-AS-EVAL verdict the recipe requires", () => {
		for (const row of keeps().rows) {
			if (row.status !== "member") continue;
			assert.strictEqual(row.sweepVerdict, KEEP_VERDICT, `#${row.issue}`);
		}
	});

	it("all 7 borderline are inside the member set — the double-count #4642 published", () => {
		const members = new Set(
			keeps()
				.rows.filter((r) => r.status === "member")
				.map((r) => r.issue),
		);
		for (const issue of BORDERLINE) assert.isTrue(members.has(issue), `#${issue} must be a member`);
		const flagged = keeps()
			.rows.filter((r) => r.borderline)
			.map((r) => r.issue)
			.sort((a, b) => a - b);
		assert.deepStrictEqual(
			flagged,
			[...BORDERLINE].sort((a, b) => a - b),
		);
	});

	it("none of the 14 crew-layer re-buckets survived into the corpus", () => {
		const enumerated = new Set(keeps().rows.map((r) => r.issue));
		for (const issue of REBUCKETED) assert.isFalse(enumerated.has(issue), `#${issue}`);
	});
});

describe("ruled KEEP corpus — #4180 is pending, neither included nor dropped", () => {
	it("carries #4180 as a pending row quoting the #4642 retraction", () => {
		const row = keeps().rows.find((r) => r.issue === 4180);
		assert.isDefined(row, "#4180 must appear in the enumeration");
		assert.strictEqual(row?.status, "pending");
		assert.include(row?.status === "pending" ? row.pendingReason : "", "hereby retracted");
	});

	it("#4180 is the only pending row", () => {
		const pending = keeps().rows.filter((r) => r.status === "pending");
		assert.deepStrictEqual(
			pending.map((r) => r.issue),
			[4180],
		);
	});
});

describe("ruled KEEP corpus — coverage is derived from the ledger, never stored", () => {
	it("reports exactly the members the provenance ledger already cites", () => {
		const covered = withCoverage(keeps(), provenance())
			.filter((c) => c.pinnedBy.length > 0)
			.map((c) => c.row.issue)
			.sort((a, b) => a - b);
		const cited = new Set(provenance().cases.flatMap((c) => c.incidents));
		const expected = keeps()
			.rows.map((r) => r.issue)
			.filter((issue) => cited.has(`#${issue}`))
			.sort((a, b) => a - b);
		assert.deepStrictEqual(covered, expected);
		assert.isAbove(covered.length, 0, "the join must find the cases the ledger really cites");
	});
});

describe("ruled KEEP corpus — the corpus README points at the enumeration", () => {
	const readme = () => read("README.md");

	it("no longer instructs a case author to run the two-artifact join by hand", () => {
		assert.notInclude(readme(), "verify membership **two ways**");
		assert.notInclude(readme(), "no enumeration of the 74 exists to read");
	});

	it("no longer publishes 74 as the corpus size", () => {
		assert.notInclude(readme(), "74 KEEP");
	});

	it("names the committed enumeration and the corrected figure", () => {
		assert.include(readme(), "ruled-keeps.json");
		assert.include(readme(), publishedFigure(keeps()));
	});
});

/**
 * The corpus publishes its size to artifacts outside this package — the glossary entry a brief
 * author reads first, then the fabrika authoring-brief contract that tells them which incident rows
 * to cite — so a check confined to the package would go green while the page an author actually
 * reads still said 74 (#4823, and #4838 for the same defect one file over). The surface list is the
 * check: a page missing from it is unguarded however sound the assertion, so every page that
 * publishes the size belongs here. Each surface is read by path: an unreadable surface throws,
 * because "could not read it" and "it carries no stale figure" are different facts.
 */
describe("ruled KEEP corpus — every published cardinality is derived from the enumeration", () => {
	const SURFACES = [
		"./incident-corpus/README.md",
		"../../../../.glossary/TERMS.md",
		"../../../../claude-plugins/fabrika/docs/authoring-brief-contract.md",
	];

	it("checks a non-empty set of surfaces — zero scope reds (ADR 0092)", () => {
		assert.isAbove(SURFACES.length, 0);
	});

	it("no surface publishes a figure the enumeration does not support", () => {
		const figure = publishedFigure(keeps());
		const violations = SURFACES.flatMap((surface) =>
			publishedFigureViolations(
				surface,
				readFileSync(fileURLToPath(new URL(surface, import.meta.url)), "utf8"),
				figure,
			),
		);
		assert.deepStrictEqual(violations, []);
	});
});
