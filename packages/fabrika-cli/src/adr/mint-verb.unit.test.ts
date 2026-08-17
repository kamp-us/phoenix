/**
 * `adr mint` is the two halves fused, so what needs proving here is the seam: the allocated id is
 * the one written, and every UNKNOWN read refuses BEFORE anything reaches disk. An allocator that
 * scaffolds over a half-read set is the collision the fusion exists to remove.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, type FakeFs, fakeFs, fakeShell, okOut, tree} from "../fakes.test-support.ts";
import {FAILED} from "../verb.ts";
import {
	ALREADY_EXISTS,
	BASE_UNFETCHABLE,
	DIR_UNREADABLE,
	IN_FLIGHT_UNKNOWN,
	ORIGIN_REPO_UNRESOLVABLE,
	UNPARSEABLE_RECORD_ID,
} from "./codes.ts";
import {runMint} from "./mint-verb.ts";

const SHA = "49a22902d1e0c7b3f5a8e4126b9d0f3c7a1e5b82";
const PATH = ".decisions/0240-only-landed-adrs-may-be-cited.md";

const shell = (overrides: ReadonlyArray<readonly [RegExp, ReturnType<typeof okOut>]> = []) =>
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

const options = {
	slug: "only-landed-adrs-may-be-cited",
	dir: ".decisions",
	base: "origin/main",
	repo: null,
	status: "accepted",
	date: "2026-08-01",
	title: null,
	tags: null,
	json: false,
};

const run = (
	overrides: ReadonlyArray<readonly [RegExp, ReturnType<typeof okOut>]> = [],
	opts: Partial<typeof options> = {},
	fs: FakeFs = fakeFs({}),
) =>
	Effect.runPromise(
		Effect.provide(runMint({...options, ...opts}), Layer.merge(shell(overrides).layer, fs.layer)),
	);

describe("runMint", () => {
	it("writes the record at max(union) + 1 and prints its path", async () => {
		const fs = fakeFs({});
		const out = await run([], {}, fs);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`${PATH}\n`);
		expect(fs.written.get(PATH)).toContain("id: 0240");
		expect(out.stderr.join("\n")).toContain("3 decision records");
	});

	it("--json carries the allocation the record was written at", async () => {
		const out = await run([], {json: true});
		expect(JSON.parse(out.stdout)).toEqual({
			path: PATH,
			id: "0240",
			slug: "only-landed-adrs-may-be-cited",
			mergedMax: "0236",
			inFlight: ["0237", "0239"],
			baseRef: "origin/main",
			baseSha: SHA,
		});
	});

	it("allocates over the in-flight set, not the merged maximum", async () => {
		const fs = fakeFs({});
		await run([[/pulls\/12\/files/, okOut("added\t.decisions/0299-z.md\n")]], {}, fs);
		expect([...fs.written.keys()]).toEqual([".decisions/0300-only-landed-adrs-may-be-cited.md"]);
	});

	it.each([
		[
			"the origin remote is unreadable",
			[/^git remote get-url origin$/, ORIGIN_REPO_UNRESOLVABLE] as const,
		],
		["the base ref cannot be fetched", [/^git fetch/, BASE_UNFETCHABLE] as const],
		["the record directory is unreadable", [/^git ls-tree/, DIR_UNREADABLE] as const],
		[
			"the open pull requests cannot be enumerated",
			[/^gh api --paginate repos\/[^ ]+\/pulls\?/, IN_FLIGHT_UNKNOWN] as const,
		],
		["a pull request's files cannot be read", [/pulls\/11\/files/, IN_FLIGHT_UNKNOWN] as const],
	])("writes nothing when %s", async (_name, [pattern, code]) => {
		const fs = fakeFs({});
		const out = await run([[pattern, errOut("boom")]], {}, fs);
		expect(out.code).toBe(code);
		expect(out.stdout).toBe("");
		expect(fs.written.size).toBe(0);
	});

	it("writes nothing when a record filename carries no readable id", async () => {
		const fs = fakeFs({});
		const out = await run([[/^git ls-tree/, okOut(tree("0234-a.md", "12-bad.md"))]], {}, fs);
		expect(out.code).toBe(UNPARSEABLE_RECORD_ID);
		expect(fs.written.size).toBe(0);
	});

	it("refuses to overwrite an allocated path that already exists, keeping the scope line", async () => {
		const fs = fakeFs({files: {[PATH]: "existing"}});
		const out = await run([], {}, fs);
		expect(out.code).toBe(ALREADY_EXISTS);
		expect(out.stdout).toBe("");
		expect(fs.written.size).toBe(0);
		expect(out.stderr[0]).toContain("adr mint: scanned .decisions");
		expect(out.stderr.at(-1)).toBe(`adr mint: ${PATH} already exists — refusing to overwrite.`);
	});

	it("refuses a slug that is not kebab-case before it spends a read", async () => {
		const fs = fakeFs({});
		const sh = shell();
		const out = await Effect.runPromise(
			Effect.provide(runMint({...options, slug: "Not Kebab"}), Layer.merge(sh.layer, fs.layer)),
		);
		expect(out.code).toBe(FAILED);
		expect(out.stderr.at(-1)).toBe(
			'adr mint: slug "Not Kebab" is not kebab-case (lowercase letters, digits and single hyphens).',
		);
		expect(fs.written.size).toBe(0);
		// A usage error costs no fetch and no pull-request enumeration.
		expect(sh.calls).toEqual([]);
	});
});
