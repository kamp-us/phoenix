import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut, tree} from "../fakes.test-support.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import {runCorpus} from "./corpus-verb.ts";
import {FIXTURES} from "./fixtures.test-support.ts";

const SHA = "49a22902d1e0c7b3f5a8e4126b9d0f3c7a1e5b82";
const DOC_SHA = "c18bd103ce24cda98aed690cbbec2669f46f98f8";

const INDEX = `# Patterns

## Index — services

| Doc | Topic | Read when |
|---|---|---|
| [registered.md](./registered.md) | x | y |
| [gone.md](./gone.md) | x | y |
`;

type Script = ReadonlyArray<readonly [RegExp, ReturnType<typeof okOut>]>;

const base = (overrides: Script = [], dir = ".patterns") =>
	fakeShell([
		...overrides,
		[/^git remote$/, okOut("origin\n")],
		[/^git fetch/, okOut("")],
		[/^git rev-parse/, okOut(`${SHA}\n`)],
		[/^git ls-tree --name-only \w+ --/, okOut(`${dir}\n`)],
		[/^git ls-tree --name-only \w+:/, okOut(tree("index.md", "registered.md", "orphan.md"))],
		[/^git show \w+:.*index\.md$/, okOut(INDEX)],
		[/^git log -1/, okOut(`${DOC_SHA}\t2026-08-09\n`)],
	]);

const options = {dir: ".patterns", base: "origin/main", json: false};

const run = (overrides: Script = [], opts: Partial<typeof options> = {}) =>
	Effect.runPromise(
		Effect.provide(
			runCorpus({...options, ...opts}),
			base(overrides, opts.dir ?? options.dir).layer,
		),
	);

describe("runCorpus", () => {
	it("emits the header, then a doc line per doc, then a dangling line per orphaned row", async () => {
		const out = await run();
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			[
				"corpus\tlibrary\t2\t1\t0\t1",
				`doc\torphan\tunregistered\t-\t${DOC_SHA}\t2026-08-09`,
				`doc\tregistered\tregistered\tIndex — services\t${DOC_SHA}\t2026-08-09`,
				"dangling\t./gone.md\tIndex — services",
				"",
			].join("\n"),
		);
	});

	// The contract's first worked example, byte for byte.
	it("answers `none` at exit 0 for a library that exists and is empty", async () => {
		const out = await run([[/^git ls-tree --name-only \w+:/, okOut(tree("index.md"))]], {
			dir: `${FIXTURES}/empty-library`,
		});
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("corpus\tnone\t0\t0\t0\t0\n");
	});

	// The contract's second worked example. `no-library` is deliberately not a committed directory —
	// it is the absent path, and a fixture that existed could not demonstrate this outcome.
	it("answers `absent` at exit 0 when --dir is not in the tree", async () => {
		const out = await run([[/^git ls-tree --name-only \w+ --/, okOut("")]], {
			dir: `${FIXTURES}/no-library`,
		});
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("corpus\tabsent\t0\t0\t0\t0\n");
	});

	// The contract's third worked example.
	it("carries the same empty answer through --json", async () => {
		const out = await run([[/^git ls-tree --name-only \w+:/, okOut(tree("index.md"))]], {
			dir: `${FIXTURES}/empty-library`,
			json: true,
		});
		expect(out.stdout).toBe(
			`{"outcome":"none","docs":0,"unregistered":0,"unknown":0,"dangling":0,"entries":[],"danglingRows":[],"baseRef":"origin/main","baseSha":"${SHA}"}\n`,
		);
	});

	// An unreadable directory and an absent one take opposite branches, so they may never fuse.
	it("refuses an unfetchable base — the corpus is UNKNOWN, never `none`", async () => {
		const out = await run([[/^git fetch/, errOut("fatal: couldn't find remote ref nope")]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			'pattern corpus: cannot fetch origin/main: fatal: couldn\'t find remote ref nope — the corpus is UNKNOWN, never "none".',
		);
	});

	it("refuses a tree read that FAILED, and never reads that as `absent`", async () => {
		const out = await run([
			[/^git ls-tree --name-only \w+ --/, errOut("fatal: not a tree object")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain('UNKNOWN, never "absent"');
	});

	it("refuses a history read it could not perform, never a missing commit", async () => {
		const out = await run([[/^git log -1/, errOut("fatal: bad revision")]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("UNKNOWN, never a missing commit");
	});

	// Rendering an unknowable registration as `unregistered` would report a defect this verb never
	// proved, and send a caller to add rows to a file that cannot hold them.
	it("reports every registration `unknown` when the index holds no table, with a note on stderr", async () => {
		const out = await run([[/^git show \w+:.*index\.md$/, okOut("# Patterns\n\nNothing yet.\n")]]);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain(`doc\torphan\tunknown\t-\t${DOC_SHA}`);
		expect(out.stdout.split("\n")[0]).toBe("corpus\tlibrary\t2\t0\t2\t0");
		expect(out.stderr.join("\n")).toContain('"unknown" rather than "unregistered"');
	});

	it("reports the same when the index is absent altogether", async () => {
		const out = await run([
			[/^git ls-tree --name-only \w+:/, okOut(tree("registered.md", "orphan.md"))],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe("corpus\tlibrary\t2\t0\t2\t0");
	});

	it("fetches the base BEFORE it reads the tree", async () => {
		const shell = base();
		await Effect.runPromise(Effect.provide(runCorpus(options), shell.layer));
		const fetched = shell.calls.findIndex((c) => c.startsWith("git fetch"));
		const listed = shell.calls.findIndex((c) => c.startsWith("git ls-tree"));
		expect(fetched).toBeGreaterThanOrEqual(0);
		expect(fetched).toBeLessThan(listed);
	});
});
