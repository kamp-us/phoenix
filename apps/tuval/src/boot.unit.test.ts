import {spawnSync} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {Effect} from "effect";
import {afterEach, describe, expect, it} from "vitest";
import {boot, defaultConfigModule, defaultStateDir} from "./boot.ts";

const fixture = (name: string) =>
	fileURLToPath(new URL(`./config-fixtures/${name}.ts`, import.meta.url));
const bin = fileURLToPath(new URL("./bin.ts", import.meta.url));

const run = (...args: ReadonlyArray<string>) =>
	spawnSync(process.execPath, [bin, ...args], {encoding: "utf8"});

const stateDirs: string[] = [];
const freshStateDir = () => {
	const dir = mkdtempSync(join(tmpdir(), "tuval-boot-"));
	stateDirs.push(dir);
	return dir;
};

/** A state dir holding one checkpointed `counter` process at `version`. */
const seededStateDir = (version: string) => {
	const dir = freshStateDir();
	mkdirSync(join(dir, "processes"));
	writeFileSync(
		join(dir, "manifest.json"),
		JSON.stringify({processes: [{id: "p-1", programId: "counter", parentId: null}]}),
	);
	writeFileSync(
		join(dir, "processes", "p-1.json"),
		JSON.stringify({programId: "counter", version, state: {count: 3}}),
	);
	return dir;
};

afterEach(() => {
	for (const dir of stateDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

describe("boot", () => {
	it("registers the rows the config module exports and reports their count", async () => {
		const stateDir = freshStateDir();
		const report = await Effect.runPromise(
			boot({configModule: fixture("two-rows"), stateDir}).pipe(Effect.scoped),
		);
		expect(report).toEqual({
			configModule: fixture("two-rows"),
			programCount: 2,
			stateDir,
			restoredCount: 0,
		});
	});

	it("boots from the app-root tuval.config.ts by default and reports an empty registry", () => {
		const result = run();
		expect(result.status).toBe(0);
		expect(result.stdout).toBe(
			`tuval: booted — 0 program(s) registered from ${defaultConfigModule}; 0 process(es) restored from ${defaultStateDir}\n`,
		);
	});

	it("restores every checkpointed process from the state dir through Demlik's fileStore", async () => {
		const stateDir = seededStateDir("1.0.0");
		const report = await Effect.runPromise(
			boot({configModule: fixture("one-counter"), stateDir}).pipe(Effect.scoped),
		);
		expect(report.restoredCount).toBe(1);
		const result = run(fixture("one-counter"), stateDir);
		expect(result.status).toBe(0);
		expect(result.stdout).toBe(
			`tuval: booted — 1 program(s) registered from ${fixture("one-counter")}; 1 process(es) restored from ${stateDir}\n`,
		);
	});

	it("refuses to boot on a snapshot under another program version, naming the process and both versions", () => {
		const stateDir = seededStateDir("0.9.0");
		const result = run(fixture("one-counter"), stateDir);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe(
			`tuval: refusing to boot — snapshot for process "p-1" refused: written by counter@0.9.0, the program is now counter@1.0.0\n`,
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
