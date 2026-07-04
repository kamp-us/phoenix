import {assert, describe, it} from "@effect/vitest";
import {
	type ClassifyInput,
	classify,
	extractKampusPackages,
	INTEGRATION_RELEVANT_PACKAGES,
	inputFromEnv,
	parseChangedFiles,
	parseTestImportedPackages,
} from "./worker-relevance.ts";

/** A classify input with no lockfile change unless explicitly supplied. */
const input = (over: Partial<ClassifyInput>): ClassifyInput => ({
	changedFiles: [],
	lockfileChanged: false,
	lockfileDiff: "",
	...over,
});

/**
 * A minimal pnpm-v9 lockfile diff that ADDS an importer block for `pkgPath` with one
 * catalog-resolved dep — modelled on PR #1012's real shape: the hunk opens MID-BLOCK
 * (leading context is the tail of a prior importer's deps), the `@@` carries the
 * `importers:` section hint, and the added block + a trailing blank line precede the
 * next importer's context. No shared-section (`packages:`/`catalogs:`) delta.
 */
const importerAddDiff = (pkgPath: string): string =>
	[
		"diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
		"index 1111111..2222222 100644",
		"--- a/pnpm-lock.yaml",
		"+++ b/pnpm-lock.yaml",
		"@@ -686,6 +686,12 @@ importers:",
		"         specifier: 'catalog:'",
		"         version: 4.1.5",
		" ",
		`+  ${pkgPath}:`,
		"+    dependencies:",
		"+      effect:",
		"+        specifier: 'catalog:'",
		"+        version: 4.0.0-beta.78",
		"+",
		"   packages/preview-seed:",
		"     dependencies:",
	].join("\n");

describe("the grounded worker-import closure (issue #1014)", () => {
	it("worker's two import deps + the two own-D1-tier packages are integration-relevant", () => {
		assert.isTrue(INTEGRATION_RELEVANT_PACKAGES.has("db-schema"));
		assert.isTrue(INTEGRATION_RELEVANT_PACKAGES.has("fate-effect"));
		assert.isTrue(INTEGRATION_RELEVANT_PACKAGES.has("preview-seed"));
		assert.isTrue(INTEGRATION_RELEVANT_PACKAGES.has("moderator-grant"));
	});

	it("d1-rest is NOT worker-relevant — the issue guessed wrong; grounded on source", () => {
		assert.isFalse(INTEGRATION_RELEVANT_PACKAGES.has("d1-rest"));
	});

	it("dev-tooling packages are not integration-relevant", () => {
		for (const pkg of ["pipeline-cli", "epic-ledger", "decisions-index", "ci-required"]) {
			assert.isFalse(INTEGRATION_RELEVANT_PACKAGES.has(pkg));
		}
	});
});

describe("AC scenarios (issue #1014) — the four the PR body sanity-checks", () => {
	it("(a) packages/pipeline-cli/** only → irrelevant (integration SKIPPED)", () => {
		const r = classify(
			input({
				changedFiles: ["packages/pipeline-cli/src/router.ts", "packages/pipeline-cli/package.json"],
			}),
		);
		assert.strictEqual(r.verdict, "irrelevant");
	});

	it("(a') pipeline-cli scaffold + a catalog-confined lockfile delta → irrelevant (the #1012 shape)", () => {
		const r = classify(
			input({
				changedFiles: ["packages/pipeline-cli/src/router.ts", "pnpm-lock.yaml"],
				lockfileChanged: true,
				lockfileDiff: importerAddDiff("packages/pipeline-cli"),
			}),
		);
		assert.strictEqual(r.verdict, "irrelevant");
	});

	it("(b) packages/db-schema/** (worker-imported) → relevant (integration RUNS)", () => {
		const r = classify(input({changedFiles: ["packages/db-schema/src/schema.ts"]}));
		assert.strictEqual(r.verdict, "relevant");
		assert.strictEqual(r.trigger, "packages/db-schema/src/schema.ts");
	});

	it("(c) apps/web/** → relevant (integration RUNS)", () => {
		const r = classify(input({changedFiles: ["apps/web/worker/index.ts"]}));
		assert.strictEqual(r.verdict, "relevant");
	});

	it("(d) mixed tooling-pkg + worker path → relevant (integration RUNS)", () => {
		const r = classify(
			input({
				changedFiles: ["packages/pipeline-cli/src/router.ts", "apps/web/worker/index.ts"],
			}),
		);
		assert.strictEqual(r.verdict, "relevant");
		assert.strictEqual(r.trigger, "apps/web/worker/index.ts");
	});
});

