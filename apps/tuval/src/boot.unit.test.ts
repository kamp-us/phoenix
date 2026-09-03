import {type ChildProcess, spawn, spawnSync} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {Effect} from "effect";
import {afterEach, describe, expect, it} from "vitest";
import {boot, defaultConfigModule} from "./boot.ts";

const fixture = (name: string) =>
	fileURLToPath(new URL(`./config-fixtures/${name}.ts`, import.meta.url));
const bin = fileURLToPath(new URL("./bin.ts", import.meta.url));

/** A boot that has nothing to run exits on its own. */
const run = (...args: ReadonlyArray<string>) =>
	spawnSync(process.execPath, [bin, ...args], {encoding: "utf8"});

interface Run {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

/** A boot with live processes stays up until a signal: send SIGINT once it says it is running. */
const runUntilRunning = (...args: ReadonlyArray<string>): Promise<Run> =>
	new Promise((resolve, reject) => {
		const child: ChildProcess = spawn(process.execPath, [bin, ...args], {stdio: "pipe"});
		let stdout = "";
		let stderr = "";
		let signalled = false;
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`bin never said it was running:\n${stdout}\n${stderr}`));
		}, 15_000);
		child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
			if (!signalled && stdout.includes("tuval: running")) {
				signalled = true;
				child.kill("SIGINT");
			}
		});
		child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("close", (status) => {
			clearTimeout(timer);
			resolve({status, stdout, stderr});
		});
	});

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
		const {report} = await Effect.runPromise(
			boot({configModule: fixture("two-rows"), stateDir}).pipe(Effect.scoped),
		);
		expect(report).toEqual({
			configModule: fixture("two-rows"),
			programCount: 2,
			stateDir,
			processCount: 0,
			restoredCount: 0,
		});
	});

	it("exits on its own when the config plans no process", () => {
		const stateDir = freshStateDir();
		const result = run(fixture("two-rows"), stateDir);
		expect(result.status).toBe(0);
		expect(result.stdout).toBe(
			`tuval: booted — 2 program(s) registered from ${fixture("two-rows")}; 0 process(es) live, 0 restored from ${stateDir}\n`,
		);
	});

	it("boots the app-root tuval.config.ts by default: two demo processes, the table on the terminal, and both back after a restart", async () => {
		const stateDir = freshStateDir();
		const first = await runUntilRunning(defaultConfigModule, stateDir);
		expect(first.status).toBe(0);
		expect(first.stdout).toContain(
			`tuval: booted — 2 program(s) registered from ${defaultConfigModule}; 2 process(es) live, 0 restored from ${stateDir}\n`,
		);
		expect(first.stdout).toContain(
			"tuval: process counter program=counter parent=- ports=ticks:out(count/v1) state=running@0\n",
		);
		expect(first.stdout).toContain(
			"tuval: process log program=log parent=counter ports=ticks:in(count/v1) state=running@0\n",
		);
		expect(first.stdout).toContain("tuval: running — Ctrl-C stops and checkpoints\n");
		expect(first.stdout.trimEnd().endsWith("tuval: stopping")).toBe(true);

		const second = await runUntilRunning(defaultConfigModule, stateDir);
		expect(second.status).toBe(0);
		expect(second.stdout).toContain(
			`tuval: booted — 2 program(s) registered from ${defaultConfigModule}; 2 process(es) live, 2 restored from ${stateDir}\n`,
		);
		expect(second.stdout).toContain("tuval: process log program=log parent=counter");
	});

	it("restores every checkpointed process from the state dir through Demlik's fileStore", async () => {
		const stateDir = seededStateDir("1.0.0");
		const {report} = await Effect.runPromise(
			boot({configModule: fixture("one-counter"), stateDir}).pipe(Effect.scoped),
		);
		expect(report).toMatchObject({processCount: 1, restoredCount: 1});
		const result = await runUntilRunning(fixture("one-counter"), stateDir);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain(
			`tuval: booted — 1 program(s) registered from ${fixture("one-counter")}; 1 process(es) live, 1 restored from ${stateDir}\n`,
		);
		expect(result.stdout).toContain(
			"tuval: process p-1 program=counter parent=- ports=- state=running@0\n",
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
