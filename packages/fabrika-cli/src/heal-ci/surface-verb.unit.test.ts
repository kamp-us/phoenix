import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeHttp, fakeShell, type HttpReply, linkNext} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN} from "./codes.ts";
import {
	CHECK_RUNS,
	checkRuns,
	ENV,
	HEAD,
	httpError,
	PROTECTION,
	PULL,
	protection,
	pull,
	RULES,
	rules,
} from "./fixtures.test-support.ts";
import {runSurface} from "./surface-verb.ts";

const options = {pr: 4321, sha: "", repo: null, json: false, env: ENV};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	served: ReadonlyArray<readonly [RegExp, HttpReply]> = [],
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runSurface({...options, ...overrides}),
			Layer.merge(fakeShell(script).layer, fakeHttp(served).layer),
		),
	);

const completed = (name: string) => ({name, status: "completed", conclusion: "success"});

describe("runSurface compares the two sides and judges neither", () => {
	it("names an armed context nothing produces as the gap it is", async () => {
		const out = await run(
			[
				[PULL, pull()],
				[CHECK_RUNS, checkRuns(2, [completed("ci-required"), completed("unit tests")])],
			],
			[
				[RULES, rules("ci-required", "code-scanning/codeql")],
				[PROTECTION, protection()],
			],
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			[
				`surface\tgap\t${HEAD}`,
				"required\tci-required\tproducing",
				"required\tcode-scanning/codeql\tabsent",
				"extra\tunit tests",
				"facts\trequired:2\tproducing:1\textra:1",
				"",
			].join("\n"),
		);
	});

	it("answers covered when every declared context has a producing run", async () => {
		const out = await run(
			[
				[PULL, pull()],
				[CHECK_RUNS, checkRuns(1, [completed("ci-required")])],
			],
			[
				[RULES, rules("ci-required")],
				[PROTECTION, protection()],
			],
		);
		expect(out.stdout.split("\n")[0]).toBe(`surface\tcovered\t${HEAD}`);
	});

	it("answers no-requirements only on a SUCCESSFUL rules read plus the protection 404", async () => {
		const out = await run(
			[
				[PULL, pull()],
				[CHECK_RUNS, checkRuns(1, [completed("unit tests")])],
			],
			[
				[RULES, rules()],
				[PROTECTION, httpError(404, "Branch not protected")],
			],
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			[
				`surface\tno-requirements\t${HEAD}`,
				"extra\tunit tests",
				"facts\trequired:0\tproducing:0\textra:1",
				"",
			].join("\n"),
		);
	});

	it("answers unprobeable — never no-requirements — when the token cannot see the surface", async () => {
		const out = await run(
			[
				[PULL, pull()],
				[CHECK_RUNS, checkRuns(1, [completed("unit tests")])],
			],
			[[RULES, httpError(403, "Resource not accessible by integration")]],
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			[
				`surface\tunprobeable\t${HEAD}`,
				"extra\tunit tests",
				"facts\trequired:-\tproducing:-\textra:1",
				"",
			].join("\n"),
		);
		expect(out.stderr.at(-1)).toContain('UNPROBEABLE, never "no requirements"');
	});
});

describe("runSurface refuses rather than answering over unknown scope", () => {
	it("refuses a transport failure on the rules read on 11", async () => {
		const out = await run(
			[
				[PULL, pull()],
				[CHECK_RUNS, checkRuns(1, [completed("ci-required")])],
			],
			[[RULES, httpError(502, "Bad gateway")]],
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain('UNKNOWN, never "no-requirements"');
	});

	it("refuses an unexhausted rules enumeration on 13", async () => {
		// Every page declares a `next`, so the walk hits PAGE_CAP with the link still outstanding —
		// which is the only shape that proves non-exhaustion rather than merely failing to disprove it.
		const out = await run(
			[
				[PULL, pull()],
				[CHECK_RUNS, checkRuns(1, [completed("ci-required")])],
			],
			[[RULES, {...rules(), headers: linkNext("https://api.github.com/next")}]],
		);
		expect(out.code).toBe(INCOMPLETE_SCAN);
	});

	it("refuses a short check-run enumeration on 13", async () => {
		const out = await run([
			[PULL, pull()],
			[CHECK_RUNS, checkRuns(9, [completed("ci-required")])],
		]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stdout).toBe("");
	});
});