describe("own-D1-tier packages keep tripping (AC: preview-seed/moderator-grant)", () => {
	it("packages/preview-seed/** → relevant", () => {
		const r = classify(input({changedFiles: ["packages/preview-seed/src/seed.ts"]}));
		assert.strictEqual(r.verdict, "relevant");
	});

	it("packages/moderator-grant/** → relevant", () => {
		const r = classify(input({changedFiles: ["packages/moderator-grant/src/bin.ts"]}));
		assert.strictEqual(r.verdict, "relevant");
	});
});

describe("fail-safe to running (the load-bearing invariant)", () => {
	it("any apps/** path → relevant", () => {
		assert.strictEqual(
			classify(input({changedFiles: ["apps/web/src/App.tsx"]})).verdict,
			"relevant",
		);
	});

	it("any infra/** path → relevant", () => {
		assert.strictEqual(
			classify(input({changedFiles: ["infra/ci-credentials/index.ts"]})).verdict,
			"relevant",
		);
	});

	it("a root config (not under packages/) → relevant", () => {
		assert.strictEqual(classify(input({changedFiles: ["biome.jsonc"]})).verdict, "relevant");
		assert.strictEqual(classify(input({changedFiles: ["turbo.json"]})).verdict, "relevant");
		assert.strictEqual(
			classify(input({changedFiles: ["pnpm-workspace.yaml"]})).verdict,
			"relevant",
		);
	});

	it("a bare `packages/foo` with no trailing slash → relevant (can't attribute to a dir)", () => {
		assert.strictEqual(
			classify(input({changedFiles: ["packages/pipeline-cli"]})).verdict,
			"relevant",
		);
	});

	it("lockfileChanged=true but empty diff → relevant (can't prove confinement)", () => {
		const r = classify(input({lockfileChanged: true, lockfileDiff: ""}));
		assert.strictEqual(r.verdict, "relevant");
	});

	it("a NEW unknown package under packages/** is irrelevant (worker can't import it without a dep edit)", () => {
		// A brand-new tooling package the worker doesn't list is irrelevant; if it
		// WERE wired into apps/web, apps/web/package.json (a worker path) would also
		// change and flip the verdict to relevant.
		assert.strictEqual(
			classify(input({changedFiles: ["packages/some-new-tool/src/bin.ts"]})).verdict,
			"irrelevant",
		);
	});
});

