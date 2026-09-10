import {expect, it} from "vitest";
import {codexAttribution, codexIssue} from "./codex-attribution.ts";

it.each([
	["build claim 9000 --issue 8950", 8950],
	["build resume-child 8950", 8950],
	["review criteria 8950", 8950],
	["triage claim 8950", 8950],
	["grill open --ticket 8950", 8950],
	["ship scope 9000", null],
])("associates %s with its issue, never the repair PR", (args, issue) => {
	expect(
		codexIssue({
			hook_event_name: "PreToolUse",
			tool_input: {cmd: `node packages/fabrika-cli/src/bin.ts ${args}`},
		}),
	).toBe(issue);
});
it.each([
	"echo 'fabrika build claim 8950'",
	"echo 'hello\nfabrika build claim 8950'",
	"# fabrika build claim 8950\ngit status",
])("does not bind command text passed as data: %s", (command) => {
	expect(codexAttribution({hook_event_name: "PreToolUse", tool_input: {command}})).toEqual({
		kind: "none",
	});
});
it.each([
	"fabrika review criteria 8950; fabrika review criteria 8951",
	"fabrika review criteria $ISSUE",
	"fabrika review criteria --repo o/r",
	"cat <<'EOF'\nfabrika review criteria 8950\nEOF",
])("reports unresolved work instead of selecting an issue: %s", (command) => {
	expect(codexAttribution({hook_event_name: "PreToolUse", tool_input: {command}})).toEqual({
		kind: "unresolved",
	});
});
it("uses the live scope output for PR-based interactive work", () => {
	expect(
		codexIssue({
			hook_event_name: "PostToolUse",
			tool_input: {cmd: "fabrika ship scope 9000"},
			tool_response: {exit_code: 0, output: "scoped\tabc123\topen\tfixes:8950\nclass\tcode\t2"},
		}),
	).toBe(8950);
	expect(
		codexIssue({
			hook_event_name: "PreToolUse",
			tool_input: {cmd: "echo 'fabrika build claim 8950'"},
		}),
	).toBeNull();
});
