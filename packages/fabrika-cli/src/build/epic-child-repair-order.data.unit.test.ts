/**
 * The epic-child repair route is executable data in the checked-in build skill. `tree --issue`
 * requires the lane branch, while `branch --resume-lane` is the transition that establishes it;
 * pinning their order here prevents a generic isolated checkout from stalling before that transition
 * (#7185).
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

describe("the build skill's epic-child standing-FAIL entry (#7185)", () => {
	it("proves cleanliness before resume-lane and arms lane identity only after checkout", () => {
		assert.deepStrictEqual(standingFailCommands(), [
			"fabrika build claim $issue_or_pr_number --resume",
			"fabrika build verdicts --issue $issue_or_pr_number",
			"fabrika build confirm $issue_or_pr_number --token <claim-token>",
			"fabrika build tree --require-clean",
			"fabrika build branch $issue_or_pr_number --resume-lane --token <claim-token>",
			"fabrika build tree --issue $issue_or_pr_number",
		]);
	});
});
