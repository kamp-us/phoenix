import {describe, expect, it} from "vitest";
import {DEFAULT_PIN} from "../models.ts";
import {decideSpawn, permissionOutput, requestedModelOf} from "./spawn.ts";

const ALLOWED_PIN = "claude-opus-4-8[1m]";

describe("decideSpawn", () => {
	it("allows an allowlisted model", () => {
		const decision = decideSpawn("claude-opus-4-8", ALLOWED_PIN);
		expect(decision._tag).toBe("Allow");
	});

	it("allows an unset model so the spawn inherits the session model", () => {
		const decision = decideSpawn(null, ALLOWED_PIN);
		expect(decision).toMatchObject({_tag: "AllowInherit", pin: ALLOWED_PIN, defaulted: false});
	});

	it("denies an off-allowlist model", () => {
		expect(decideSpawn("fable-5", ALLOWED_PIN)).toMatchObject({_tag: "Deny", explicit: true});
	});

	it("falls back to the committed default when WORKFLOW_MODEL is absent", () => {
		expect(decideSpawn(null, null)).toMatchObject({
			_tag: "AllowInherit",
			pin: DEFAULT_PIN,
			defaulted: true,
		});
	});

	it("allows an alias of an allowlisted model — the harness spells a spawn's model in aliases", () => {
		expect(decideSpawn("opus", ALLOWED_PIN)).toMatchObject({
			_tag: "Allow",
			model: "opus",
			canonical: "claude-opus-4-8",
		});
	});

	it("passes a non-alias through unchanged rather than rejecting it for being unknown", () => {
		// It still denies — but on the allowlist check, which is the branch that owns that call.
		expect(decideSpawn("fable-5", ALLOWED_PIN).checked).toContain("canonical=fable-5");
	});

	it("denies an explicit bad model even when the pin is good — a pin cannot rewrite a request", () => {
		expect(decideSpawn("haiku", ALLOWED_PIN)).toMatchObject({_tag: "Deny", explicit: true});
	});

	it("denies rather than defaulting when the pin is present and off the allowlist", () => {
		expect(decideSpawn(null, "fable-5")).toMatchObject({_tag: "Deny", explicit: false});
	});

	it("names the allowlist, the request, its canonical id and the resolved pin in what it checked", () => {
		const {checked} = decideSpawn("opus", null);
		expect(checked).toContain("allowlist=[claude-opus-4-8, claude-opus-4-8[1m]]");
		expect(checked).toContain("requested=opus");
		expect(checked).toContain("canonical=claude-opus-4-8");
		expect(checked).toContain("WORKFLOW_MODEL=<unset>");
		expect(checked).toContain(`effectivePin=${DEFAULT_PIN} (committed default)`);
	});
});

describe("requestedModelOf", () => {
	it("reads tool_input.model", () => {
		expect(requestedModelOf({tool_input: {model: "opus"}})).toBe("opus");
	});

	it.each([
		["no tool_input", {}],
		["a tool_input that is not an object", {tool_input: "opus"}],
		["a spawn that set no model", {tool_input: {subagent_type: "general-purpose"}}],
		["a model that is not a string", {tool_input: {model: 5}}],
	])("reads %s as unset", (_label, payload) => {
		expect(requestedModelOf(payload)).toBeNull();
	});
});

describe("permissionOutput", () => {
	it("says allow, and names what was checked", () => {
		const output = permissionOutput(decideSpawn("opus", null));
		expect(output.hookSpecificOutput.permissionDecision).toBe("allow");
		expect(output.systemMessage).toContain("allowlist=[claude-opus-4-8, claude-opus-4-8[1m]]");
	});

	it("says deny, and carries the reason the harness shows the caller", () => {
		const output = permissionOutput(decideSpawn("fable-5", null));
		expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
		expect(output.hookSpecificOutput.permissionDecisionReason).toContain(
			"explicit model fable-5 is not on the allowlist",
		);
		expect(output.systemMessage).toContain("DENY fable-5");
	});
});
