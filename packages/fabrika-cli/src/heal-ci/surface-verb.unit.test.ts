import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeHttp, fakeShell, type HttpReply, linkNext} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN} from "./codes.ts";
import {
	checkRuns,
	ENV,
	HEAD,
	PROTECTION,
	PULL,
	protection,
	pull,
	rules,
	unexhaustedPage,
} from "./fixtures.test-support.ts";
import {runSurface} from "./surface-verb.ts";

/** The check-run and ruleset reads moved to the fetch client; the pull and protection reads did not. */
const CHECK_RUNS = /repos\/o\/r\/commits\/[0-9a-f]+\/check-runs/;
const RULES = /repos\/o\/r\/rules\/branches\/main/;

/**
 * A canned payload, served over HTTP rather than printed by a subprocess.
 *
 * The fixtures stay the one source for every payload shape — only the transport around them changed,
 * so a second literal here is how this test would come to disagree with the rest of the group.
 */
const served = (result: ExecResult): HttpReply => ({status: 200, body: result.stdout});

/**
 * The same, for a fixture written in the `gh api -i` shape: its body, carrying the `Link` proof the
 * fixture declared. A page that declares a `next` is one the caller can never prove complete.
 */
const servedPage = (result: ExecResult): HttpReply => {
	const [head = "", body = ""] = result.stdout.split("\r\n\r\n");
	return {
		status: 200,
		body,
		headers: /rel="next"/.test(head) ? linkNext("https://api.github.com/next?page=2") : undefined,
	};
};

const options = {pr: 4321, sha: "", repo: null, json: false, env: ENV};

const run = (
	shell: ReadonlyArray<readonly [RegExp, ExecResult]>,
	http: ReadonlyArray<readonly [RegExp, HttpReply]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runSurface({...options, ...overrides}),
			Layer.merge(fakeShell(shell).layer, fakeHttp(http).layer),
		),
	);

const completed = (name: string) => ({name, status: "completed", conclusion: "success"});

describe("runSurface compares the two sides and judges neither", () => {
	it("names an armed context nothing produces as the gap it is", async () => {
		const out = await run(
			[
				[PULL, pull()],
				[PROTECTION, protection()],
			],
			[
				[CHECK_RUNS, served(checkRuns(2, [completed("ci-required"), completed("unit tests")]))],
				[RULES, servedPage(rules("ci-required", "code-scanning/codeql"))],
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
				[PROTECTION, protection()],
			],
			[
				[CHECK_RUNS, served(checkRuns(1, [completed("ci-required")]))],
				[RULES, servedPage(rules("ci-required"))],
			],
		);
		expect(out.stdout.split("\n")[0]).toBe(`surface\tcovered\t${HEAD}`);
	});

	it("answers no-requirements only on a SUCCESSFUL rules read plus the protection 404", async () => {
		const out = await run(
			[
				[PULL, pull()],
				[PROTECTION, errOut("gh: Branch not protected (HTTP 404)")],
			],
			[
				[CHECK_RUNS, served(checkRuns(1, [completed("unit tests")]))],
				[RULES, servedPage(rules())],
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
			[[PULL, pull()]],
			[
				[CHECK_RUNS, served(checkRuns(1, [completed("unit tests")]))],
				[RULES, {status: 403, body: '{"message":"Resource not accessible by integration"}'}],
			],
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
			[[PULL, pull()]],
			[
				[CHECK_RUNS, served(checkRuns(1, [completed("ci-required")]))],
				[RULES, {status: 502, body: '{"message":"Bad gateway"}'}],
			],
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain('UNKNOWN, never "no-requirements"');
	});

	it("refuses an unexhausted rules enumeration on 13", async () => {
		const out = await run(
			[[PULL, pull()]],
			[
				[CHECK_RUNS, served(checkRuns(1, [completed("ci-required")]))],
				[RULES, servedPage(unexhaustedPage())],
			],
		);
		expect(out.code).toBe(INCOMPLETE_SCAN);
	});

	it("refuses a short check-run enumeration on 13", async () => {
		const out = await run(
			[[PULL, pull()]],
			[[CHECK_RUNS, served(checkRuns(9, [completed("ci-required")]))]],
		);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stdout).toBe("");
	});
});
