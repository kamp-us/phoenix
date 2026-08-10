import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut, tree} from "../fakes.test-support.ts";
import {
	BASE_UNFETCHABLE,
	DIR_UNREADABLE,
	IN_FLIGHT_UNKNOWN,
	ORIGIN_REPO_UNRESOLVABLE,
	UNPARSEABLE_RECORD_ID,
} from "./codes.ts";
import {runNext} from "./next-verb.ts";

const SHA = "49a22902d1e0c7b3f5a8e4126b9d0f3c7a1e5b82";

const base = (overrides: ReadonlyArray<readonly [RegExp, ReturnType<typeof okOut>]> = []) =>
	fakeShell([
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

const run = (
	overrides: ReadonlyArray<readonly [RegExp, ReturnType<typeof okOut>]> = [],
	opts: Partial<typeof options> = {},
) => Effect.runPromise(Effect.provide(runNext({...options, ...opts}), base(overrides).layer));

describe("runNext", () => {
	it("answers max(union) + 1 on stdout with the scope line on stderr", async () => {
		const out = await run();
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("0240\n");
		expect(out.stderr.join("\n")).toContain("3 decision records");
	});

	it("--json carries the whole allocation record", async () => {
		const out = await run([], {json: true});
		expect(JSON.parse(out.stdout)).toEqual({
			id: "0240",
			mergedMax: "0236",
			inFlight: ["0237", "0239"],
			baseRef: "origin/main",
			baseSha: SHA,
		});
	});

	it("refuses on an unfetchable base — the merged set is UNKNOWN, not the local tree", async () => {
		const out = await run([[/^git fetch/, errOut("fatal: couldn't find remote ref nonexistent")]]);
		expect(out.code).toBe(BASE_UNFETCHABLE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("the merged set is UNKNOWN");
	});

	it("refuses when the open pull requests cannot be enumerated — never 'nothing reserved'", async () => {
		const out = await run([
			[/^gh api --paginate repos\/[^ ]+\/pulls\?/, errOut("gh: Not Found (HTTP 404)")],
		]);
		expect(out.code).toBe(IN_FLIGHT_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain('never "nothing reserved"');
	});

	it("refuses when ONE pull request's file list cannot be read — incomplete is UNKNOWN", async () => {
		const out = await run([[/pulls\/12\/files/, errOut("HTTP 502")]]);
		expect(out.code).toBe(IN_FLIGHT_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("PR #12");
		expect(out.stderr.at(-1)).toContain("INCOMPLETE");
	});

	it("refuses when gh exits 0 with output that is not a list of numbers", async () => {
		const out = await run([[/^gh api --paginate repos\/[^ ]+\/pulls\?/, okOut("null\n")]]);
		expect(out.code).toBe(IN_FLIGHT_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("refuses when a pull request's file list comes back in an unexpected shape", async () => {
		const out = await run([[/pulls\/11\/files/, okOut("just-a-filename.md\n")]]);
		expect(out.code).toBe(IN_FLIGHT_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	// A fresh adopter's `.decisions/` is empty by definition, and `git ls-tree <sha>:<dir>` fails
	// outright on a directory that is not in the tree — so an empty listing PROVES an existing,
	// empty directory and mints `0001` (#5254).
	it("answers 0001 on a readable-but-empty --dir, with no open PR claiming an id", async () => {
		const out = await run([
			[/^git ls-tree/, okOut("")],
			[/^gh api --paginate repos\/[^ ]+\/pulls\?/, okOut("")],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("0001\n");
		expect(out.stderr.join("\n")).toContain("0 decision records");
	});

	it("unions an empty --dir with the in-flight set rather than restarting at 0001", async () => {
		const out = await run([[/^git ls-tree/, okOut("")]]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("0240\n");
	});

	// An unreadable directory is a PROVEN refusal, so it may not share `1` with a verb that failed
	// to run (#4208, #4219, #4736), and it must stay distinct from the empty directory that answers.
	it("refuses an unreadable --dir on its own proven code, not on 1", async () => {
		const out = await run([[/^git ls-tree/, errOut("fatal: not a tree object")]]);
		expect(out.code).toBe(DIR_UNREADABLE);
		expect(out.code).not.toBe(1);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			'adr next: cannot read .decisions at origin/main: fatal: not a tree object — the merged set is UNKNOWN, never "0 records".',
		);
	});

	it("keeps an unreadable --dir distinguishable from an empty one", async () => {
		const unreadable = await run([[/^git ls-tree/, errOut("fatal: not a tree object")]]);
		const empty = await run([[/^git ls-tree/, okOut("")]]);
		expect(unreadable.code).toBe(DIR_UNREADABLE);
		expect(empty.code).toBe(0);
	});

	it("refuses a record whose id cannot be parsed, on its own proven code", async () => {
		const out = await run([[/^git ls-tree/, okOut(tree("0234-a.md", "12-bad.md"))]]);
		expect(out.code).toBe(UNPARSEABLE_RECORD_ID);
		expect(out.code).not.toBe(1);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("unparseable id: 12-bad.md");
	});

	it("refuses an unresolvable origin remote on its own proven code, not on 1", async () => {
		const out = await run([
			[/^git remote get-url origin$/, errOut("fatal: No such remote 'origin'")],
		]);
		expect(out.code).toBe(ORIGIN_REPO_UNRESOLVABLE);
		expect(out.code).not.toBe(1);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("cannot resolve --repo from the origin remote");
	});

	it("refuses when git resolves the base to something that is not an object name", async () => {
		const out = await run([[/^git rev-parse/, okOut("not-a-sha\n")]]);
		expect(out.code).toBe(BASE_UNFETCHABLE);
		expect(out.stdout).toBe("");
	});
});
