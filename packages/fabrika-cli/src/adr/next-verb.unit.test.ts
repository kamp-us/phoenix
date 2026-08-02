import {describe, expect, it} from "vitest";
import {errOut, fakeExec, okOut, tree} from "../fakes.test-support.ts";
import {BASE_UNFETCHABLE, IN_FLIGHT_UNKNOWN, runNext, ZERO_SCOPE} from "./next-verb.ts";

const SHA = "49a22902d1e0c7b3f5a8e4126b9d0f3c7a1e5b82";

const base = (overrides: ReadonlyArray<readonly [RegExp, ReturnType<typeof okOut>]> = []) =>
	fakeExec([
		...overrides,
		[/^git remote$/, okOut("origin\n")],
		[/^git remote get-url origin$/, okOut("git@github.com:kamp-us/phoenix.git\n")],
		[/^git fetch/, okOut("")],
		[/^git rev-parse/, okOut(`${SHA}\n`)],
		[/^git ls-tree/, okOut(tree("0234-a.md", "0235-b.md", "0236-c.md"))],
		[/^gh api --paginate repos\/[^ ]+\/pulls\?/, okOut("11\n12\n")],
		[/pulls\/11\/files/, okOut("added\t.decisions/0237-x.md\nmodified\tREADME.md\n")],
		[/pulls\/12\/files/, okOut("added\t.decisions/0239-y.md\n")],
	]);

const options = {dir: ".decisions", base: "origin/main", repo: null, json: false};

describe("runNext", () => {
	it("answers max(union) + 1 on stdout with the scope line on stderr", () => {
		const out = runNext(base(), options);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("0240\n");
		expect(out.stderr.join("\n")).toContain("3 decision records");
	});

	it("--json carries the whole allocation record", () => {
		const out = runNext(base(), {...options, json: true});
		expect(JSON.parse(out.stdout)).toEqual({
			id: "0240",
			mergedMax: "0236",
			inFlight: ["0237", "0239"],
			baseRef: "origin/main",
			baseSha: SHA,
		});
	});

	it("refuses on an unfetchable base — the merged set is UNKNOWN, not the local tree", () => {
		const out = runNext(
			base([[/^git fetch/, errOut("fatal: couldn't find remote ref nonexistent")]]),
			options,
		);
		expect(out.code).toBe(BASE_UNFETCHABLE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("the merged set is UNKNOWN");
	});

	it("refuses when the open pull requests cannot be enumerated — never 'nothing reserved'", () => {
		const out = runNext(
			base([[/^gh api --paginate repos\/[^ ]+\/pulls\?/, errOut("gh: Not Found (HTTP 404)")]]),
			options,
		);
		expect(out.code).toBe(IN_FLIGHT_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain('never "nothing reserved"');
	});

	it("refuses when ONE pull request's file list cannot be read — incomplete is UNKNOWN", () => {
		const out = runNext(base([[/pulls\/12\/files/, errOut("HTTP 502")]]), options);
		expect(out.code).toBe(IN_FLIGHT_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("PR #12");
		expect(out.stderr.at(-1)).toContain("INCOMPLETE");
	});

	it("refuses when gh exits 0 with output that is not a list of numbers", () => {
		const out = runNext(
			base([[/^gh api --paginate repos\/[^ ]+\/pulls\?/, okOut("null\n")]]),
			options,
		);
		expect(out.code).toBe(IN_FLIGHT_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("refuses when a pull request's file list comes back in an unexpected shape", () => {
		const out = runNext(base([[/pulls\/11\/files/, okOut("just-a-filename.md\n")]]), options);
		expect(out.code).toBe(IN_FLIGHT_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("refuses on zero scope rather than answering 0001", () => {
		const out = runNext(base([[/^git ls-tree/, okOut("")]]), options);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("ADR 0092");
	});

	it("refuses a record whose id cannot be parsed", () => {
		const out = runNext(base([[/^git ls-tree/, okOut(tree("0234-a.md", "12-bad.md"))]]), options);
		expect(out.code).toBe(1);
		expect(out.stderr.at(-1)).toContain("unparseable id: 12-bad.md");
	});

	it("refuses when git resolves the base to something that is not an object name", () => {
		const out = runNext(base([[/^git rev-parse/, okOut("not-a-sha\n")]]), options);
		expect(out.code).toBe(BASE_UNFETCHABLE);
		expect(out.stdout).toBe("");
	});
});