describe("lockfile attribution — the hard, fail-safe case", () => {
	it("delta confined to a worker-IRRELEVANT importer block → irrelevant", () => {
		const r = classify(
			input({
				changedFiles: ["pnpm-lock.yaml"],
				lockfileChanged: true,
				lockfileDiff: importerAddDiff("packages/epic-ledger"),
			}),
		);
		assert.strictEqual(r.verdict, "irrelevant");
	});

	it("delta inside the apps/web importer block → relevant (worker dep resolution may have moved)", () => {
		const diff = [
			"--- a/pnpm-lock.yaml",
			"+++ b/pnpm-lock.yaml",
			"@@ -149,7 +149,7 @@ importers:",
			" importers:",
			"   apps/web:",
			"     dependencies:",
			"       effect:",
			"-        version: 4.0.0-beta.77",
			"+        version: 4.0.0-beta.78",
		].join("\n");
		const r = classify(
			input({changedFiles: ["pnpm-lock.yaml"], lockfileChanged: true, lockfileDiff: diff}),
		);
		assert.strictEqual(r.verdict, "relevant");
	});

	it("delta inside a worker-RELEVANT package's importer block (db-schema) → relevant", () => {
		const diff = [
			"--- a/pnpm-lock.yaml",
			"+++ b/pnpm-lock.yaml",
			"@@ -385,6 +385,7 @@ importers:",
			" importers:",
			"   packages/db-schema:",
			"     dependencies:",
			"+      drizzle-orm:",
			"+        specifier: 'catalog:'",
			"+        version: 0.44.7",
		].join("\n");
		const r = classify(
			input({changedFiles: ["pnpm-lock.yaml"], lockfileChanged: true, lockfileDiff: diff}),
		);
		assert.strictEqual(r.verdict, "relevant");
	});

	it("delta in the shared `packages:` resolution section → relevant (can re-pin a worker dep)", () => {
		const diff = [
			"--- a/pnpm-lock.yaml",
			"+++ b/pnpm-lock.yaml",
			"@@ -878,6 +878,7 @@ packages:",
			" packages:",
			"+  effect@4.0.0-beta.78:",
			"+    resolution: {integrity: sha512-deadbeef}",
		].join("\n");
		const r = classify(
			input({changedFiles: ["pnpm-lock.yaml"], lockfileChanged: true, lockfileDiff: diff}),
		);
		assert.strictEqual(r.verdict, "relevant");
	});

	it("delta in the shared `catalogs:` section → relevant (a catalog bump flows to the worker)", () => {
		const diff = [
			"--- a/pnpm-lock.yaml",
			"+++ b/pnpm-lock.yaml",
			"@@ -7,7 +7,7 @@ catalogs:",
			" catalogs:",
			"   default:",
			"     effect:",
			"-      version: 4.0.0-beta.77",
			"+      version: 4.0.0-beta.78",
		].join("\n");
		const r = classify(
			input({changedFiles: ["pnpm-lock.yaml"], lockfileChanged: true, lockfileDiff: diff}),
		);
		assert.strictEqual(r.verdict, "relevant");
	});

	it("a delta touching BOTH an irrelevant block AND the apps/web block → relevant (any worker touch wins)", () => {
		const diff = [
			"--- a/pnpm-lock.yaml",
			"+++ b/pnpm-lock.yaml",
			"@@ -149,12 +149,14 @@ importers:",
			" importers:",
			"   apps/web:",
			"     dependencies:",
			"       effect:",
			"-        version: 4.0.0-beta.77",
			"+        version: 4.0.0-beta.78",
			"   packages/epic-ledger:",
			"     dependencies:",
			"+      effect:",
			"+        specifier: 'catalog:'",
			"+        version: 4.0.0-beta.78",
		].join("\n");
		const r = classify(
			input({changedFiles: ["pnpm-lock.yaml"], lockfileChanged: true, lockfileDiff: diff}),
		);
		assert.strictEqual(r.verdict, "relevant");
	});
});

describe("parseChangedFiles + inputFromEnv", () => {
	it("parseChangedFiles splits newline- and NUL-separated lists and trims blanks", () => {
		assert.deepStrictEqual(parseChangedFiles("a.ts\nb.ts\n\n"), ["a.ts", "b.ts"]);
		assert.deepStrictEqual(parseChangedFiles("a.ts\0b.ts\0"), ["a.ts", "b.ts"]);
		assert.deepStrictEqual(parseChangedFiles(""), []);
	});

	it("inputFromEnv derives lockfileChanged from the CHANGED_FILES list", () => {
		const i = inputFromEnv({
			CHANGED_FILES: "packages/pipeline-cli/src/x.ts\npnpm-lock.yaml",
			LOCKFILE_DIFF: importerAddDiff("packages/pipeline-cli"),
		});
		assert.isTrue(i.lockfileChanged);
		assert.deepStrictEqual(
			[...i.changedFiles],
			["packages/pipeline-cli/src/x.ts", "pnpm-lock.yaml"],
		);
	});

	it("inputFromEnv: no lockfile in the list ⇒ lockfileChanged=false", () => {
		const i = inputFromEnv({CHANGED_FILES: "packages/epic-ledger/src/x.ts"});
		assert.isFalse(i.lockfileChanged);
	});

	it("end-to-end via env: the #1012 shape classifies irrelevant", () => {
		const r = classify(
			inputFromEnv({
				CHANGED_FILES: "packages/pipeline-cli/src/router.ts\npnpm-lock.yaml",
				LOCKFILE_DIFF: importerAddDiff("packages/pipeline-cli"),
			}),
		);
		assert.strictEqual(r.verdict, "irrelevant");
	});
});

