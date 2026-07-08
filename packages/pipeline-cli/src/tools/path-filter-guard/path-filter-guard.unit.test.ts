/**
 * The pure `path-filter-guard` verdict + extractor (issue #2372), over crafted workflow
 * YAML — no disk. The IO exit-code gate is crossed in `gate.unit.test.ts`; here the
 * decision itself is proven: set equality passes, any one-entry drift (either direction)
 * fails, a reorder passes (set comparison), and every zero-scope arm fails closed.
 */
import {describe, expect, it} from "@effect/vitest";
import {CI_E2E_SOURCE, DEPLOY_SOURCE, extractFilterList, judge} from "./path-filter-guard.ts";

/**
 * Build a workflow YAML with a `changes` job whose dorny/paths-filter step carries a
 * single `<key>:` filter list. `extraLines` inject raw block-scalar lines (e.g. an inline
 * `#` comment) to prove dorny-comment inertness. Indentation is exact: `filters: |` at 10
 * spaces, block content at 12, list items at 14.
 */
const mkWorkflow = (
	key: string,
	globs: ReadonlyArray<string>,
	extraLines: ReadonlyArray<string> = [],
): string => {
	const items = globs.map((g) => `              - '${g}'`);
	const block = [`            ${key}:`, ...extraLines.map((l) => `            ${l}`), ...items];
	return [
		"name: T",
		"on:",
		"  pull_request:",
		"jobs:",
		"  changes:",
		"    runs-on: ubuntu-latest",
		"    steps:",
		"      - uses: actions/checkout@v4.2.2",
		"      - uses: dorny/paths-filter@v3.0.2",
		"        id: filter",
		"        with:",
		"          filters: |",
		...block,
		"",
	].join("\n");
};

const SAMPLE = ["apps/**/src/**", "apps/**/worker/**", ".github/workflows/deploy.yml"];

describe("extractFilterList — the pure extractor", () => {
	it("extracts the e2e glob list from a well-formed ci.yml changes job", () => {
		const res = extractFilterList(mkWorkflow("e2e", SAMPLE), CI_E2E_SOURCE);
		expect(res).toEqual({ok: true, entries: SAMPLE});
	});

	it("extracts the deploy glob list from a well-formed deploy.yml changes job", () => {
		const res = extractFilterList(mkWorkflow("deploy", SAMPLE), DEPLOY_SOURCE);
		expect(res).toEqual({ok: true, entries: SAMPLE});
	});

	it("ignores inline # comments in the filters block (dorny parses it as YAML)", () => {
		const res = extractFilterList(
			mkWorkflow("e2e", SAMPLE, ["# SYNC INVARIANT: keep in lockstep with deploy.yml"]),
			CI_E2E_SOURCE,
		);
		expect(res).toEqual({ok: true, entries: SAMPLE});
	});

	it("fails closed on unparseable workflow YAML", () => {
		const res = extractFilterList("name: [unterminated\n", CI_E2E_SOURCE);
		expect(res.ok).toBe(false);
	});

	it("fails closed when the changes job is missing", () => {
		const noJob = mkWorkflow("e2e", SAMPLE).replace("  changes:", "  other:");
		const res = extractFilterList(noJob, CI_E2E_SOURCE);
		expect(res.ok).toBe(false);
	});

	it("fails closed when there is no dorny/paths-filter step", () => {
		const noStep = mkWorkflow("e2e", SAMPLE).replace(
			"      - uses: dorny/paths-filter@v3.0.2",
			"      - uses: some/other-action@v1",
		);
		const res = extractFilterList(noStep, CI_E2E_SOURCE);
		expect(res.ok).toBe(false);
	});

	it("fails closed when the target filter key is missing", () => {
		// A filters block that declares `code:` but not the requested `e2e:` key.
		const res = extractFilterList(mkWorkflow("code", SAMPLE), CI_E2E_SOURCE);
		expect(res.ok).toBe(false);
	});

	it("fails closed on an empty filter list", () => {
		const res = extractFilterList(mkWorkflow("e2e", []), CI_E2E_SOURCE);
		expect(res.ok).toBe(false);
	});
});

describe("judge — set equality over the two filter lists", () => {
	it("PASSES when the two lists are identical", () => {
		const verdict = judge({
			ciText: mkWorkflow("e2e", SAMPLE),
			deployText: mkWorkflow("deploy", SAMPLE),
		});
		expect(verdict).toEqual({pass: true, count: SAMPLE.length});
	});

	it("PASSES when the two lists are equal but reordered (set comparison)", () => {
		const reversed = [...SAMPLE].reverse();
		const verdict = judge({
			ciText: mkWorkflow("e2e", SAMPLE),
			deployText: mkWorkflow("deploy", reversed),
		});
		expect(verdict.pass).toBe(true);
	});

	it("FAILS (drift) when ci.yml's e2e list has an entry deploy lacks", () => {
		const verdict = judge({
			ciText: mkWorkflow("e2e", [...SAMPLE, "apps/**/index.html"]),
			deployText: mkWorkflow("deploy", SAMPLE),
		});
		expect(verdict).toMatchObject({
			pass: false,
			reason: "drift",
			onlyInE2e: ["apps/**/index.html"],
			onlyInDeploy: [],
		});
	});

	it("FAILS (drift) when deploy.yml's deploy list has an entry e2e lacks", () => {
		const verdict = judge({
			ciText: mkWorkflow("e2e", SAMPLE),
			deployText: mkWorkflow("deploy", [...SAMPLE, "packages/preview-seed/**"]),
		});
		expect(verdict).toMatchObject({
			pass: false,
			reason: "drift",
			onlyInE2e: [],
			onlyInDeploy: ["packages/preview-seed/**"],
		});
	});

	it("FAILS (zero-scope) when the ci.yml e2e list can't be extracted", () => {
		const verdict = judge({
			ciText: mkWorkflow("code", SAMPLE),
			deployText: mkWorkflow("deploy", SAMPLE),
		});
		expect(verdict).toMatchObject({pass: false, reason: "zero-scope"});
	});

	it("FAILS (zero-scope) when the deploy.yml deploy list is empty", () => {
		const verdict = judge({
			ciText: mkWorkflow("e2e", SAMPLE),
			deployText: mkWorkflow("deploy", []),
		});
		expect(verdict).toMatchObject({pass: false, reason: "zero-scope"});
	});
});
