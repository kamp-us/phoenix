import {Effect, Result} from "effect";
import {Command} from "effect/unstable/cli";
import {describe, expect, it} from "vitest";
import type {RegisteredTool} from "./registry.ts";
import {registeredTools} from "./registry.ts";
import {dispatch, NoToolError, toolNames, UnknownToolError} from "./router.ts";

// Two stand-in tools so the dispatch contract is tested against a known fixture
// registry, independent of whatever Phase-1/Phase-2 tools the real registry holds.
const alpha = Command.make("alpha", {}, () => Effect.void);
const beta = Command.make("beta", {}, () => Effect.void);
const fixture: ReadonlyArray<RegisteredTool> = [alpha, beta];

describe("dispatch", () => {
	it("selects the tool whose name matches the first argv token", () => {
		const r = dispatch(fixture, ["beta", "--flag", "x"]);
		expect(Result.isSuccess(r)).toBe(true);
		if (Result.isSuccess(r)) {
			expect(r.success.tool).toBe(beta);
			// the router passes the remaining tokens through untouched (the tool's own args)
			expect(r.success.rest).toEqual(["--flag", "x"]);
		}
	});

	it("selects the first-listed tool for its name", () => {
		const r = dispatch(fixture, ["alpha"]);
		expect(Result.isSuccess(r)).toBe(true);
		if (Result.isSuccess(r)) {
			expect(r.success.tool).toBe(alpha);
			expect(r.success.rest).toEqual([]);
		}
	});

	it("fails with an UnknownToolError naming the offender and the known set", () => {
		const r = dispatch(fixture, ["nope"]);
		expect(Result.isFailure(r)).toBe(true);
		if (Result.isFailure(r)) {
			expect(r.failure).toBeInstanceOf(UnknownToolError);
			const e = r.failure as UnknownToolError;
			expect(e.tool).toBe("nope");
			expect(e.known).toEqual(["alpha", "beta"]);
			expect(e.message).toContain("unknown tool");
			expect(e.message).toContain("nope");
		}
	});

	it("fails with a NoToolError when argv is empty", () => {
		const r = dispatch(fixture, []);
		expect(Result.isFailure(r)).toBe(true);
		if (Result.isFailure(r)) {
			expect(r.failure).toBeInstanceOf(NoToolError);
			expect(r.failure.message).toContain("no tool given");
		}
	});
});

describe("toolNames", () => {
	it("lists the registered tool names in registry order", () => {
		expect(toolNames(fixture)).toEqual(["alpha", "beta"]);
	});
});

describe("the real registry", () => {
	it("registers the Phase-1 tracer tool `version`", () => {
		// AC: the router lists/dispatches the registered subcommand(s). The tracer
		// is registered like any tool — present in the registry, dispatchable by name.
		expect(toolNames(registeredTools)).toContain("version");
		const r = dispatch(registeredTools, ["version"]);
		expect(Result.isSuccess(r)).toBe(true);
		if (Result.isSuccess(r)) {
			expect(r.success.tool.name).toBe("version");
		}
	});
});
