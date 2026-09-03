import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {boot, defaultConfigModule} from "./boot.ts";

const fixture = (name: string) =>
	fileURLToPath(new URL(`./config-fixtures/${name}.ts`, import.meta.url));
const bin = fileURLToPath(new URL("./bin.ts", import.meta.url));

const run = (...args: ReadonlyArray<string>) =>
	spawnSync(process.execPath, [bin, ...args], {encoding: "utf8"});

describe("boot", () => {
	it("registers the rows the config module exports and reports their count", async () => {
		const report = await Effect.runPromise(boot(fixture("two-rows")));
		expect(report).toEqual({configModule: fixture("two-rows"), programCount: 2});
	});

	it("boots from the app-root tuval.config.ts by default and reports an empty registry", () => {
		const result = run();
		expect(result.status).toBe(0);
		expect(result.stdout).toBe(
			`tuval: booted — 0 program(s) registered from ${defaultConfigModule}\n`,
		);
	});

	it("refuses to boot on a throwing config module, naming the module and the reason", () => {
		const result = run(fixture("throws"));
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe(
			`tuval: refusing to boot — config module ${fixture("throws")}: module threw while loading: boom at import time\n`,
		);
	});

	it("refuses to boot on a wrong-shaped config module the same way", () => {
		const result = run(fixture("wrong-shape"));
		expect(result.status).toBe(1);
		expect(result.stderr).toBe(
			`tuval: refusing to boot — config module ${fixture("wrong-shape")}: default export is not a list of program rows (got object)\n`,
		);
	});
});
