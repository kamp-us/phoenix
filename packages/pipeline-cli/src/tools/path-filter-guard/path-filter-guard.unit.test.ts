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
	/** The diff-basis inputs (#3722); omitted keys are absent from the `with:` block. */
	inputs: {readonly token?: string; readonly base?: string} = {},
): string => {
	const items = globs.map((g) => `              - '${g}'`);
	const block = [`            ${key}:`, ...extraLines.map((l) => `            ${l}`), ...items];
	const basisLines: Array<string> = [];
	if (inputs.token !== undefined) basisLines.push(`          token: '${inputs.token}'`);
	if (inputs.base !== undefined) basisLines.push(`          base: '${inputs.base}'`);
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
		...basisLines,
		"          filters: |",
		...block,
		"",
	].join("\n");
};

/** Stands in for the `${{ steps.mergebase.outputs.sha }}` expression the workflows pin. */
const MERGE_BASE = "<merge-base-expression>";

const SAMPLE = ["apps/**/src/**", "apps/**/worker/**", ".github/workflows/deploy.yml"];

describe("extractFilterList — the pure extractor", () => {
	it("extracts the e2e glob list from a well-formed ci.yml changes job", () => {
		const res = extractFilterList(mkWorkflow("e2e", SAMPLE), CI_E2E_SOURCE);
		expect(res).toEqual({ok: true, entries: SAMPLE, basis: {token: undefined, base: undefined}});
	});

	it("extracts the deploy glob list from a well-formed deploy.yml changes job", () => {
		const res = extractFilterList(mkWorkflow("deploy", SAMPLE), DEPLOY_SOURCE);
		expect(res).toEqual({ok: true, entries: SAMPLE, basis: {token: undefined, base: undefined}});
	});

	it("ignores inline # comments in the filters block (dorny parses it as YAML)", () => {
		const res = extractFilterList(
			mkWorkflow("e2e", SAMPLE, ["# SYNC INVARIANT: keep in lockstep with deploy.yml"]),
			CI_E2E_SOURCE,
		);
		expect(res).toEqual({ok: true, entries: SAMPLE, basis: {token: undefined, base: undefined}});
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

/**
 * The #3722 regression: equal globs are not enough. The wedge that redded PR #3713 had
 * byte-identical lists — it was the `token`/`base` inputs that diverged, so the two
 * workflows applied the same globs to different changed-file sets. These cases pin the
 * exact production shape of that bug and the shape that fixes it.
 */
describe("judge — diff-basis equality (#3722)", () => {
	it("FAILS (basis-drift) on the production wedge: ci pins token '' while deploy defaults it", () => {
		const verdict = judge({
			ciText: mkWorkflow("e2e", SAMPLE, [], {token: ""}),
			deployText: mkWorkflow("deploy", SAMPLE),
		});
		expect(verdict).toMatchObject({
			pass: false,
			reason: "basis-drift",
			ciBasis: {token: "", base: undefined},
			deployBasis: {token: undefined, base: undefined},
		});
	});

	it("FAILS (basis-drift) when only one side anchors the diff to a merge base", () => {
		const verdict = judge({
			ciText: mkWorkflow("e2e", SAMPLE, [], {
				token: "",
				base: MERGE_BASE,
			}),
			deployText: mkWorkflow("deploy", SAMPLE, [], {token: ""}),
		});
		expect(verdict).toMatchObject({pass: false, reason: "basis-drift"});
	});

	it("PASSES when both steps pin the same token and base", () => {
		const inputs = {token: "", base: MERGE_BASE};
		const verdict = judge({
			ciText: mkWorkflow("e2e", SAMPLE, [], inputs),
			deployText: mkWorkflow("deploy", SAMPLE, [], inputs),
		});
		expect(verdict).toEqual({pass: true, count: SAMPLE.length});
	});

	it("reports glob drift BEFORE basis drift when both have drifted", () => {
		const verdict = judge({
			ciText: mkWorkflow("e2e", [...SAMPLE, "apps/**/index.html"], [], {token: ""}),
			deployText: mkWorkflow("deploy", SAMPLE),
		});
		expect(verdict).toMatchObject({pass: false, reason: "drift"});
	});
});
