/**
 * The epic-child standing-`FAIL` entry is executable data in the checked-in build skill: it must name
 * the mechanized `build resume-child`, and it must not spell the sequence back out beside it.
 *
 * This pin used to assert the six-command order the skill listed. That is exactly what it could not
 * enforce — a resumed builder read the corrected order, ran the armed proof first anyway, and parked
 * epic #7140 while this test was green (#7187). The order now lives in
 * `./resume-child-verb.ts`, under executable coverage in `./resume-child-verb.unit.test.ts`; what is
 * left for a data test is the one claim a data test can make, that the skill routes to the verb
 * rather than back to the pieces.
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {assert, describe, it} from "@effect/vitest";

const BUILD_SKILL = fileURLToPath(
	new URL("../../../../claude-plugins/fabrika/skills/build/SKILL.md", import.meta.url),
);

const standingFailCommands = (): ReadonlyArray<string> => {
	const source = readFileSync(BUILD_SKILL, "utf8");
	const route = source.indexOf("On a standing `FAIL` there is a repair to take");
	assert.isAtLeast(route, 0, "the epic-child standing-FAIL route is absent");

	const fence = source.indexOf("```bash\n", route);
	assert.isAtLeast(fence, 0, "the epic-child standing-FAIL route has no bash fence");
	const commandsStart = fence + "```bash\n".length;
	const fenceEnd = source.indexOf("\n```", commandsStart);
	assert.isAtLeast(fenceEnd, 0, "the epic-child standing-FAIL route has no closing fence");

	return source
		.slice(commandsStart, fenceEnd)
		.split("\n")
		.filter((line) => line.startsWith("fabrika build "));
};

describe("the build skill's epic-child standing-FAIL entry (#7187)", () => {
	it("routes the repair through the mechanized entry, then the builder's own verdict read", () => {
		assert.deepStrictEqual(standingFailCommands(), [
			"fabrika build resume-child $issue_or_pr_number",
			"fabrika build verdicts --issue $issue_or_pr_number",
		]);
	});

	/**
	 * The regression this file exists for now: a later edit re-listing `claim --resume`, `confirm`,
	 * `tree` and `branch --resume-lane` here hands the ordering decision back to the agent, which is
	 * the failure the mechanized entry retired.
	 */
	it("does not reassemble the sequence the entry runs", () => {
		const fenced = standingFailCommands().join("\n");
		for (const piece of ["--resume-lane", "--require-clean", "build confirm", "build claim"]) {
			assert.notInclude(fenced, piece, `the fence spells out "${piece}" instead of resume-child`);
		}
	});
});
