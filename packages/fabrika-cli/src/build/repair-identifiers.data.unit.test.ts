/*
 * Repair is selected by a PR number, but not every verb in that round is PR-bound. #7181's live
 * failure used PR #7180 as `build tree --issue`'s operand even though that PR serves issue #7162.
 *
 * The skill has one declared harness argument. The served issue must therefore come from a verb
 * answer, not from a second invented `$<name>` binding. These tests render only that declared
 * argument plus the claim answer's documented metasyntax, which is the executable seam an agent
 * actually receives.
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {assert, describe, it} from "@effect/vitest";

const ISSUE = 7162;
const PR = 7180;

const skill = readFileSync(
	fileURLToPath(
		new URL("../../../../claude-plugins/fabrika/skills/build/SKILL.md", import.meta.url),
	),
	"utf8",
);

const repairStart = skill.indexOf("## Repair");
const childRepairStart = skill.indexOf("**An epic child is repaired too", repairStart);
const mainRepair = skill.slice(repairStart, childRepairStart);
const declaredArguments = new Set(
	(skill.match(/^arguments: \[([^\]]+)]$/m)?.[1] ?? "")
		.split(",")
		.map((argument) => argument.trim())
		.filter(Boolean),
);
const dollarOperands = [...mainRepair.matchAll(/\$([a-z][a-z0-9_]*)/g)].map(
	(match) => match[1] ?? "",
);
const rendered = mainRepair
	.replaceAll("$issue_or_pr_number", String(PR))
	.replaceAll("<served-issue-number>", String(ISSUE));

/** Every fabrika invocation in the main PR-repair route, whether fenced or inline. */
const invocations = mainRepair.match(/fabrika build [^\n`)]+/g) ?? [];

describe("build skill repair identifiers (#7162 / PR #7180)", () => {
	it("has a non-empty main PR-repair route", () => {
		assert.isAtLeast(repairStart, 0);
		assert.isAbove(childRepairStart, repairStart);
		assert.isAtLeast(invocations.length, 1, "repair route has no fabrika invocation");
	});

	it("uses only harness operands declared by the skill", () => {
		assert.deepEqual([...declaredArguments], ["issue_or_pr_number"]);
		for (const operand of dollarOperands) {
			assert.isTrue(declaredArguments.has(operand), `undeclared harness operand: $${operand}`);
		}
	});

	it("obtains the served issue from build claim's deterministic answer", () => {
		assert.include(
			mainRepair,
			"build claim: subject: PR #<pr-number> serves #<served-issue-number>",
		);
		assert.isBelow(
			mainRepair.indexOf("build claim $issue_or_pr_number"),
			mainRepair.indexOf("build tree --issue <served-issue-number>"),
		);
	});

	it("passes the served issue to the armed tree proof, never the PR", () => {
		assert.include(rendered, `fabrika build tree --issue ${ISSUE}`);
		assert.notInclude(rendered, `fabrika build tree --issue ${PR}`);
	});

	it("keeps PR-bound commands on the existing PR and resumes its branch", () => {
		assert.include(rendered, `fabrika build claim ${PR}`);
		assert.include(rendered, `fabrika build verdicts --pr ${PR}`);
		assert.include(rendered, `fabrika build branch --resume ${PR}`);
		assert.include(rendered, `fabrika build note ${PR}`);
		assert.include(rendered, `fabrika build release ${PR}`);
		assert.notMatch(rendered, /fabrika build pr \d+/);
	});

	it("arms the issue-bound proof only after the existing PR branch is resumed", () => {
		assert.isBelow(
			rendered.indexOf(`fabrika build branch --resume ${PR}`),
			rendered.indexOf(`fabrika build tree --issue ${ISSUE}`),
		);
	});
});
