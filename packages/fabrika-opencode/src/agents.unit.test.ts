import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {parseAgentMarkdown} from "./agents.ts";

const AGENT_SHELLS_DIR = join(import.meta.dirname, "../../../.opencode/agent");

describe("parseAgentMarkdown", () => {
	it("maps frontmatter fields and the body prompt", () => {
		const shell = parseAgentMarkdown(
			[
				"---",
				"name: builder",
				"description: The construction stage.",
				"mode: subagent",
				"---",
				"",
				"Body line one.",
				"Body line two.",
			].join("\n"),
		);
		expect(shell.name).toBe("builder");
		expect(shell.description).toBe("The construction stage.");
		expect(shell.mode).toBe("subagent");
		expect(shell.prompt).toBe("Body line one.\nBody line two.");
	});

	it("defaults a missing mode to undefined so the entry defaults to subagent", () => {
		const shell = parseAgentMarkdown(["---", "name: x", "---", "prompt"].join("\n"));
		expect(shell.mode).toBeUndefined();
	});

	it("carries a nested permission block through untouched", () => {
		const shell = parseAgentMarkdown(
			["---", "name: operator", "permission:", "  edit: deny", "---", "body"].join("\n"),
		);
		expect(shell.permission).toEqual({edit: "deny"});
	});

	it("refuses markdown without frontmatter, without a body, or without a name", () => {
		expect(() => parseAgentMarkdown("no fence here")).toThrow(/frontmatter/);
		expect(() => parseAgentMarkdown("---\nname: x\n---")).toThrow(/empty prompt/);
		expect(() => parseAgentMarkdown("---\ndescription: y\n---\nbody")).toThrow(/no name/);
	});

	it("refuses a mode outside the literal set", () => {
		expect(() => parseAgentMarkdown("---\nname: x\nmode: chief\n---\nbody")).toThrow(
			/not a mode literal/,
		);
	});
});

describe("authored agent shell mirrors", () => {
	const mirrors = readdirSync(AGENT_SHELLS_DIR)
		.filter((entry) => entry.endsWith(".md"))
		.sort();

	it("the authored mirror dir is non-empty", () => {
		expect(mirrors.length).toBeGreaterThan(0);
	});

	it.each(mirrors)("%s parses into a named subagent shell", (file) => {
		const shell = parseAgentMarkdown(readFileSync(join(AGENT_SHELLS_DIR, file), "utf8"));
		expect(shell.name).toBe(file.replace(/\.md$/, ""));
		expect(shell.mode ?? "subagent").toBe("subagent");
		expect(shell.description).toBeTruthy();
		expect(shell.prompt.length).toBeGreaterThan(0);
	});
});
