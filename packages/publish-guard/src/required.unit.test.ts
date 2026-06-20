import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";
import {
	extractKampusRefs,
	extractUnpublishedInvocations,
	requiredPackages,
	unpublishedInvocationBreaks,
} from "./required.ts";

describe("extractKampusRefs (pure)", () => {
	it("returns every distinct @kampus/<name> slug, sorted and deduped", () => {
		const text = "uses @kampus/epic-ledger and @kampus/decisions-index, again @kampus/epic-ledger";
		assert.deepStrictEqual(extractKampusRefs(text), ["decisions-index", "epic-ledger"]);
	});

	it("returns [] for text with no @kampus/* refs", () => {
		assert.deepStrictEqual(extractKampusRefs("no references here, just @other/pkg"), []);
	});

	it("returns [] for empty text", () => {
		assert.deepStrictEqual(extractKampusRefs(""), []);
	});

	it("matches refs embedded in prose and code spans", () => {
		assert.deepStrictEqual(
			extractKampusRefs("run `node packages/epic-ledger` (the @kampus/epic-ledger CLI)"),
			["epic-ledger"],
		);
	});

	it("extracts an incidental mention the same as any other token (it is a proxy, not the gate)", () => {
		// the CI check name from ship-it's SKILL.md / ADR 0061 — extractKampusRefs is the raw
		// proxy and still matches it; requiredPackages is what filters it out (see below).
		assert.deepStrictEqual(extractKampusRefs("cleanup (web, @kampus/web, true)"), ["web"]);
	});
});

describe("extractUnpublishedInvocations (pure)", () => {
	it("flags a bare `node packages/<pkg>/src/bin*` invocation with no dlx fallback in the same text", () => {
		assert.deepStrictEqual(
			extractUnpublishedInvocations("run `node packages/epic-ledger/src/bin.ts validate`"),
			["epic-ledger"],
		);
	});

	it("does NOT flag a bare-path invocation when the same text carries a `pnpm dlx @kampus/<pkg>` fallback", () => {
		const text =
			"locally `node packages/epic-ledger/src/bin.ts`, in a foreign repo `pnpm dlx @kampus/epic-ledger@latest`";
		assert.deepStrictEqual(extractUnpublishedInvocations(text), []);
	});

	it("matches the bin.ts and the extension-less / variant bin forms", () => {
		assert.deepStrictEqual(
			extractUnpublishedInvocations("node packages/leak-guard/src/bin.check.ts scan"),
			["leak-guard"],
		);
	});

	it("returns [] when there is no bare-path invocation at all", () => {
		assert.deepStrictEqual(
			extractUnpublishedInvocations("just `pnpm dlx @kampus/epic-ledger@latest`"),
			[],
		);
	});

	it("returns [] for empty text", () => {
		assert.deepStrictEqual(extractUnpublishedInvocations(""), []);
	});
});

