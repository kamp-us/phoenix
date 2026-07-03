import {assert, describe, it} from "@effect/vitest";
import {
	extractCandidates,
	findDrift,
	type MergeLine,
	normalize,
	parseKnownTerms,
	renderIssueBody,
	renderReport,
} from "./drift.ts";

const TERMS_FIXTURE = `# phoenix domain vocabulary (TERMS)

## Products (domains)

| Term | Definition | Not |
|---|---|---|
| pano | HN-style link aggregator. | "board" |
| sözlük (sozluk) | Turkish dev-terms dictionary. | "dictionary" |
| funnel / conversion funnel | The conversion-funnel readout. | a public metrics page |

## Feature flags

| Term | Definition | Not |
|---|---|---|
| split release/kill | The release lever. | |
`;

describe("normalize", () => {
	it("lowercases, collapses whitespace, trims", () => {
		assert.strictEqual(normalize("  Split   Serving "), "split serving");
	});
});

describe("parseKnownTerms", () => {
	it("pulls the first column of each table body row as a known term", () => {
		const known = parseKnownTerms(TERMS_FIXTURE);
		assert.isTrue(known.has("pano"));
		assert.isTrue(known.has("split release/kill"));
	});

	it("skips header rows and |---| separators", () => {
		const known = parseKnownTerms(TERMS_FIXTURE);
		assert.isFalse(known.has("term"));
		assert.isFalse([...known].some((t) => t.includes("---")));
	});

	it("splits ` / ` aliases into each name", () => {
		const known = parseKnownTerms(TERMS_FIXTURE);
		assert.isTrue(known.has("funnel"));
		assert.isTrue(known.has("conversion funnel"));
	});

	it("splits a parenthetical alias `sözlük (sozluk)` into both forms", () => {
		const known = parseKnownTerms(TERMS_FIXTURE);
		assert.isTrue(known.has("sözlük"));
		assert.isTrue(known.has("sozluk"));
	});
});

describe("extractCandidates", () => {
	it("strips the conventional-commit prefix and trailing (#N) backlinks", () => {
		const line: MergeLine = {
			subject: "feat(cf-utils): model the real release lever (#1726) (#1733)",
		};
		const cands = extractCandidates(line);
		assert.isFalse(cands.some((c) => c.includes("#")));
		assert.isFalse(cands.some((c) => c.includes("cf-utils")));
	});

	it("pulls a quoted multi-word phrase (a coined name)", () => {
		const line: MergeLine = {
			subject: 'feat(web): introduce "split serving" for releases',
		};
		assert.include(extractCandidates(line), "split serving");
	});

	it("ignores a quoted single word (too noisy)", () => {
		const line: MergeLine = {subject: 'feat(web): the "kill" path'};
		// the single quoted token "kill" must NOT be added on its own (a bare word is
		// not a coined multi-word concept); the subject n-gram "kill path" may still fire
		assert.notInclude(extractCandidates(line), "kill");
	});

	it("pulls a clean lever phrase from the subject, dropping boundary filler", () => {
		const line: MergeLine = {subject: "feat(cf-utils): add the true kill switch"};
		const cands = extractCandidates(line);
		// "kill switch" is the coinage; the filler-bounded windows ("add the",
		// "true kill switch") are dropped by the boundary-stopword filter.
		assert.include(cands, "kill switch");
		assert.notInclude(cands, "add the");
	});

	it("reads a QUOTED phrase out of the commit body (explicit-coinage signal)", () => {
		const line: MergeLine = {
			subject: "feat(x): a change",
			body: 'This introduces the "effective serving" model.',
		};
		assert.include(extractCandidates(line), "effective serving");
	});

	it("does NOT n-gram unquoted body prose (bodies would drown the signal)", () => {
		const line: MergeLine = {
			subject: "feat(x): a change",
			body: "This introduces the effective serving model with many prose words.",
		};
		// no quotes → the body's bigrams (e.g. "prose words") are NOT surfaced
		assert.notInclude(extractCandidates(line), "prose words");
	});

	it("drops filler-bounded windows (a phrase opening/closing on a stopword)", () => {
		const line: MergeLine = {subject: "feat(x): improve the widget pipeline for releases"};
		const cands = extractCandidates(line);
		assert.include(cands, "widget pipeline"); // a clean coinage survives
		assert.notInclude(cands, "for releases"); // opens on a stopword → dropped
		assert.notInclude(cands, "the widget"); // opens on a stopword → dropped
	});

	it("drops docs(glossary) merges — already a routed surface", () => {
		const line: MergeLine = {
			subject: "docs(glossary): add split release, effective serving (#1739)",
		};
		assert.deepStrictEqual(extractCandidates(line), []);
	});

	it("drops docs(decisions) merges — the ADR-routed surface prong (c) covers", () => {
		const line: MergeLine = {subject: "docs(decisions): ADR 0128 glossary triggers (#1745)"};
		assert.deepStrictEqual(extractCandidates(line), []);
	});
});

