import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut, unconfigured} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {
	branchRules,
	CODEOWNERS,
	ENV,
	files,
	HEAD,
	pull,
	repository,
} from "./fixtures.test-support.ts";
import {runScope} from "./scope-verb.ts";

const PULL = /^gh api repos\/o\/r\/pulls\/4321$/;
const FILES = /^gh api --paginate repos\/o\/r\/pulls\/4321\/files/;
const OWNERS = /contents\/\.github\/CODEOWNERS/;
const RULES = /^gh api repos\/o\/r\/rules\/branches\/main$/;
const REPO = /^gh api repos\/o\/r$/;
const CONFIG = /contents\/\.fabrika\.jsonc/;

const options = {pr: 4321, repo: null, json: false, cwd: "/repo", env: ENV};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runScope({...options, ...overrides}),
			Layer.merge(fakeShell(script).layer, unconfigured),
		),
	);

describe("runScope", () => {
	it("renders a partial split as `part-of:<n>` — the marker resolves at this seam as it does at review's", async () => {
		const out = await run([
			[PULL, pull({body: "does things\n\nPart of #4000\n"})],
			[FILES, files("apps/web/worker/cart.ts", "README.md")],
			[OWNERS, okOut(CODEOWNERS)],
		]);
		expect(out.stdout.split("\n")[0]).toBe(`scoped\t${HEAD}\topen\tpart-of:4000`);
	});

	it("prints one derivation: state, issue ref, classes, the namespaces they require, cp, landing and count", async () => {
		const out = await run([
			[PULL, pull()],
			[FILES, files("apps/web/src/App.tsx", "README.md")],
			[OWNERS, okOut(CODEOWNERS)],
			[RULES, branchRules("pull_request")],
			[REPO, repository()],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			[
				`scoped\t${HEAD}\topen\tfixes:4287`,
				"class\tcode\t1",
				"class\tdoc\t1",
				"class\tui\t1",
				"namespace\treview-code",
				"namespace\treview-doc",
				"namespace\treview-ui",
				"cp\tnot-control-plane",
				"landing\tdirect\tsquash",
				"files\t2",
				"",
			].join("\n"),
		);
	});

	it("names the queue path when a queue governs the base — the shipper's route, read once", async () => {
		const out = await run([
			[PULL, pull()],
			[FILES, files("README.md", "DEVELOPMENT.md")],
			[OWNERS, okOut(CODEOWNERS)],
			[RULES, branchRules("merge_queue")],
		]);
		expect(out.stdout).toContain(`landing\tqueue\t-\n`);
	});

	/**
	 * The one field that degrades rather than refusing: `ship merge` re-derives the same fact and
	 * refuses `11` on the same failed read, so a printed `unknown` can never license a landing.
	 */
	it("prints `unknown` and still answers when the landing path cannot be read", async () => {
		const out = await run([
			[PULL, pull()],
			[FILES, files("README.md", "DEVELOPMENT.md")],
			[OWNERS, okOut(CODEOWNERS)],
			[RULES, errOut("HTTP 503")],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain(`landing\tunknown\t-\n`);
		expect(out.stderr.some((line) => line.includes("cannot read main's landing path"))).toBe(true);
	});

	it("derives review-ui from a rendered surface but not from its own test file", async () => {
		const out = await run([
			[PULL, pull()],
			[FILES, files("apps/web/src/App.tsx", "apps/web/src/App.test.tsx")],
			[OWNERS, okOut(CODEOWNERS)],
		]);
		expect(out.stdout).toContain("class\tui\t1");
	});

	it("prints governance beside the class namespaces when the diff touches a governance root", async () => {
		const out = await run([
			[PULL, pull()],
			[FILES, files(".decisions/0244-corpus-review.md", "README.md")],
			[OWNERS, okOut(CODEOWNERS)],
		]);
		expect(out.stdout).toContain("namespace\tgovernance");
		// One class here, so the whole namespace block is exactly these two lines, in this order.
		expect(out.stdout).toContain(["namespace\treview-doc", "namespace\tgovernance"].join("\n"));
	});

	it("prints no governance line for a diff under no governance root", async () => {
		const out = await run([
			[PULL, pull()],
			[FILES, files("apps/web/src/App.tsx", "README.md")],
			[OWNERS, okOut(CODEOWNERS)],
		]);
		expect(out.stdout).not.toContain("governance");
	});

	it("reports a merged PR as an ANSWER, not a refusal", async () => {
		const out = await run([
			[PULL, pull({merged: true, state: "closed", changedFiles: 1})],
			[FILES, files("README.md")],
			[OWNERS, okOut(CODEOWNERS)],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toContain("\tmerged\t");
	});

	it("reports a draft PR as an answer too", async () => {
		const out = await run([
			[PULL, pull({draft: true, changedFiles: 1})],
			[FILES, files("README.md")],
			[OWNERS, okOut(CODEOWNERS)],
		]);
		expect(out.stdout.split("\n")[0]).toContain("\tdraft\t");
	});

	it("classifies a control-plane path off CODEOWNERS itself", async () => {
		const out = await run([
			[PULL, pull({changedFiles: 1})],
			[FILES, files(".github/workflows/ci.yml")],
			[OWNERS, okOut(CODEOWNERS)],
		]);
		expect(out.stdout).toContain("cp\tcontrol-plane");
	});

	it("is not-control-plane when the boundary is proven absent — this repo has no control plane", async () => {
		const out = await run([
			[PULL, pull({changedFiles: 1})],
			[FILES, files("README.md")],
			[OWNERS, errOut("gh: Not Found (HTTP 404)")],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("cp\tnot-control-plane");
	});

	it("still holds on unknown for a boundary that reads fine and bounds nothing", async () => {
		const out = await run([
			[PULL, pull({changedFiles: 1})],
			[FILES, files("README.md")],
			[OWNERS, okOut("/a/ owner@example.test\n")],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("cp\tunknown");
	});

	it("refuses an UNREADABLE boundary on 11 when the repo declares `refuse`", async () => {
		const out = await run([
			[PULL, pull({changedFiles: 1})],
			[FILES, files("README.md")],
			[OWNERS, errOut("gh: Bad gateway (HTTP 502)")],
			[CONFIG, okOut('{"unreadableCodeowners": "refuse"}')],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("the scope is UNKNOWN");
	});

	it("ships an UNREADABLE boundary on the shipped default, and names the waiver on stderr", async () => {
		const out = await run([
			[PULL, pull({changedFiles: 1})],
			[FILES, files("README.md")],
			[OWNERS, errOut("gh: Bad gateway (HTTP 502)")],
			[CONFIG, errOut("gh: Not Found (HTTP 404)")],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("cp\tnot-control-plane");
		expect(out.stderr.join("\n")).toContain("unreadableCodeowners");
	});

	it("refuses on 11 when the POLICY could not be read either — nothing waives an unread gate", async () => {
		const out = await run([
			[PULL, pull({changedFiles: 1})],
			[FILES, files("README.md")],
			[OWNERS, errOut("gh: Bad gateway (HTTP 502)")],
			[CONFIG, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain(".fabrika.jsonc");
	});

	it("refuses zero changed files on 7", async () => {
		const out = await run([
			[PULL, pull({changedFiles: 0})],
			[FILES, files()],
		]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe(
			"ship scope: PR #4321 has zero changed files — nothing to ship (ADR 0092).",
		);
	});

	it("refuses a truncated file list on 13 rather than partitioning it", async () => {
		const out = await run([
			[PULL, pull({changedFiles: 9})],
			[FILES, files("README.md")],
		]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			"ship scope: file list shows 1 of 9 declared files — refusing to partition a truncated read.",
		);
	});

	it("refuses a PR proven absent on 7", async () => {
		const out = await run([[PULL, errOut("gh: Not Found (HTTP 404)")]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe("ship scope: PR #4321 not found in o/r.");
	});
});
