import {assert, describe, it} from "@effect/vitest";
import {isSelfExempt, isZeroScope, lintCorpus, type ScanFile, scanFile} from "./lint.ts";

describe("scanFile — flags GraphQL-path gh calls", () => {
	it("flags `gh project` in a skill body", () => {
		const findings = scanFile(".claude/skills/foo/SKILL.md", "run `gh project list --owner x`");
		assert.isAbove(findings.length, 0);
		assert.include(findings[0]?.matched ?? "", "gh project");
		assert.strictEqual(findings[0]?.line, 1);
	});

	it("flags `gh pr edit`", () => {
		const findings = scanFile("skills/bar/SKILL.md", "first\nuse gh pr edit 5 --body x\n");
		assert.strictEqual(findings.length, 1);
		assert.strictEqual(findings[0]?.line, 2);
	});

	it("flags `gh issue edit`", () => {
		assert.isAbove(scanFile("s/SKILL.md", "gh issue edit 7 --add-project P").length, 0);
	});

	it("flags `gh api graphql`", () => {
		assert.isAbove(scanFile("s/SKILL.md", "gh api graphql -f query='{...}'").length, 0);
	});

	it("does NOT flag a safe `gh api repos/...` REST call", () => {
		assert.strictEqual(scanFile("s/SKILL.md", "gh api repos/o/r/issues/1").length, 0);
	});

	it("does NOT flag prose that mentions projects without the gh verb", () => {
		assert.strictEqual(scanFile("s/SKILL.md", "the project board is classic").length, 0);
	});

	it("self-exempts the write-code skill (it documents the REST-only rule)", () => {
		assert.isTrue(isSelfExempt(".claude/skills/write-code/SKILL.md"));
		assert.strictEqual(
			scanFile("skills/write-code/SKILL.md", "gh pr edit is unreliable").length,
			0,
		);
	});
});

describe("lintCorpus — scope + findings", () => {
	const corpus: ReadonlyArray<ScanFile> = [
		{file: "skills/a/SKILL.md", content: "gh project view"},
		{file: "skills/b/SKILL.md", content: "gh api repos/o/r/issues/1"},
		{file: "skills/write-code/SKILL.md", content: "gh pr edit (documented)"},
	];

	it("scans only the non-exempt files and reports them as scope", () => {
		const result = lintCorpus(corpus);
		assert.deepStrictEqual([...result.scanned], ["skills/a/SKILL.md", "skills/b/SKILL.md"]);
	});

	it("returns the finding from the offending file", () => {
		const result = lintCorpus(corpus);
		assert.strictEqual(result.findings.length, 1);
		assert.strictEqual(result.findings[0]?.file, "skills/a/SKILL.md");
	});
});

describe("isZeroScope — fail-closed on zero scope (ADR 0092)", () => {
	it("reports zero scope when nothing was scanned (empty corpus)", () => {
		assert.isTrue(isZeroScope(lintCorpus([])));
	});

	it("reports zero scope when every handed file was self-exempt", () => {
		const result = lintCorpus([{file: "skills/write-code/SKILL.md", content: "gh pr edit"}]);
		assert.strictEqual(result.scanned.length, 0);
		assert.isTrue(isZeroScope(result));
	});

	it("is NOT zero scope when at least one non-exempt file was scanned", () => {
		const result = lintCorpus([{file: "skills/a/SKILL.md", content: "clean"}]);
		assert.isFalse(isZeroScope(result));
	});
});
