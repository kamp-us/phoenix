import {type ChildProcess, spawn, spawnSync} from "node:child_process";
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {NodeFileSystem} from "@effect/platform-node";
import {Effect} from "effect";
import {afterEach, describe, expect, it} from "vitest";
import {boot, defaultGlobalConfig, projectConfig, projectDir} from "./boot.ts";

const fixture = (name: string) =>
	fileURLToPath(new URL(`./config-fixtures/${name}.ts`, import.meta.url));
const bin = fileURLToPath(new URL("./bin.ts", import.meta.url));
/** The config the box ships — the shell plus the two demo rows — read as a global layer over a throwaway project. */
const boxConfig = fileURLToPath(new URL("../.tuval/tuval.config.ts", import.meta.url));

interface Run {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

/** A boot that has nothing to run exits on its own. */
const run = (args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = process.env): Run =>
	spawnSync(process.execPath, [bin, ...args], {encoding: "utf8", env});

/** A boot with live processes stays up until a signal: send SIGINT once it says it is running. */
const runUntilRunning = (
	args: ReadonlyArray<string>,
	env: NodeJS.ProcessEnv = process.env,
): Promise<Run> =>
	new Promise((resolve, reject) => {
		const child: ChildProcess = spawn(process.execPath, [bin, ...args], {stdio: "pipe", env});
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

const tempDirs: string[] = [];
const freshDir = (prefix: string) => {
	// realpath: the bin reports the cwd it is given, and macOS resolves /var to /private/var.
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
};

/** A project dir whose `.tuval/` is empty: no project config, nothing checkpointed. */
const freshProject = () => {
	const project = freshDir("tuval-project-");
	mkdirSync(projectDir(project));
	return project;
};

/** A project dir whose `.tuval/tuval.config.ts` re-exports the named fixture. */
const projectWithConfig = (name: string) => {
	const project = freshProject();
	writeFileSync(
		projectConfig(project),
		`export {default} from ${JSON.stringify(fixture(name))};\n`,
	);
	return project;
};

/** A project dir holding one checkpointed `counter` process at `version`. */
const seededProject = (version: string) => {
	const project = freshProject();
	const stateDir = projectDir(project);
	mkdirSync(join(stateDir, "processes"));
	writeFileSync(
		join(stateDir, "manifest.json"),
		JSON.stringify({processes: [{id: "p-1", programId: "counter", parentId: null}]}),
	);
	writeFileSync(
		join(stateDir, "processes", "p-1.json"),
		JSON.stringify({programId: "counter", version, state: {count: 3}}),
	);
	return project;
};

const bootDirect = (global: string, project: string) =>
	Effect.runPromise(
		boot({global, project}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
	);

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

describe("boot", () => {
	it("registers the rows the config module exports and reports their count", async () => {
		const project = freshProject();
		const {report} = await bootDirect(fixture("two-rows"), project);
		expect(report).toEqual({
			sources: [fixture("two-rows")],
			programCount: 2,
			stateDir: projectDir(project),
			processCount: 0,
			restoredCount: 0,
		});
	});

	it("exits on its own when the config plans no process", () => {
		const project = freshProject();
		const result = run(["--config", fixture("two-rows"), "--project", project]);
		expect(result.status).toBe(0);
		expect(result.stdout).toBe(
			`tuval: booted — 2 program(s) registered from ${fixture("two-rows")}; 0 process(es) live, 0 restored from ${projectDir(project)}\n`,
		);
	});

	it("reads ~/.tuval/tuval.config.ts and the cwd's .tuval/tuval.config.ts by default, both merged", () => {
		const home = freshDir("tuval-home-");
		mkdirSync(join(home, ".tuval"));
		writeFileSync(
			defaultGlobalConfig(home),
			`export {default} from ${JSON.stringify(fixture("two-rows"))};\n`,
		);
		const project = projectWithConfig("one-counter");
		const result = spawnSync(process.execPath, [bin], {
			encoding: "utf8",
			cwd: project,
			env: {...process.env, HOME: home},
		});
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		expect(result.stdout).toBe(
			`tuval: booted — 3 program(s) registered from ${defaultGlobalConfig(home)} + ${projectConfig(project)}; 0 process(es) live, 0 restored from ${projectDir(project)}\n`,
		);
	});

	it("boots with no config module at all: nothing registered, nothing to run", () => {
		const home = freshDir("tuval-home-");
		const project = freshProject();
		const result = run(["--project", project], {...process.env, HOME: home});
		expect(result.status).toBe(0);
		expect(result.stdout).toBe(
			`tuval: booted — 0 program(s) registered from no config module; 0 process(es) live, 0 restored from ${projectDir(project)}\n`,
		);
	});

	it("boots the box config: the shell and the two demo processes, the table on the terminal, and all three back after a restart", async () => {
		const project = freshProject();
		const args = ["--config", boxConfig, "--project", project];
		const first = await runUntilRunning(args);
		expect(first.stderr).toBe("");
		expect(first.status).toBe(0);
		expect(first.stdout).toContain(
			`tuval: booted — 3 program(s) registered from ${boxConfig}; 3 process(es) live, 0 restored from ${projectDir(project)}\n`,
		);
		expect(first.stdout).toContain(
			"tuval: process shell program=shell parent=- ports=- state=running@0\n",
		);
		expect(first.stdout).toContain(
			"tuval: process counter program=counter parent=- ports=ticks:out(count/v1) state=running@0\n",
		);
		expect(first.stdout).toContain(
			"tuval: process log program=log parent=counter ports=ticks:in(count/v1) state=running@0\n",
		);
		expect(first.stdout).toContain("tuval: running — Ctrl-C stops and checkpoints\n");
		expect(first.stdout.trimEnd().endsWith("tuval: stopping")).toBe(true);

		const second = await runUntilRunning(args);
		expect(second.status).toBe(0);
		expect(second.stdout).toContain(
			`tuval: booted — 3 program(s) registered from ${boxConfig}; 3 process(es) live, 3 restored from ${projectDir(project)}\n`,
		);
		expect(second.stdout).toContain("tuval: process log program=log parent=counter");
	});

	it("restores every checkpointed process from the project's state through Demlik's fileStore", async () => {
		const project = seededProject("1.0.0");
		const {report} = await bootDirect(fixture("one-counter"), project);
		expect(report).toMatchObject({processCount: 1, restoredCount: 1});
		const result = await runUntilRunning([
			"--config",
			fixture("one-counter"),
			"--project",
			project,
		]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain(
			`tuval: booted — 1 program(s) registered from ${fixture("one-counter")}; 1 process(es) live, 1 restored from ${projectDir(project)}\n`,
		);
		expect(result.stdout).toContain(
			"tuval: process p-1 program=counter parent=- ports=- state=running@0\n",
		);
	});

	it("refuses to boot on a snapshot under another program version, naming the process and both versions", () => {
		const project = seededProject("0.9.0");
		const result = run(["--config", fixture("one-counter"), "--project", project]);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe(
			`tuval: refusing to boot — snapshot for process "p-1" refused: written by counter@0.9.0, the program is now counter@1.0.0\n`,
		);
	});

	it("refuses to boot on a throwing config module, naming the module and the reason", () => {
		const result = run(["--config", fixture("throws"), "--project", freshProject()]);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe(
			`tuval: refusing to boot — config module ${fixture("throws")}: module threw while loading: boom at import time\n`,
		);
	});

	it("refuses to boot on a wrong-shaped project config the same way", () => {
		const project = projectWithConfig("wrong-shape");
		const result = run(["--project", project], {...process.env, HOME: freshDir("tuval-home-")});
		expect(result.status).toBe(1);
		expect(result.stderr).toBe(
			`tuval: refusing to boot — config module ${projectConfig(project)}: not a v1 config at version: Missing key\n`,
		);
	});

	it("refuses an explicitly named config module that is not there, before boot", () => {
		const missing = join(freshProject(), "nope.ts");
		const result = run(["--config", missing]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(`Path does not exist: ${missing}`);
	});

	it("answers --help with the two flags", () => {
		const result = run(["--help"]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("--config");
		expect(result.stdout).toContain("--project");
	});
});
