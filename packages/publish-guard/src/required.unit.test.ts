import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";
import {extractKampusRefs, requiredPackages} from "./required.ts";

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
});

describe("requiredPackages (over a fixture skills tree)", () => {
	let dir: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "publish-guard-skills-"));
		// a skills tree mirroring claude-plugins/kampus-pipeline/skills/**
		mkdirSync(join(dir, "plan-epic"), {recursive: true});
		mkdirSync(join(dir, "review-plan"), {recursive: true});
		mkdirSync(join(dir, "triage", "nested"), {recursive: true});
		writeFileSync(
			join(dir, "plan-epic", "SKILL.md"),
			"the planner runs @kampus/epic-ledger to validate the ledger",
			"utf8",
		);
		writeFileSync(
			join(dir, "review-plan", "SKILL.md"),
			"cross-check against @kampus/decisions-index and @kampus/epic-ledger",
			"utf8",
		);
		// a deeply-nested file is still scanned (recursive walk)
		writeFileSync(
			join(dir, "triage", "nested", "helper.md"),
			"another @kampus/decisions-index mention",
			"utf8",
		);
		// a file with no refs contributes nothing
		writeFileSync(join(dir, "triage", "SKILL.md"), "plain skill with no package refs", "utf8");
	});

	afterAll(() => {
		rmSync(dir, {recursive: true, force: true});
	});

	it("returns exactly the referenced @kampus/* set, deduped across files", () => {
		assert.deepStrictEqual(requiredPackages(dir), ["decisions-index", "epic-ledger"]);
	});

	it("returns [] for a missing/unreadable directory (never crashes)", () => {
		assert.deepStrictEqual(requiredPackages(join(dir, "does-not-exist")), []);
	});
});

describe("requiredPackages (over the real skills tree)", () => {
	it("derives exactly {decisions-index, epic-ledger} from the live plugin skills", () => {
		const skillsDir = join(
			import.meta.dirname,
			"..",
			"..",
			"..",
			"claude-plugins",
			"kampus-pipeline",
			"skills",
		);
		assert.deepStrictEqual(requiredPackages(skillsDir), ["decisions-index", "epic-ledger"]);
	});
});
