import {describe, expect, it} from "vitest";
import {CODEX_ROLE_SKILLS, codexPrompt, reportedTerminal} from "./codex-dispatch.ts";

describe("Codex dispatch contract", () => {
	it("preloads the UI builder's two construction laws without changing brief bytes", () => {
		expect(CODEX_ROLE_SKILLS["ui-builder"]).toEqual(["build", "build-ui"]);
		const brief = "## Task\n\nbytes with `quotes` and $variables\n";
		const prompt = codexPrompt(["/installed/build/SKILL.md"], brief);
		expect(prompt.endsWith(brief)).toBe(true);
		expect(prompt).toContain('Skill: "/installed/build/SKILL.md"');
	});
	it("rejects absent, duplicate, foreign-task and rewritten terminal histories", () => {
		const prior = {task: "issue", event: "ISSUE.WIP", at: "before"};
		const done = {task: "issue", event: "ISSUE.DONE", at: "after"};
		expect(reportedTerminal([prior], [prior], "issue")).toBeNull();
		expect(reportedTerminal([prior], [prior, done, done], "issue")).toBeNull();
		expect(reportedTerminal([prior], [prior, {...done, task: "other"}], "issue")).toBeNull();
		expect(reportedTerminal([prior], [{...prior, at: "changed"}, done], "issue")).toBeNull();
		expect(reportedTerminal([prior], [prior, done], "issue")).toEqual(done);
	});
});
