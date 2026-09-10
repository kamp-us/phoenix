import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeFs, fakeShell, okOut} from "../fakes.test-support.ts";
import {runAnchor} from "./anchor-verb.ts";
import {DOC_ABSENT, PRECONDITION_UNKNOWN} from "./codes.ts";
import {ANCHORED_DOC, FIXTURE_MANIFEST, FIXTURES, PLAIN_DOC} from "./fixtures.test-support.ts";

const SHA = "49a22902d1e0c7b3f5a8e4126b9d0f3c7a1e5b82";
const DIR = `${FIXTURES}/anchored`;
const MANIFEST = `${DIR}/workspace.yaml`;

type Script = ReadonlyArray<readonly [RegExp, ReturnType<typeof okOut>]>;

const shell = (overrides: Script = [], slug = "worker-queue-retry") =>
	fakeShell([
		...overrides,
		[/^git remote$/, okOut("origin\n")],
		[/^git fetch/, okOut("")],
		[/^git rev-parse/, okOut(`${SHA}\n`)],
		[/^git ls-tree --name-only \w+ -- \S+\.md$/, okOut(`${DIR}/${slug}.md\n`)],
		[/^git ls-tree --name-only \w+ -- \S+\.yaml$/, okOut(`${MANIFEST}\n`)],
		[/^git show \w+:\S+\.yaml$/, okOut(FIXTURE_MANIFEST)],
		[/^git show \w+:\S+plain-doc\.md$/, okOut(PLAIN_DOC)],
		[/^git show \w+:/, okOut(ANCHORED_DOC)],
	]);

const options = {
	slug: "worker-queue-retry",
	dir: DIR,
	manifest: MANIFEST,
	base: "origin/main",
	json: false,
};

const run = (
	overrides: Script = [],
	opts: Partial<typeof options> = {},
	files: Readonly<Record<string, string | null>> = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runAnchor({...options, ...opts}),
			Layer.merge(shell(overrides, opts.slug ?? options.slug).layer, fakeFs({files}).layer),
		),
	);

