import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeFs, fakeShell, okOut} from "../fakes.test-support.ts";
import {DOC_ABSENT, PRECONDITION_UNKNOWN} from "./codes.ts";
import {runDrift} from "./drift-verb.ts";
import {FIXTURES, UNANCHORED_DOC} from "./fixtures.test-support.ts";

const SHA = "49a22902d1e0c7b3f5a8e4126b9d0f3c7a1e5b82";
const ANCHOR = "7b1c0e4f2a9d6b83c5417e0af2d9b6c3e81547aa";
const MOVED = "aa4712e0af2d9b6c35417e83c5b6d9a2f4e0c1b7";

/**
 * Four candidates survive the repo-path filter and two of them resolve — the split the header
 * reports. `retry.ts` is ambiguous shorthand and never reaches the filter at all; the two
 * `packages/`-rooted misses are the *unresolved* half, which is counted and never treated as drift.
 */
const DOC = `# Worker queue retry

The shape lives in \`packages/fabrika-cli/src/bin.ts\` and [the router](apps/web/worker/router.ts),
alongside \`packages/effect/src/Effect.ts\`, \`packages/fate/src/server/live.ts\` and the bare
\`retry.ts\`.
`;

const TOP_LEVEL = "packages\napps\n.patterns\nREADME.md\n";

type Script = ReadonlyArray<readonly [RegExp, ReturnType<typeof okOut>]>;

const shell = (overrides: Script = []) =>
	fakeShell([
		...overrides,
		[/^git remote$/, okOut("origin\n")],
		[/^git fetch/, okOut("")],
		[/^git rev-parse/, okOut(`${SHA}\n`)],
		[
			/^git ls-tree --name-only \w+ -- \.patterns\/worker-queue-retry\.md$/,
			okOut(".patterns/worker-queue-retry.md\n"),
		],
		[/^git ls-tree --name-only \w+:$/, okOut(TOP_LEVEL)],
		[
			/^git ls-tree --name-only \w+ --/,
			okOut("packages/fabrika-cli/src/bin.ts\napps/web/worker/router.ts\n"),
		],
		[/^git show \w+:/, okOut(DOC)],
		[/^git log -1/, okOut(`${ANCHOR}\t2026-07-01\n`)],
		[/^git log --format=[^ ]+ \w+\.\.\w+ -- packages/, okOut(`${MOVED}\t2026-08-01\n`)],
		[/^git log --format=/, okOut("")],
	]);

const options = {slug: "worker-queue-retry", dir: ".patterns", base: "origin/main", json: false};

const run = (
	overrides: Script = [],
	opts: Partial<typeof options> = {},
	files: Readonly<Record<string, string | null>> = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runDrift({...options, ...opts}),
			Layer.merge(shell(overrides).layer, fakeFs({files}).layer),
		),
	);

describe("runDrift", () => {
	it("counts the followable paths, lists only the moved ones, and leaves the rest to the header", async () => {
		const out = await run();
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			[
				`drift\tdrifted\t${ANCHOR}\t4\t2\t2\t1`,
				`path\tpackages/fabrika-cli/src/bin.ts\t1\t${MOVED}\t2026-08-01`,
				"",
			].join("\n"),
		);
	});

	// An unresolved candidate is counted and named, never treated as a finding: pattern prose cites
	// external dependency source trees, and such a path is indistinguishable from a deleted in-repo
	// one by resolution alone.
	it("names every unresolved candidate on stderr rather than reporting it as drift", async () => {
		const out = await run([
			[/^git ls-tree --name-only \w+ -- packages/, okOut("")],
			[/^git ls-tree --name-only \w+ -- \.patterns/, okOut(".patterns/worker-queue-retry.md\n")],
		]);
		expect(out.stdout.split("\t")[1]).toBe("unanchored");
		expect(out.stderr.join("\n")).toContain("never treated as findings");
	});

	it("is `current`, not `drifted`, when nothing in the range touched a cited path", async () => {
		const out = await run([[/^git log --format=/, okOut("")]]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`drift\tcurrent\t${ANCHOR}\t4\t2\t2\t0\n`);
	});

	// The contract's worked example, byte for byte, over the unanchored-doc fixture's own text.
	it("answers `unanchored` with a `-` anchor for a doc citing nothing it can follow", async () => {
		const out = await run(
			[
				[/^git show \w+:/, okOut(UNANCHORED_DOC)],
				[
					/^git ls-tree --name-only \w+ -- \S/,
					okOut(`${FIXTURES}/unanchored-doc/worker-queue-retry.md\n`),
				],
			],
			{dir: `${FIXTURES}/unanchored-doc`},
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("drift\tunanchored\t-\t0\t0\t0\t0\n");
	});

	it("carries that same answer through --json", async () => {
		const out = await run(
			[
				[/^git show \w+:/, okOut(UNANCHORED_DOC)],
				[
					/^git ls-tree --name-only \w+ -- \S/,
					okOut(`${FIXTURES}/unanchored-doc/worker-queue-retry.md\n`),
				],
			],
			{dir: `${FIXTURES}/unanchored-doc`, json: true},
		);
		expect(out.stdout).toBe(
			`{"outcome":"unanchored","anchorSha":"-","cited":0,"inRepo":0,"unresolved":0,"moved":0,"paths":[],"unresolvedPaths":[],"baseRef":"origin/main","baseSha":"${SHA}"}\n`,
		);
	});

	// The contract's third worked example.
	it("refuses a slug with no doc in the working tree and none at the base", async () => {
		const out = await run([[/^git ls-tree --name-only \w+ --/, okOut("")]], {slug: "no-such-doc"});
		expect(out.code).toBe(DOC_ABSENT);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			'pattern drift: no doc for slug "no-such-doc" under .patterns, in the working tree or at origin/main.',
		);
	});

	// An uncommitted doc is the bootstrap case, not an empty diff — and `pattern anchor` answers the
	// same token on the same tree state, because the skill runs the two back to back.
	it("answers `unborn` for a doc present in the working tree and absent at the base", async () => {
		const out = await run(
			[[/^git ls-tree --name-only \w+ --/, okOut("")]],
			{},
			{
				".patterns/worker-queue-retry.md": "# New\n",
			},
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("drift\tunborn\t-\t0\t0\t0\t0\n");
	});

	it("refuses an unfetchable base — the outcome is UNKNOWN, never `current`", async () => {
		const out = await run([[/^git fetch/, errOut("fatal: couldn't find remote ref nope")]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain('UNKNOWN, never "current"');
	});

	it("refuses a history read it could not perform", async () => {
		const out = await run([[/^git log --format=/, errOut("fatal: bad revision")]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("refuses a slug that is not kebab-case on 1, the usage seat", async () => {
		const out = await run([], {slug: "Worker_Queue"});
		expect(out.code).toBe(1);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("is not kebab-case");
	});
});
