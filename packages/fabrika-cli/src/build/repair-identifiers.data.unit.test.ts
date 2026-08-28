import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {assert, describe, it} from "@effect/vitest";

const ISSUE = 7162;
const PR = 7180;

const readRepoFile = (path: string) =>
	readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), "utf8");

const skill = readRepoFile("claude-plugins/fabrika/skills/build/SKILL.md");
const contract = readRepoFile("claude-plugins/fabrika/skills/build/contract.md");
const repairStart = skill.indexOf("## Repair");
const childRepairStart = skill.indexOf("**An epic child is repaired too", repairStart);
const mainRepair = skill.slice(repairStart, childRepairStart);
const rendered = mainRepair
	.replaceAll("<served-issue>", String(ISSUE))
	.replaceAll("<repair-pr>", String(PR));

/** Every fabrika invocation in the main PR-repair route, whether fenced or inline. */
const invocations = rendered.match(/fabrika build [^\n`)]+/g) ?? [];

describe("build skill repair identifiers (#7162 / PR #7180)", () => {
	it("requires one declared PR and served-issue operand rather than guessing", () => {
		assert.include(mainRepair, "two distinct Ground URLs");
		assert.include(mainRepair, "If the brief does not name exactly one of each, stop `STOPPED`");
		assert.notInclude(mainRepair, "$issue_or_pr_number");
	});

	it("proves the PR claim and served issue together after resuming", () => {
		assert.include(rendered, `fabrika build tree --issue ${ISSUE} --repair ${PR}`);
		assert.notInclude(rendered, `fabrika build tree --issue ${PR}`);
		assert.isBelow(
			rendered.indexOf(`fabrika build branch --resume ${PR}`),
			rendered.indexOf(`fabrika build tree --issue ${ISSUE} --repair ${PR}`),
		);
	});

	it("keeps every PR-scoped command on the existing PR", () => {
		for (const command of ["claim", "note", "release"]) {
			assert.isTrue(
				invocations.some((invocation) => invocation.includes(`build ${command} ${PR}`)),
				`${command} is not PR-bound`,
			);
		}
		assert.include(rendered, `fabrika build verdicts --pr ${PR}`);
		assert.include(rendered, `fabrika build branch --resume ${PR}`);
		assert.notMatch(rendered, /fabrika build pr \d+/);
	});

	it("consumes the documented claim subject and still requires the unique proof", () => {
		assert.include(contract, "build claim: subject: PR #<pr> serves #<issue> (fixes|part-of)");
		assert.include(mainRepair, "Consume it as a cross-check against the two Ground operands");
		for (const defect of ["absent", "malformed", "repeated"]) {
			assert.include(mainRepair, defect);
		}
		assert.include(contract, "refuses zero or several served issues on `4`");
		assert.include(mainRepair, "the live PR uniquely serves the issue");
		assert.include(mainRepair, "Exit `4` means the unique linkage is malformed");
	});
});
