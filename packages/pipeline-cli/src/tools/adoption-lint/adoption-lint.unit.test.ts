import {assert, describe, it} from "@effect/vitest";
import {
	type Exemption,
	isReDerivedWithoutCitation,
	isZeroScope,
	lintAdoption,
	type OwnedDecision,
	type ScanFile,
} from "./adoption-lint.ts";

// A representative tool-owned decision: the `verdict read` fingerprint is the
// co-occurrence of the gate-marker regex, the write+ ACL loop, and a latest-wins
// resolution; a compliant file cites `pipeline-cli verdict`.
const VERDICT: OwnedDecision = {
	verb: "verdict read",
	signature: [/review-\((?:code|doc|skill)/, /collaborators\//, /sort_by\(|\blast\b/],
	citation: /pipeline-cli\s+verdict\b/,
	reason: "re-derives the verdict-marker resolution `pipeline-cli verdict read` owns",
};

// A file that hand-copies the whole procedure inline (all three tells present).
const RE_DERIVATION = [
	"gh api repos/$REPO/issues/$PR/comments",
	"  --jq '.[] | select(.body | test(\"review-(code|doc|skill): (PASS|FAIL)\"))'",
	"perm=$(gh api repos/$REPO/collaborators/$a/permission --jq .permission)",
	"latest=$(echo \"$markers\" | jq 'sort_by(.created_at) | last')",
].join("\n");

// The same procedure, but the file cites the owning verb by contract.
const CITES = `${RE_DERIVATION}\n# see \`pipeline-cli verdict read --pr N --gate g\` — the owning verb`;

// Only one tell present — an incidental mention, not a full re-derivation.
const INCIDENTAL = "a note about a review-(code|doc) marker, nothing else";

describe("isReDerivedWithoutCitation — the AND-of-tells fingerprint", () => {
	it("is true when every signature tell matches and the verb is not cited", () => {
		assert.isTrue(isReDerivedWithoutCitation(RE_DERIVATION, VERDICT));
	});

	it("is false when the file cites the owning verb by contract", () => {
		assert.isFalse(isReDerivedWithoutCitation(CITES, VERDICT));
	});

	it("is false when only some tells match (an incidental mention, not a copy)", () => {
		assert.isFalse(isReDerivedWithoutCitation(INCIDENTAL, VERDICT));
	});
});

describe("lintAdoption — findings, exemptions, zero scope", () => {
	it("flags a corpus file that inline-re-derives a tool-owned decision without citing it", () => {
		const files: ScanFile[] = [{file: "skills/a/SKILL.md", content: RE_DERIVATION}];
		const result = lintAdoption(files, [VERDICT], []);
		assert.lengthOf(result.findings, 1);
		assert.strictEqual(result.findings[0]?.verb, "verdict read");
		assert.deepStrictEqual(result.scanned, ["skills/a/SKILL.md"]);
	});

	it("passes a file that cites the verb by contract", () => {
		const files: ScanFile[] = [{file: "skills/b/SKILL.md", content: CITES}];
		const result = lintAdoption(files, [VERDICT], []);
		assert.lengthOf(result.findings, 0);
		assert.lengthOf(result.exemptionFindings, 0);
	});

	it("clears a re-derivation covered by a valid grandfathered exemption, and reports it as exempted", () => {
		const files: ScanFile[] = [{file: "skills/heal-ci/SKILL.md", content: RE_DERIVATION}];
		const exemptions: Exemption[] = [
			{
				kind: "grandfathered",
				path: "skills/heal-ci/SKILL.md",
				verb: "verdict read",
				reason: "existing copy — migrate with #3265",
			},
		];
		const result = lintAdoption(files, [VERDICT], exemptions);
		assert.lengthOf(result.findings, 0);
		assert.lengthOf(result.exemptionFindings, 0);
		assert.deepStrictEqual(result.exempted, ["skills/heal-ci/SKILL.md"]);
	});

	it("fails a grandfathered exemption that no longer re-derives (migrated) — forces its removal", () => {
		// The file now cites the verb, so the grandfather entry is stale.
		const files: ScanFile[] = [{file: "skills/heal-ci/SKILL.md", content: CITES}];
		const exemptions: Exemption[] = [
			{
				kind: "grandfathered",
				path: "skills/heal-ci/SKILL.md",
				verb: "verdict read",
				reason: "existing copy — migrate with #3265",
			},
		];
		const result = lintAdoption(files, [VERDICT], exemptions);
		assert.lengthOf(result.findings, 0);
		assert.lengthOf(result.exemptionFindings, 1);
		assert.strictEqual(result.exemptionFindings[0]?.kind, "grandfathered");
	});

	it("admits a mirror only for a non-importable execution surface, not a .md doc", () => {
		const files: ScanFile[] = [
			{file: ".claude/workflows/drive-issue.js", content: RE_DERIVATION},
			{file: "skills/x/SKILL.md", content: RE_DERIVATION},
		];
		const good: Exemption[] = [
			{kind: "mirror", path: ".claude/workflows/drive-issue.js", reason: "non-importable"},
		];
		const goodResult = lintAdoption(files, [VERDICT], good);
		// the .js mirror clears its finding; the .md still reds (no exemption)
		assert.lengthOf(goodResult.exemptionFindings, 0);
		assert.deepStrictEqual(
			goodResult.findings.map((f) => f.file),
			["skills/x/SKILL.md"],
		);

		const bad: Exemption[] = [
			{kind: "mirror", path: "skills/x/SKILL.md", reason: "a doc cannot be a mirror"},
		];
		const badResult = lintAdoption(files, [VERDICT], bad);
		assert.lengthOf(badResult.exemptionFindings, 1);
		assert.strictEqual(badResult.exemptionFindings[0]?.kind, "mirror");
	});

	it("fails a declared exemption that names a file not in scope (stale path)", () => {
		const files: ScanFile[] = [{file: "skills/present/SKILL.md", content: CITES}];
		const exemptions: Exemption[] = [
			{kind: "mirror", path: ".claude/workflows/gone.js", reason: "moved away"},
		];
		const result = lintAdoption(files, [VERDICT], exemptions);
		assert.lengthOf(result.exemptionFindings, 1);
		assert.include(result.exemptionFindings[0]?.reason ?? "", "not in scope");
	});
});

describe("isZeroScope — fail closed on either empty axis (ADR 0092)", () => {
	it("is true when no corpus file was scanned", () => {
		const result = lintAdoption([], [VERDICT], []);
		assert.isTrue(isZeroScope(result));
	});

	it("is true when the manifest declares no decision", () => {
		const files: ScanFile[] = [{file: "skills/a/SKILL.md", content: CITES}];
		const result = lintAdoption(files, [], []);
		assert.isTrue(isZeroScope(result));
	});

	it("is false when both axes are non-empty", () => {
		const files: ScanFile[] = [{file: "skills/a/SKILL.md", content: CITES}];
		const result = lintAdoption(files, [VERDICT], []);
		assert.isFalse(isZeroScope(result));
	});
});