describe("findDrift", () => {
	const known = parseKnownTerms(TERMS_FIXTURE);

	it("surfaces a concept phrase not covered by any known term (the #1726 class)", () => {
		const lines: ReadonlyArray<MergeLine> = [
			{
				subject:
					'feat(cf-utils): model the real release lever — "split serving", kill switch (#1733)',
			},
		];
		const drift = findDrift(lines, known);
		assert.isTrue(drift.some((d) => d.phrase === "split serving"));
	});

	it("does NOT surface a phrase already covered by a known term (substring-tolerant)", () => {
		// `pano` is a known term; a phrase containing it is suppressed as already-named.
		const lines: ReadonlyArray<MergeLine> = [{subject: "feat(pano): pano list view"}];
		const drift = findDrift(lines, known);
		assert.isFalse(drift.some((d) => d.phrase.includes("pano")));
	});

	it("carries the source merge subject as evidence for the filed issue", () => {
		const subject = 'feat(x): introduce "widget forge" pipeline';
		const drift = findDrift([{subject}], known);
		const hit = drift.find((d) => d.phrase === "widget forge");
		assert.isDefined(hit);
		assert.strictEqual(hit?.source, subject);
	});

	it("de-duplicates a phrase across two merges, keeping the first source", () => {
		const lines: ReadonlyArray<MergeLine> = [
			{subject: 'feat(a): the "widget forge" A'},
			{subject: 'feat(b): the "widget forge" B'},
		];
		const drift = findDrift(lines, known).filter((d) => d.phrase === "widget forge");
		assert.strictEqual(drift.length, 1);
		assert.strictEqual(drift[0]?.source, 'feat(a): the "widget forge" A');
	});

	it("returns [] when nothing drifts (clean sweep)", () => {
		const lines: ReadonlyArray<MergeLine> = [{subject: "docs(glossary): housekeeping (#1)"}];
		assert.deepStrictEqual(findDrift(lines, known), []);
	});
});

describe("renderReport", () => {
	it("states a clean sweep explicitly (not silence)", () => {
		const r = renderReport([], 25);
		assert.include(r, "no candidate concept-level drift");
		assert.include(r, "25 recent merge");
	});

	it("lists each candidate with its source evidence", () => {
		const r = renderReport([{phrase: "split serving", source: "feat(x): … (#1)"}], 10);
		assert.include(r, "split serving");
		assert.include(r, "feat(x): … (#1)");
	});
});

describe("renderIssueBody", () => {
	it("emits the report skill's five type-blind sections", () => {
		const body = renderIssueBody([{phrase: "split serving", source: "feat(x): … (#1)"}], 20);
		for (const heading of [
			"## What I was doing",
			"## What I observed",
			"## Why it matters",
			"## Pointers",
			"## Suggested next step",
		]) {
			assert.include(body, heading);
		}
	});

	it("cites each drift phrase and its source in the observed section", () => {
		const body = renderIssueBody([{phrase: "split serving", source: "feat(x): src"}], 20);
		assert.include(body, "split serving");
		assert.include(body, "feat(x): src");
	});
});