describe("test-import closure (ADR 0114) — the #1352 hole closes", () => {
	// The real #1352 shape: a package the WORKER never imports but an integration test
	// DOES (founder-seed via kunye-moderate-seam.test.ts). With the test-import closure
	// naming it, its change must now force `relevant` (the integration tier RUNS on the
	// introducing PR), where before the worker-only closure classified it irrelevant.
	const testClosure = new Set(["founder-seed", "authz", "d1-rest", "admin-grant"]);

	it("a founder-seed-only change is relevant when founder-seed is in the test-import closure", () => {
		const r = classify(
			input({
				changedFiles: ["packages/founder-seed/src/seed.ts"],
				testImportedPackages: testClosure,
			}),
		);
		assert.strictEqual(r.verdict, "relevant");
		assert.strictEqual(r.trigger, "packages/founder-seed/src/seed.ts");
	});

	it("the SAME founder-seed change is irrelevant with an EMPTY test-import closure (proves the closure is what flips it)", () => {
		const r = classify(
			input({
				changedFiles: ["packages/founder-seed/src/seed.ts"],
				testImportedPackages: new Set(),
			}),
		);
		assert.strictEqual(r.verdict, "irrelevant");
	});

	it("an omitted testImportedPackages keeps the pre-0114 worker-only behavior (founder-seed irrelevant)", () => {
		const r = classify(input({changedFiles: ["packages/founder-seed/src/seed.ts"]}));
		assert.strictEqual(r.verdict, "irrelevant");
	});

	it("a genuinely-isolated package (in NEITHER closure) stays irrelevant — the skip optimization is preserved", () => {
		const r = classify(
			input({
				changedFiles: ["packages/pipeline-cli/src/router.ts"],
				testImportedPackages: testClosure,
			}),
		);
		assert.strictEqual(r.verdict, "irrelevant");
	});

	it("a lockfile delta confined to a test-imported package's importer block is relevant (the union feeds lockfile attribution too)", () => {
		const r = classify(
			input({
				changedFiles: ["pnpm-lock.yaml"],
				lockfileChanged: true,
				lockfileDiff: importerAddDiff("packages/founder-seed"),
				testImportedPackages: testClosure,
			}),
		);
		assert.strictEqual(r.verdict, "relevant");
	});

	it("the union does not narrow the worker closure — a db-schema change stays relevant regardless of the test closure", () => {
		const r = classify(
			input({
				changedFiles: ["packages/db-schema/src/schema.ts"],
				testImportedPackages: new Set(),
			}),
		);
		assert.strictEqual(r.verdict, "relevant");
	});
});

describe("extractKampusPackages — the pure import extractor (ADR 0114)", () => {
	it('captures the <name> of a static `from "@kampus/x"` import', () => {
		const src = `import {seedFounders} from "@kampus/founder-seed";\nimport {key} from "@kampus/authz";`;
		assert.deepStrictEqual([...extractKampusPackages(src)].sort(), ["authz", "founder-seed"]);
	});

	it("captures single- and double-quoted specifiers and a re-export", () => {
		const src = `import {a} from '@kampus/d1-rest';\nexport {b} from "@kampus/admin-grant";`;
		assert.deepStrictEqual([...extractKampusPackages(src)].sort(), ["admin-grant", "d1-rest"]);
	});

	it("captures dynamic import() and require() specifiers", () => {
		const src = `const m = await import("@kampus/founder-seed");\nconst n = require('@kampus/authz');`;
		assert.deepStrictEqual([...extractKampusPackages(src)].sort(), ["authz", "founder-seed"]);
	});

	it("resolves a subpath specifier to its package <name>", () => {
		assert.deepStrictEqual(
			[...extractKampusPackages(`import x from "@kampus/db-schema/schema";`)],
			["db-schema"],
		);
	});

	it("dedupes repeated imports of the same package", () => {
		const src = `import {a} from "@kampus/authz";\nimport {b} from "@kampus/authz";`;
		assert.deepStrictEqual([...extractKampusPackages(src)], ["authz"]);
	});

	it("ignores a non-@kampus import", () => {
		assert.strictEqual(extractKampusPackages(`import {Effect} from "effect";`).size, 0);
	});
});

describe("parseTestImportedPackages — the bin→core env handoff (ADR 0114)", () => {
	it("splits a comma/newline/NUL list and trims blanks", () => {
		assert.deepStrictEqual(
			[...parseTestImportedPackages("founder-seed,authz\nd1-rest\0admin-grant,, ")].sort(),
			["admin-grant", "authz", "d1-rest", "founder-seed"],
		);
	});

	it("an empty string yields an empty set", () => {
		assert.strictEqual(parseTestImportedPackages("").size, 0);
	});

	it("inputFromEnv threads TEST_IMPORTED_PACKAGES into the classify input", () => {
		const i = inputFromEnv({
			CHANGED_FILES: "packages/founder-seed/src/seed.ts",
			TEST_IMPORTED_PACKAGES: "founder-seed,authz",
		});
		assert.strictEqual(classify(i).verdict, "relevant");
	});
});