describe("runAnchor", () => {
	// The contract's first worked example, byte for byte.
	it("reports one moved and one unpinned declaration at exit 0", async () => {
		const out = await run();
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			[
				"anchor\tmoved\t2\t1\t1\t0",
				"pkg\tacme-queue\t4.1.0\t4.2.0\tmoved",
				"pkg\t@acme/retry\t2.0.0\t-\tunpinned",
				"",
			].join("\n"),
		);
	});

	// The contract's second worked example. `unanchored` is a FACT, not a fault: most pattern docs
	// describe in-repo shapes and are anchored to no dependency at all.
	it("answers `unanchored` for a doc that declares nothing", async () => {
		const out = await run([], {slug: "plain-doc"});
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("anchor\tunanchored\t0\t0\t0\t0\n");
	});

	// The contract's third worked example.
	it("carries the whole record through --json", async () => {
		const out = await run([], {json: true});
		expect(out.stdout).toBe(
			`{"outcome":"moved","declared":2,"moved":1,"unpinned":1,"malformed":0,"packages":[{"package":"acme-queue","declaredVersion":"4.1.0","pinnedVersion":"4.2.0","state":"moved"},{"package":"@acme/retry","declaredVersion":"2.0.0","pinnedVersion":null,"state":"unpinned"}],"manifest":"${MANIFEST}","baseRef":"origin/main","baseSha":"${SHA}"}\n`,
		);
	});

	// The header is always `<moved> + <unpinned> + <malformed> + <matched>`, so a reader can check it
	// against itself; counting only the well-formed lines would hide what the verb exists to surface.
	it("counts a near-miss line as malformed rather than as absent", async () => {
		const out = await run([
			[
				/^git show \w+:\S+\.md$/,
				okOut(
					"# Doc\n\n> Derived from the in-repo source plus `acme-queue@4.1.0` where it counts\n",
				),
			],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe("anchor\tmalformed\t1\t0\t0\t1");
		expect(out.stdout.split("\n")[1]).toBe(
			"pkg\tthe in-repo source plus `acme-queue@4.1.0` where it counts\t-\t-\tmalformed",
		);
	});

	// An unreadable manifest is UNKNOWN and never `unpinned` — a 404 is a verdict, a 5xx is a verdict
	// about nothing.
	it("refuses a manifest read that failed", async () => {
		const out = await run([[/^git show \w+:\S+\.yaml$/, errOut("fatal: bad object")]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain('every pin is UNKNOWN, never "unpinned"');
	});

	it("refuses a manifest that does not parse as YAML", async () => {
		const out = await run([[/^git show \w+:\S+\.yaml$/, okOut("catalog:\n\tacme-queue: 4.2.0\n")]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("Tabs");
	});

	// The three unreadable catalog shapes, at the exit code a caller actually reads. Each parses as
	// YAML and each carries a catalog the reader does not comprehend, so the verb refuses instead of
	// answering — and in particular never claims the manifest "carries no catalog: or catalogs: map".
	const manifest = (yaml: string): Script => [[/^git show \w+:\S+\.yaml$/, okOut(yaml)]];

	it("reads flow and named-only maps through the command", async () => {
		for (const text of [
			"catalog: {acme-queue: 4.2.0}\n",
			"catalogs:\n  current: {acme-queue: 4.2.0}\n",
		]) {
			const out = await run(manifest(text));
			expect(out.code).toBe(0);
			expect(out.stdout).toContain("pkg\tacme-queue\t4.1.0\t4.2.0\tmoved");
		}
	});
	it("refuses a nested sub-map instead of answering moved", async () => {
		const out = await run(manifest("catalog:\n  acme-queue:\n    version: 4.2.0\n"));
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("pins no version");
	});
	it("resolves unique pins despite unrelated conflicts in the current workspace shape", async () => {
		const text =
			"catalog: {acme-queue: 4.1.0, effect: 4.0.0-beta.92}\ncatalogs:\n  local: {effect: 4.0.0-rc.112, fzf: 0.5.2}\n";
		const out = await run(manifest(text));
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("pkg\tacme-queue\t4.1.0\t4.1.0\tmatched");
		const plain = await run(manifest(text), {slug: "plain-doc"});
		expect(plain.code).toBe(0);
		expect(plain.stdout).toBe("anchor\tunanchored\t0\t0\t0\t0\n");
	});
	it("accepts equal pins but refuses conflicting declared pins", async () => {
		expect.assertions(5);
		for (const version of ["4.1.0", "4.2.0"]) {
			const out = await run(
				manifest(`catalog: {acme-queue: 4.1.0}\ncatalogs:\n  legacy: {acme-queue: ${version}}\n`),
			);
			if (version === "4.1.0") {
				expect(out.code).toBe(0);
				expect(out.stdout).toContain("pkg\tacme-queue\t4.1.0\t4.1.0\tmatched");
			} else {
				expect(out.code).toBe(PRECONDITION_UNKNOWN);
				expect(out.stdout).toBe("");
				expect(out.stderr.at(-1)).toContain(
					"acme-queue has conflicting catalog pins: 4.1.0, 4.2.0",
				);
			}
		}
	});
	it("keeps malformed declarations and invalid manifests distinct from unanchored", async () => {
		const malformed = await run([
			...manifest("catalogs: {local: {acme-queue: 4.1.0}}\n"),
			[/^git show \w+:\S+\.md$/, okOut("> Derived from broken\n")],
		]);
		expect(malformed.code).toBe(0);
		expect(malformed.stdout).toContain("anchor\tmalformed\t1\t0\t0\t1");
		const invalid = await run(manifest("catalogs: []\n"), {slug: "plain-doc"});
		expect(invalid.code).toBe(PRECONDITION_UNKNOWN);
		expect(invalid.stdout).toBe("");
	});
	// The degrade path: a repo that pins nothing centrally is a fact about that repo, not a failure.
	it("degrades to `unpinned` at exit 0 when the manifest is absent, and says so on stderr", async () => {
		const out = await run([[/^git ls-tree --name-only \w+ -- \S+\.yaml$/, okOut("")]]);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe("anchor\tunpinned\t2\t0\t2\t0");
		expect(out.stderr.join("\n")).toContain("is absent at");
	});

	it("degrades the same way for a manifest that parses and carries no catalog map", async () => {
		const out = await run([[/^git show \w+:\S+\.yaml$/, okOut("packages:\n  - packages/*\n")]]);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe("anchor\tunpinned\t2\t0\t2\t0");
		expect(out.stderr.join("\n")).toContain("carries no catalog: or catalogs: map");
	});

	// `unborn` mirrors `pattern drift` deliberately: one tree state must not produce two verdicts.
	it("answers `unborn` for a doc in the working tree and absent at the base", async () => {
		const out = await run(
			[[/^git ls-tree --name-only \w+ -- \S+\.md$/, okOut("")]],
			{},
			{
				[`${DIR}/worker-queue-retry.md`]: "# New\n",
			},
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("anchor\tunborn\t0\t0\t0\t0\n");
	});

	it("refuses a slug with no doc anywhere on the same code pattern drift uses", async () => {
		const out = await run([[/^git ls-tree --name-only \w+ -- \S+\.md$/, okOut("")]], {
			slug: "no-such-doc",
		});
		expect(out.code).toBe(DOC_ABSENT);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain('no doc for slug "no-such-doc"');
	});
});