describe("requiredPackages (over a fixture skills + packages tree)", () => {
	let dir: string;
	let skillsDir: string;
	let packagesDir: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "publish-guard-skills-"));
		skillsDir = join(dir, "skills");
		packagesDir = join(dir, "packages");
		// a skills tree mirroring claude-plugins/kampus-pipeline/skills/**
		mkdirSync(join(skillsDir, "plan-epic"), {recursive: true});
		mkdirSync(join(skillsDir, "review-plan"), {recursive: true});
		mkdirSync(join(skillsDir, "triage", "nested"), {recursive: true});
		writeFileSync(
			join(skillsDir, "plan-epic", "SKILL.md"),
			"the planner runs @kampus/epic-ledger to validate the ledger",
			"utf8",
		);
		writeFileSync(
			join(skillsDir, "review-plan", "SKILL.md"),
			"cross-check against @kampus/decisions-index and @kampus/epic-ledger",
			"utf8",
		);
		// a deeply-nested file is still scanned (recursive walk)
		writeFileSync(
			join(skillsDir, "triage", "nested", "helper.md"),
			"another @kampus/decisions-index mention",
			"utf8",
		);
		// a file with no refs contributes nothing
		writeFileSync(
			join(skillsDir, "triage", "SKILL.md"),
			"plain skill with no package refs",
			"utf8",
		);
		// an incidental mention of a non-package app worker: the ship-it check name.
		// @kampus/web → apps/web, never an npm package — must NOT become required-published.
		mkdirSync(join(skillsDir, "ship-it"), {recursive: true});
		writeFileSync(
			join(skillsDir, "ship-it", "SKILL.md"),
			"the GitHub check is named `cleanup (web, @kampus/web, true)` verbatim",
			"utf8",
		);
		// the real packages: epic-ledger and decisions-index exist; web does NOT (it's apps/web).
		mkdirSync(join(packagesDir, "epic-ledger"), {recursive: true});
		writeFileSync(
			join(packagesDir, "epic-ledger", "package.json"),
			JSON.stringify({name: "@kampus/epic-ledger"}),
			"utf8",
		);
		mkdirSync(join(packagesDir, "decisions-index"), {recursive: true});
		writeFileSync(
			join(packagesDir, "decisions-index", "package.json"),
			JSON.stringify({name: "@kampus/decisions-index"}),
			"utf8",
		);
	});

	afterAll(() => {
		rmSync(dir, {recursive: true, force: true});
	});

	it("returns only text-derived slugs that resolve to an existing packages/<slug>", () => {
		assert.deepStrictEqual(requiredPackages(skillsDir, packagesDir), [
			"decisions-index",
			"epic-ledger",
		]);
	});

	it("excludes an incidental @kampus/web mention (no packages/web — it is apps/web)", () => {
		assert.notInclude(requiredPackages(skillsDir, packagesDir), "web");
	});

	it("returns [] for a missing/unreadable skills directory (never crashes)", () => {
		assert.deepStrictEqual(requiredPackages(join(dir, "does-not-exist"), packagesDir), []);
	});

	it("returns [] when no text-derived slug resolves to a packages/<slug>", () => {
		const emptyPackages = join(dir, "no-packages");
		assert.deepStrictEqual(requiredPackages(skillsDir, emptyPackages), []);
	});
});

describe("unpublishedInvocationBreaks (over a fixture skills tree)", () => {
	let dir: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "publish-guard-breaks-"));
		mkdirSync(join(dir, "broken"), {recursive: true});
		mkdirSync(join(dir, "safe"), {recursive: true});
		// a skill that runs the bare path with NO published fallback → foreign-repo break
		writeFileSync(
			join(dir, "broken", "SKILL.md"),
			"validate the ledger: `node packages/epic-ledger/src/bin.ts validate`",
			"utf8",
		);
		// a skill that runs the bare path AND documents the dlx fallback → safe
		writeFileSync(
			join(dir, "safe", "SKILL.md"),
			"locally `node packages/decisions-index/src/bin.ts`, foreign repo `pnpm dlx @kampus/decisions-index@latest`",
			"utf8",
		);
	});

	afterAll(() => {
		rmSync(dir, {recursive: true, force: true});
	});

	it("flags a bare-path invocation lacking a fallback, skips one that has it", () => {
		assert.deepStrictEqual(unpublishedInvocationBreaks(dir), ["epic-ledger"]);
	});

	it("returns [] for a missing/unreadable directory (never crashes)", () => {
		assert.deepStrictEqual(unpublishedInvocationBreaks(join(dir, "does-not-exist")), []);
	});
});

describe("requiredPackages + unpublishedInvocationBreaks (over the real skills tree)", () => {
	const repoRoot = join(import.meta.dirname, "..", "..", "..");
	const skillsDir = join(repoRoot, "claude-plugins", "kampus-pipeline", "skills");
	const packagesDir = join(repoRoot, "packages");

	it("derives exactly {decisions-index, epic-ledger} from the live plugin skills", () => {
		assert.deepStrictEqual(requiredPackages(skillsDir, packagesDir), [
			"decisions-index",
			"epic-ledger",
		]);
	});

	it("flags no unpublished-fallback break on the live tree (every bare-path invocation has a dlx fallback)", () => {
		assert.deepStrictEqual(unpublishedInvocationBreaks(skillsDir), []);
	});
});
