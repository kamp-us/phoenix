/*
 * Repair is selected by a PR number, but not every verb in that round is PR-bound. #7181's live
 * failure used PR #7180 as `build tree --issue`'s operand even though that PR serves issue #7162;
 * the lane proof consequently looked for the wrong claim and refused before the repair began.
 *
 * The executable surface is instruction text, so this test reads the real skill and renders those
 * two distinct identifiers through its repair route. That keeps the regression at the seam an agent
 * actually executes instead of restating `build tree`'s already-correct issue-claim semantics.
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
const rendered = mainRepair
	.replaceAll("$issue_number", String(ISSUE))
	.replaceAll("$pr_number", String(PR));

/** Every fabrika invocation in the main PR-repair route, whether fenced or inline. */
const invocations = mainRepair.match(/fabrika build [^\n`)]+/g) ?? [];

describe("build skill repair identifiers (#7162 / PR #7180)", () => {
	it("has a non-empty main PR-repair route", () => {
		assert.isAtLeast(repairStart, 0);
		assert.isAbove(childRepairStart, repairStart);
		assert.isAtLeast(invocations.length, 1, "repair route has no fabrika invocation");
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

	it("retires the overloaded selector from every repair invocation", () => {
		for (const invocation of invocations) {
			assert.notInclude(invocation, "$issue_or_pr_number");
		}
	});

	it("arms the issue-bound proof only after the existing PR branch is resumed", () => {
		assert.isBelow(
			rendered.indexOf(`fabrika build branch --resume ${PR}`),
			rendered.indexOf(`fabrika build tree --issue ${ISSUE}`),
		);
	});
});
