import {assert, describe, it} from "@effect/vitest";
import {
	checkFrontmatter,
	isFrontmatterScoped,
	isSelfExempt,
	isZeroScope,
	lintCorpus,
	type ScanFile,
	scanFile,
} from "./lint.ts";

// The #1766 trigger, verbatim shape: an unquoted `description:` whose prose carries a
// mid-sentence colon-space (`ritual: pre-flight`) — strict YAML reparses it as a nested
// mapping (the same break GitHub's renderer surfaces on release/SKILL.md, shipper.md).
const BROKEN_FRONTMATTER = [
	"---",
	"name: release",
	"description: run the five-step ritual: pre-flight the flag and flip it live",
	"---",
	"",
	"# release",
].join("\n");

// The durable fix: a quoted scalar. The mid-sentence colon-space can no longer be reparsed.
const QUOTED_FRONTMATTER = [
	"---",
	"name: release",
	'description: "run the five-step ritual: pre-flight the flag and flip it live"',
	"---",
	"",
	"# release",
].join("\n");

// The `>-` folded block scalar form (the release/SKILL.md #1769 fix shape) — also valid.
const FOLDED_FRONTMATTER = [
	"---",
	"name: release",
	"description: >-",
	"  run the five-step ritual: pre-flight the flag and flip it live",
	"---",
	"",
	"# release",
].join("\n");

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
		const result = lintCorpus([{file: "skills/a/SKILL.md", content: FOLDED_FRONTMATTER}]);
		assert.isFalse(isZeroScope(result));
	});
});

describe("isFrontmatterScoped — SKILL.md and agents/*.md carry frontmatter", () => {
	it("scopes a SKILL.md", () => {
		assert.isTrue(isFrontmatterScoped("claude-plugins/kampus-pipeline/skills/release/SKILL.md"));
	});

	it("scopes an agents/<name>.md", () => {
		assert.isTrue(isFrontmatterScoped("claude-plugins/kampus-pipeline/agents/coder.md"));
	});

	it("does NOT scope a non-frontmatter corpus file (a plain doc or script)", () => {
		assert.isFalse(isFrontmatterScoped("skills/foo/notes.md"));
		assert.isFalse(isFrontmatterScoped("skills/foo/helper.sh"));
	});
});

describe("checkFrontmatter — the #1766 gate (red-then-green)", () => {
	// RED: the exact recurring defect — an unquoted description with a mid-sentence
	// colon-space fails the strict-YAML parse (#1281 shipper.md, #1769 release/SKILL.md).
	it("FAILS an unquoted `description:` with a mid-sentence colon-space", () => {
		const finding = checkFrontmatter("skills/release/SKILL.md", BROKEN_FRONTMATTER);
		assert.isNotNull(finding);
		assert.strictEqual(finding?.file, "skills/release/SKILL.md");
		assert.isAbove((finding?.reason ?? "").length, 0);
	});

	// GREEN: the durable per-file fix — a quoted scalar parses clean.
	it("PASSES a quoted `description:` scalar", () => {
		assert.isNull(checkFrontmatter("skills/release/SKILL.md", QUOTED_FRONTMATTER));
	});

	// GREEN: the `>-` folded block scalar (the release/SKILL.md #1769 fix shape) parses clean.
	it("PASSES a `>-` folded block-scalar `description:`", () => {
		assert.isNull(checkFrontmatter("skills/release/SKILL.md", FOLDED_FRONTMATTER));
	});

	it("PASSES an agents/<name>.md with valid frontmatter", () => {
		assert.isNull(checkFrontmatter("agents/coder.md", QUOTED_FRONTMATTER));
	});

	it("does NOT run on a non-frontmatter-scoped file even if its body looks broken", () => {
		assert.isNull(checkFrontmatter("skills/foo/notes.md", BROKEN_FRONTMATTER));
	});

	it("does NOT flag a scoped file with no frontmatter fence (missing ≠ invalid)", () => {
		assert.isNull(checkFrontmatter("skills/foo/SKILL.md", "# just a heading, no fence"));
	});
});

describe("lintCorpus — frontmatter findings + scope (ADR 0092)", () => {
	it("reports a broken-frontmatter file as a frontmatterFinding", () => {
		const result = lintCorpus([{file: "skills/release/SKILL.md", content: BROKEN_FRONTMATTER}]);
		assert.strictEqual(result.frontmatterFindings.length, 1);
		assert.strictEqual(result.frontmatterFindings[0]?.file, "skills/release/SKILL.md");
	});

	it("reports no frontmatterFinding for a corpus whose frontmatter all parses", () => {
		const result = lintCorpus([{file: "skills/release/SKILL.md", content: QUOTED_FRONTMATTER}]);
		assert.strictEqual(result.frontmatterFindings.length, 0);
	});

	it("still frontmatter-checks a gh-call self-exempt skill (exempt from grep ≠ exempt from YAML)", () => {
		// write-code/SKILL.md is self-exempt from the gh-grep, but its frontmatter must still parse.
		const result = lintCorpus([{file: "skills/write-code/SKILL.md", content: BROKEN_FRONTMATTER}]);
		assert.strictEqual(result.findings.length, 0); // grep exempt
		assert.strictEqual(result.frontmatterFindings.length, 1); // frontmatter NOT exempt
		assert.deepStrictEqual([...result.frontmatterScanned], ["skills/write-code/SKILL.md"]);
	});

	it("is zero scope when NO frontmatter-bearing file was handed (frontmatter scope empty)", () => {
		// A corpus of only non-frontmatter files: gh-scan has scope, frontmatter check has none.
		const result = lintCorpus([{file: "skills/foo/helper.sh", content: "echo hi"}]);
		assert.strictEqual(result.frontmatterScanned.length, 0);
		assert.isTrue(isZeroScope(result));
	});
});
