import {describe, expect, it} from "vitest";
import {argvOf, declaredHooks, violations} from "./declaration.ts";

const oneHook = (command: string) => ({
	hooks: {SessionStart: [{matcher: "startup", hooks: [{type: "command", command}]}]},
});

describe("declaredHooks flattens the declaration", () => {
	it("carries the event and matcher down onto each command", () => {
		expect(declaredHooks(oneHook("fabrika hook check"))).toEqual([
			{event: "SessionStart", matcher: "startup", command: "fabrika hook check"},
		]);
	});

	it.each([
		["a non-object document", 7],
		["a document with no hooks key", {}],
		["a matcher group that is not an array", {hooks: {SessionStart: {}}}],
		[
			"a hook entry with no command string",
			{hooks: {SessionStart: [{hooks: [{type: "command"}]}]}},
		],
	])("contributes no row for %s — zero hooks, which a caller must red on", (_label, document) => {
		expect(declaredHooks(document)).toEqual([]);
	});
});

describe("violations enforce rules 5 and 6 as data", () => {
	it("passes a plain literal fabrika invocation", () => {
		expect(violations(declaredHooks(oneHook("fabrika hook check")))).toEqual([]);
	});

	// biome-ignore-start lint/suspicious/noTemplateCurlyInString: these are shell command strings a
	// hook may not carry — the `${…}` is the subject under test, so turning them into template
	// literals would delete the very thing each row asserts is refused.
	it.each([
		["a $VAR", "fabrika hook check $CLAUDE_PROJECT_DIR"],
		["a ${VAR:-default}", "fabrika hook check ${FOO:-bar}"],
		["a command substitution", "fabrika hook check `pwd`"],
		["a chained command", "fabrika hook check ; rm -rf /"],
		["a pipe", "fabrika hook check | cat"],
		["a source", "source ./hooks/guard.sh"],
		["a redirect", "fabrika hook check > /tmp/out"],
		["a path-addressed script", '"${CLAUDE_PLUGIN_ROOT}"/hooks/guard.sh'],
		["a binary that is not fabrika", "node ./scripts/check.js"],
		// biome-ignore-end lint/suspicious/noTemplateCurlyInString: end of the shell-string rows
	])("refuses %s", (_label, command) => {
		expect(violations(declaredHooks(oneHook(command))).length).toBeGreaterThan(0);
	});

	it("refuses a command naming anything under kampus-pipeline (rule 6, ADR 0238)", () => {
		const found = violations(declaredHooks(oneHook("fabrika hook kampus-pipeline")));
		expect(found.map((v) => v.reason)).toContainEqual(expect.stringContaining("rule 6"));
	});
});

describe("argvOf", () => {
	it("drops the binary name, leaving the group and verb the declaration named", () => {
		expect(argvOf("fabrika hook check")).toEqual(["hook", "check"]);
	});
});
