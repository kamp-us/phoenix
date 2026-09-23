import {Effect, Path} from "effect";
import {describe, expect, it} from "vitest";
import type {FloorSource} from "./cli-floor.ts";
import {PLUGIN_ROOT_ENV, runCliFloor} from "./cli-floor-verb.ts";
import {FLOOR_UNKNOWN} from "./codes.ts";

const run = (
	installed: string,
	floor: FloorSource,
	env: Record<string, string | undefined> = {[PLUGIN_ROOT_ENV]: "/plugin"},
) => {
	const reads: string[] = [];
	const outcome = Effect.runSync(
		runCliFloor({
			installed,
			env,
			read: (path) => {
				reads.push(path);
				return Effect.succeed(floor);
			},
		}).pipe(Effect.provide(Path.layer)),
	);
	return {outcome, reads};
};

const floor: FloorSource = {_tag: "Text", text: JSON.stringify({minimum: "0.7.1"})};

describe("hook cli-floor", () => {
	it("reads the floor file under the plugin root", () => {
		expect(run("0.7.1", floor).reads).toEqual(["/plugin/cli-floor.json"]);
	});

	it("puts the warning in systemMessage when the CLI is older", () => {
		const {outcome} = run("0.5.0", floor);
		expect(outcome.code).toBe(0);
		const out = JSON.parse(outcome.stdout);
		expect(out.systemMessage).toContain("v0.5.0");
		expect(out.systemMessage).toContain("v0.7.1");
		expect(out.fabrika).toEqual({
			verb: "hook cli-floor",
			outcome: "below",
			installed: "0.5.0",
			minimum: "0.7.1",
		});
	});

	it.each(["0.7.1", "0.8.0"])("shows the user nothing at v%s", (installed) => {
		const {outcome} = run(installed, floor);
		expect(outcome.code).toBe(0);
		const out = JSON.parse(outcome.stdout);
		expect(out).not.toHaveProperty("systemMessage");
		expect(out.suppressOutput).toBe(true);
		expect(out.fabrika.outcome).toBe("met");
	});

	it("refuses UNKNOWN on an unreadable floor, with nothing on stdout", () => {
		const {outcome} = run("0.7.1", {_tag: "Unreadable", reason: "ENOENT"});
		expect(outcome.code).toBe(FLOOR_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("ENOENT");
	});

	it.each<[string, Record<string, string | undefined>]>([
		["unset", {}],
		["blank", {[PLUGIN_ROOT_ENV]: " "}],
	])("refuses UNKNOWN with the plugin root %s, and reads nothing", (_label, env) => {
		const result = run("0.7.1", floor, env);
		expect(result.outcome.code).toBe(FLOOR_UNKNOWN);
		expect(result.outcome.stderr.join("\n")).toContain(PLUGIN_ROOT_ENV);
		expect(result.reads).toEqual([]);
	});
});
