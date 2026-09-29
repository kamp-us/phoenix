import {type ChildProcess, spawn, spawnSync} from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {NodeFileSystem} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {subagentExtensionPaths} from "@kampus/tuval-pi/server";
import {sessionListProgram} from "@kampus/tuval-sdk/kernel/ai-agent/session-list";
import {Features} from "@kampus/tuval-sdk/kernel/feature-flags";
import {featuresDefault, type TuvalFeatures} from "@kampus/tuval-sdk/kernel/features";
import {ProcessTable} from "@kampus/tuval-sdk/kernel/process/ProcessTable";
import {homeStateDir, PROJECT_MARKER} from "@kampus/tuval-sdk/kernel/state-dir";
import {Context, Effect, Layer, Schema} from "effect";
import {afterEach, expect} from "vitest";
import {
	boot,
	coreSpells,
	defaultGlobalConfig,
	type Kernel,
	projectConfig,
	projectDir,
} from "./boot.ts";
import {ProjectId} from "./project-id.ts";
import {DESK_SDK_VERSION} from "./sdk-admission.ts";
import {ShellDispatch} from "./shell/commands/dispatch.ts";
import {shellSpells} from "./shell/commands/spells.ts";
import type {ShellMsg} from "./shell/core/index.ts";
import {windows} from "./shell/layout/index.ts";
import {shellId, shellStateOf} from "./shell/program.ts";

/**
 * Every boot registers these, whatever the config declares: the kernel's own spells and the command
 * rows riding on the shell the desk supplies (#7555, #9683). No fixture program declares a spell.
 */
const DESK_SPELLS = coreSpells.length + shellSpells.length;
/** The shell row every boot carries below its config files (`./desk-layer.ts`). */
const DESK_PROGRAMS = 1;
/** The box config adds the session-list row, which declares `session.list` (#8101). */
const sessionListSpells = sessionListProgram().spells;
if (sessionListSpells === undefined) {
	throw new Error(
		"the session-list row declares spells; the box's spell count is derived from them",
	);
}
const BOX_SPELLS = DESK_SPELLS + sessionListSpells.length;

const fixture = (name: string) =>
	fileURLToPath(new URL(`./config-fixtures/${name}.ts`, import.meta.url));
const bin = fileURLToPath(new URL("./bin.ts", import.meta.url));
/**
 * Tuval's own project config — its demo rows, the session list and the module demo; no shell and
 * no harness rows (#9694) — read as a global layer over a throwaway project.
 */
const boxConfig = fileURLToPath(new URL("../.tuval/tuval.config.ts", import.meta.url));

interface Run {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

/**
 * A refused boot, or `--help`, exits on its own. A boot that succeeds never does, since the desk's
 * shell is always live, so those cases go through `runUntilRunning`.
 */
const run = (args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = process.env): Run =>
	spawnSync(process.execPath, [bin, ...args], {encoding: "utf8", env});

/** How long one `runUntilRunning` waits before it SIGKILLs the child and reports what it captured. */
const SPAWN_GUARD_MS = 15_000;

/**
 * A spawning test's vitest budget must outlast every spawn's guard, or vitest kills the test first
 * and the reader gets a bare `Test timed out` instead of the child's stdout/stderr (#7742). Slack
 * covers the unspawned work — a `bootDirect`, the temp dirs, the assertions.
 *
 * A `spawnSync` case has no guard of its own, and the same arithmetic bounds it: one real `node`
 * child starting the bin off TypeScript source. Vitest's 5000 ms default did not cover that even on
 * an idle machine (#8209), let alone under the parallel lanes of #8119, so every case here that
 * spawns states its budget through this function.
 */
const spawnBudget = (spawns: number) => spawns * SPAWN_GUARD_MS + 5_000;

/**
 * A case that spawns nothing but still does real work — a `bootDirect`, which reads and dynamically
 * imports a TypeScript config and makes a temp project dir. `spawnBudget(0)` would hand it back
 * vitest's own 5000 ms, so it states the sibling file's budget instead (#8119).
 */
const DIRECT_BOOT_MS = 20_000;

/**
 * A boot with live processes stays up until a signal: send SIGINT once it says it is running.
 *
 * It resolves on `close`, not on `exit`, so `stdout` holds everything the child wrote up to EOF —
 * including whatever lands after `tuval: stopping`. See the restart case for why that matters.
 */
const runUntilRunning = (
	args: ReadonlyArray<string>,
	env: NodeJS.ProcessEnv = process.env,
	cwd?: string,
): Promise<Run> =>
	new Promise((resolve, reject) => {
		const child: ChildProcess = spawn(process.execPath, [bin, ...args], {stdio: "pipe", env, cwd});
		let stdout = "";
		let stderr = "";
		let signalled = false;
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`bin never said it was running:\n${stdout}\n${stderr}`));
		}, SPAWN_GUARD_MS);
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

/**
 * The scratch home every case here boots under. Saved state lives under the home dir keyed by the
 * project's absolute path (ADR 0402), so a case that did not name one would write the desk's
 * manifest and checkpoints into the operator's own `~/.tuval`.
 */
const freshHome = () => freshDir("tuval-home-");

/** A project dir holding no files at all — a supported, first-class case (ADR 0402 rule 1). */
const emptyProject = () => freshDir("tuval-project-");

/** A project dir whose `.tuval/` is there but empty: no project config, nothing checkpointed. */
const freshProject = () => {
	const project = emptyProject();
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

/**
 * One checkpointed `counter` process at `version`, written where an older build wrote it: under
 * `<project>/.tuval`. Every case that boots on this is reading the one-time move (ADR 0402 rule 7),
 * because nothing writes there any more.
 */
const seedInProjectState = (project: string, version: string, id = "p-1") => {
	const stateDir = projectDir(project);
	mkdirSync(join(stateDir, "processes"), {recursive: true});
	writeFileSync(
		join(stateDir, "manifest.json"),
		JSON.stringify({processes: [{id, programId: "counter", parentId: null}]}),
	);
	writeFileSync(
		join(stateDir, "processes", `${id}.json`),
		JSON.stringify({programId: "counter", version, state: {count: 3}}),
	);
	return project;
};

const seededProject = (version: string) => seedInProjectState(freshProject(), version);

class TestIo extends Schema.TaggedError<TestIo>()("TestIo", {cause: Schema.Defect()}) {}

const io = <A>(run: () => Promise<A>) =>
	Effect.tryPromise({try: run, catch: (cause) => new TestIo({cause})});

const bootDirect = (global: string, project: string, home: string = freshHome()) =>
	boot({global, project, home}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer));

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

describe("boot", () => {
	it.effect(
		"registers the rows the config module exports and reports their count",
		() =>
			Effect.gen(function* () {
				const home = freshHome();
				const project = freshProject();
				const {report} = yield* bootDirect(fixture("two-rows"), project, home);
				assert.deepStrictEqual(report, {
					sources: [fixture("two-rows")],
					programCount: DESK_PROGRAMS + 2,
					spellCount: DESK_SPELLS,
					bindingCount: 0,
					bindingErrors: [],
					refused: [],
					reopened: [],
					skipped: [],
					stateDir: homeStateDir(project, home),
					adopted: {moved: [], kept: [], unowned: []},
					scoped: {moved: []},
					// The desk's shell: the fixture plans no process of its own.
					processCount: 1,
					restoredCount: 0,
				});
			}),
		DIRECT_BOOT_MS,
	);

	it(
		"runs the desk's shell when the config plans no process of its own",
		async () => {
			const home = freshHome();
			const project = freshProject();
			const result = await runUntilRunning(
				["--config", fixture("two-rows"), "--project", project, "--no-page"],
				{...process.env, HOME: home},
			);
			expect(result.status).toBe(0);
			expect(result.stdout).toContain(
				`tuval: booted — ${DESK_PROGRAMS + 2} program(s), ${DESK_SPELLS} spell(s) registered from ${fixture("two-rows")}; 1 process(es) live, 0 restored from ${homeStateDir(project, home)}\n`,
			);
			expect(result.stdout).toContain(
				"tuval: process shell program=shell parent=- ports=- state=running@0\n",
			);
		},
		spawnBudget(1),
	);

	it(
		"reads ~/.tuval/tuval.config.ts and the cwd's .tuval/tuval.config.ts by default, both merged",
		async () => {
			const home = freshHome();
			mkdirSync(join(home, ".tuval"));
			writeFileSync(
				defaultGlobalConfig(home),
				`export {default} from ${JSON.stringify(fixture("two-rows"))};\n`,
			);
			// Neither layer declares a shell row; the desk supplies one anyway.
			const project = projectWithConfig("one-counter");
			const result = await runUntilRunning(["--no-page"], {...process.env, HOME: home}, project);
			expect(result.stderr).toBe("");
			expect(result.status).toBe(0);
			// The boot line comes first and alone: this boot moved nothing, so the account of what the
			// move left behind has nothing to account for, and the project's config module goes
			// unmentioned.
			expect(result.stdout.split("\n")[0]).toBe(
				`tuval: booted — ${DESK_PROGRAMS + 3} program(s), ${DESK_SPELLS} spell(s) registered from ${defaultGlobalConfig(home)} + ${projectConfig(project)}; 1 process(es) live, 0 restored from ${homeStateDir(project, home)}`,
			);
			expect(result.stdout.split("\n")[1]).toBe(
				"tuval: process shell program=shell parent=- ports=- state=running@0",
			);
		},
		spawnBudget(1),
	);

	// #9375: this folder has no `.tuval` at all, and neither has the home dir. Before the desk
	// supplied its shell, this boot planned no process and the page sat at "Attaching to the Tuval
	// kernel…"; now the shell is live and the page is served over it.
	it(
		"boots the desk's shell and serves the page for a folder with no .tuval folder at all",
		async () => {
			const home = freshHome();
			const project = emptyProject();
			const result = await runUntilRunning(["--project", project], {...process.env, HOME: home});
			expect(result.stderr).toBe("");
			expect(result.status).toBe(0);
			expect(result.stdout).toContain(
				`tuval: booted — ${DESK_PROGRAMS} program(s), ${DESK_SPELLS} spell(s) registered from no config module; 1 process(es) live, 0 restored from ${homeStateDir(project, home)}\n`,
			);
			expect(result.stdout).toContain(
				"tuval: process shell program=shell parent=- ports=- state=running@0\n",
			);
			expect(result.stdout).toContain("tuval: desk at http://");
			expect(readdirSync(project)).toEqual([]);
		},
		spawnBudget(1),
	);

	it(
		"refuses to boot on a project config that still declares the shell, naming the file",
		() => {
			const project = projectWithConfig("declares-shell");
			const result = run(["--project", project], {...process.env, HOME: freshHome()});
			expect(result.status).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe(
				`tuval: refusing to boot — config module ${projectConfig(project)}: declares program row "shell", which the desk supplies itself; remove the row and its graph node\n`,
			);
		},
		spawnBudget(1),
	);

	it(
		"boots the box config: the shell and the two demo processes, the table on the terminal, and all three back after a restart",
		async () => {
			const home = freshHome();
			const env = {...process.env, HOME: home};
			const project = freshProject();
			const args = ["--config", boxConfig, "--project", project];
			const first = await runUntilRunning(args, env);
			expect(first.stderr).toBe("");
			expect(first.status).toBe(0);
			expect(first.stdout).toContain(
				`tuval: booted — 5 program(s), ${BOX_SPELLS} spell(s) registered from ${boxConfig}; 3 process(es) live, 0 restored from ${homeStateDir(project, home)}\n`,
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
			// The stop line says the interrupt landed, not that teardown is over: `bin.ts` prints it
			// from the innermost `onInterrupt`, and the processes stop as the outer scope closes after
			// it, so the demo log's once-a-second `count N` can legally land between the two. That is
			// deliberate, and asserting the stop line was *last* turned it into a random red (#8579).
			// The stop happened: this line is here, after the run line, and `status` above is 0.
			const stopLine = first.stdout.search(/^tuval: stopping$/m);
			expect(stopLine).toBeGreaterThanOrEqual(0);
			expect(stopLine).toBeGreaterThan(
				first.stdout.indexOf("tuval: running — Ctrl-C stops and checkpoints\n"),
			);

			const second = await runUntilRunning(args, env);
			expect(second.status).toBe(0);
			expect(second.stdout).toContain(
				`tuval: booted — 5 program(s), ${BOX_SPELLS} spell(s) registered from ${boxConfig}; 3 process(es) live, 3 restored from ${homeStateDir(project, home)}\n`,
			);
			expect(second.stdout).toContain("tuval: process log program=log parent=counter");
		},
		spawnBudget(2),
	);

	it.effect(
		"restores every checkpointed process from the home-dir state through Demlik's fileStore",
		() =>
			Effect.gen(function* () {
				const home = freshHome();
				const project = seededProject("1.0.0");
				const {report} = yield* bootDirect(fixture("one-counter"), project, home);
				assert.strictEqual(report.processCount, 2);
				assert.strictEqual(report.restoredCount, 1);
				const result = yield* io(() =>
					runUntilRunning(["--config", fixture("one-counter"), "--project", project], {
						...process.env,
						HOME: home,
					}),
				);
				assert.strictEqual(result.status, 0);
				assert.include(
					result.stdout,
					// The shell the direct boot above checkpointed comes back beside the counter.
					`tuval: booted — ${DESK_PROGRAMS + 1} program(s), ${DESK_SPELLS} spell(s) registered from ${fixture("one-counter")}; 2 process(es) live, 2 restored from ${homeStateDir(project, home)}\n`,
				);
				assert.include(
					result.stdout,
					"tuval: process p-1 program=counter parent=- ports=- state=running@0\n",
				);
			}),
		spawnBudget(1),
	);

	it(
		"refuses to boot on a snapshot under another program version, naming the process and both versions",
		() => {
			const project = seededProject("0.9.0");
			const result = run(["--config", fixture("one-counter"), "--project", project], {
				...process.env,
				HOME: freshHome(),
			});
			expect(result.status).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe(
				`tuval: refusing to boot — snapshot for process "p-1" refused: written by counter@0.9.0, the program is now counter@1.0.0\n`,
			);
		},
		spawnBudget(1),
	);

	it(
		"refuses to boot on a throwing config module, naming the module and the reason",
		() => {
			const result = run(["--config", fixture("throws"), "--project", freshProject()], {
				...process.env,
				HOME: freshHome(),
			});
			expect(result.status).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe(
				`tuval: refusing to boot — config module ${fixture("throws")}: module threw while loading: boom at import time\n`,
			);
		},
		spawnBudget(1),
	);

	it(
		"refuses an explicitly named config module that is not there, before boot",
		() => {
			const missing = join(freshProject(), "nope.ts");
			const result = run(["--config", missing]);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(`Path does not exist: ${missing}`);
		},
		spawnBudget(1),
	);

	it.effect(
		"keys each project's state dir off that checkout's absolute path, and records the path in it",
		() =>
			Effect.gen(function* () {
				const home = freshHome();
				const one = freshProject();
				const two = freshProject();
				const first = yield* bootDirect(fixture("two-rows"), one, home);
				const second = yield* bootDirect(fixture("two-rows"), two, home);
				assert.notStrictEqual(first.report.stateDir, second.report.stateDir);
				// The key is a folder name, and an operator reading one back wants the path rather than
				// the substitution that made it: the marker inside the directory is what answers.
				assert.deepStrictEqual(
					JSON.parse(readFileSync(join(first.report.stateDir, PROJECT_MARKER), "utf8")),
					{path: one},
				);
				assert.deepStrictEqual(
					JSON.parse(readFileSync(join(second.report.stateDir, PROJECT_MARKER), "utf8")),
					{path: two},
				);
			}),
		DIRECT_BOOT_MS,
	);

	it.effect(
		"layers the project's config module over the home one and leaves that dir holding config alone",
		() =>
			Effect.gen(function* () {
				const home = freshHome();
				mkdirSync(join(home, ".tuval"));
				writeFileSync(
					defaultGlobalConfig(home),
					`export {default} from ${JSON.stringify(fixture("two-rows"))};\n`,
				);
				const project = projectWithConfig("one-counter");
				const {report} = yield* bootDirect(defaultGlobalConfig(home), project, home);
				assert.deepStrictEqual(report.sources, [defaultGlobalConfig(home), projectConfig(project)]);
				assert.strictEqual(report.programCount, DESK_PROGRAMS + 3);
				assert.deepStrictEqual(readdirSync(projectDir(project)), ["tuval.config.ts"]);
			}),
		DIRECT_BOOT_MS,
	);

	it.effect(
		"moves state an older build left in the project into the home key once, config module aside",
		() =>
			Effect.gen(function* () {
				const home = freshHome();
				const project = seedInProjectState(projectWithConfig("one-counter"), "1.0.0");
				const {report} = yield* bootDirect(fixture("one-counter"), project, home);
				assert.deepStrictEqual([...report.adopted.moved].sort(), ["manifest.json", "processes"]);
				assert.deepStrictEqual(report.adopted.kept, []);
				assert.deepStrictEqual(report.adopted.unowned, ["tuval.config.ts"]);
				assert.strictEqual(report.restoredCount, 1);
				assert.deepStrictEqual(readdirSync(projectDir(project)), ["tuval.config.ts"]);
				assert.isTrue(existsSync(join(report.stateDir, "manifest.json")));
				// Once, not on every boot: the second one finds nothing left to move and restores the
				// same process off the home-dir key.
				const again = yield* bootDirect(fixture("one-counter"), project, home);
				assert.deepStrictEqual(again.report.adopted, {
					moved: [],
					kept: [],
					unowned: ["tuval.config.ts"],
				});
				// The counter, and the shell the first boot checkpointed.
				assert.strictEqual(again.report.restoredCount, 2);
			}),
		DIRECT_BOOT_MS,
	);

	it.effect(
		"refuses a project row outside the desk's SDK range by name and keeps the desk and its other rows running",
		() =>
			Effect.gen(function* () {
				const home = freshHome();
				const project = projectWithConfig("sdk-out-of-range-counter");
				const id = ProjectId.of(project);
				const {report} = yield* bootDirect(fixture("does-not-exist"), project, home);
				assert.deepStrictEqual(
					report.refused.map((refusal) => refusal.message),
					[
						`program "${id.scope("future-counter")}" supports @kampus/tuval-sdk >=1.0.0, and this desk runs ${DESK_SDK_VERSION}; it was not loaded`,
					],
				);
				// The desk's shell and the in-range `main`; nothing was started for `later`.
				assert.strictEqual(report.processCount, 2);
				assert.strictEqual(report.programCount, DESK_PROGRAMS + 1);
			}),
		DIRECT_BOOT_MS,
	);

	it.effect(
		"boots when a project names a global row refused for its SDK range, dropping the nodes that name it",
		() =>
			Effect.gen(function* () {
				const project = projectWithConfig("names-refused-global");
				const {report} = yield* bootDirect(fixture("sdk-out-of-range-counter"), project);
				assert.deepStrictEqual(
					report.refused.map((refusal) => refusal.program),
					["future-counter"],
				);
				// The desk's shell, the global `main` and the project's `own`.
				assert.strictEqual(report.processCount, 3);
				assert.strictEqual(report.programCount, DESK_PROGRAMS + 2);
			}),
		DIRECT_BOOT_MS,
	);

	it.effect(
		"boots on checkpoints saved before project scoping, moving project rows and nodes onto scoped ids once",
		() =>
			Effect.gen(function* () {
				const home = freshHome();
				const project = projectWithConfig("planned-counter");
				const id = ProjectId.of(project);
				// What a build before #9684 saved: the planned node at its bare id, and an ad-hoc child
				// of it, both running the project's `counter` row under its bare id.
				const stateDir = homeStateDir(project, home);
				mkdirSync(join(stateDir, "processes"), {recursive: true});
				writeFileSync(
					join(stateDir, "manifest.json"),
					JSON.stringify({
						processes: [
							{id: "main", programId: "counter", parentId: null},
							{id: "p-1", programId: "counter", parentId: "main"},
						],
					}),
				);
				for (const [process, count] of [
					["main", 5],
					["p-1", 3],
				] as const) {
					writeFileSync(
						join(stateDir, "processes", `${process}.json`),
						JSON.stringify({programId: "counter", version: "1.0.0", state: {count}}),
					);
				}
				const {report} = yield* bootDirect(fixture("does-not-exist"), project, home);
				assert.deepStrictEqual(report.scoped.moved, [
					{from: "main", to: id.scope("main")},
					{from: "p-1", to: "p-1"},
				]);
				// Both came back: the planned node at its scoped id, and its child under it.
				assert.strictEqual(report.restoredCount, 2);
				const manifest = JSON.parse(readFileSync(join(stateDir, "manifest.json"), "utf8"));
				assert.deepStrictEqual(manifest.processes.slice(0, 2), [
					{id: id.scope("main"), programId: id.scope("counter"), parentId: null},
					{id: "p-1", programId: id.scope("counter"), parentId: id.scope("main")},
				]);
				assert.deepStrictEqual(
					JSON.parse(readFileSync(join(stateDir, "processes", `${id.scope("main")}.json`), "utf8"))
						.state,
					{count: 5},
				);
				assert.isFalse(existsSync(join(stateDir, "processes", "main.json")));
				// Once: the next boot finds the directory already scoped and restores off it.
				const again = yield* bootDirect(fixture("does-not-exist"), project, home);
				assert.deepStrictEqual(again.report.scoped.moved, []);
				// The node, its child, and the shell the first boot checkpointed.
				assert.strictEqual(again.report.restoredCount, 3);
			}),
		DIRECT_BOOT_MS,
	);

	it.effect(
		"reads no state back out of the project after the move, whatever is written there next",
		() =>
			Effect.gen(function* () {
				const home = freshHome();
				const project = seededProject("1.0.0");
				yield* bootDirect(fixture("one-counter"), project, home);
				// An older build's leftovers, written again after the move and naming a process the
				// home-dir key has never heard of. A fallback read would spawn it; nothing does.
				seedInProjectState(project, "1.0.0", "p-2");
				const {report} = yield* bootDirect(fixture("one-counter"), project, home);
				assert.deepStrictEqual([...report.adopted.kept].sort(), ["manifest.json", "processes"]);
				assert.deepStrictEqual(report.adopted.moved, []);
				// The counter and the desk's shell, both off the home-dir key; never `p-2`.
				assert.strictEqual(report.processCount, 2);
				assert.strictEqual(report.restoredCount, 2);
				assert.isTrue(existsSync(join(projectDir(project), "processes", "p-2.json")));
				assert.isFalse(existsSync(join(report.stateDir, "processes", "p-2.json")));
			}),
		DIRECT_BOOT_MS,
	);

	it(
		"answers --help with the two flags",
		() => {
			const result = run(["--help"]);
			expect(result.status).toBe(0);
			expect(result.stdout).toContain("--config");
			expect(result.stdout).toContain("--project");
		},
		spawnBudget(1),
	);
});

/**
 * The node-side half of the flag route (#8595). The browser half is `page/dev-server.ts`'s generated
 * module; this half is the kernel service a program row's layer reads at spawn, and the probe below
 * is built the way `ai-agent/backends.ts` builds a backend's layer — under the boot's own kernel
 * context. What `PiAiAgent.layer` does with the record it gets there is `subagentExtensionPaths`,
 * and that its `R` is this service and nothing else is pinned in
 * `@kampus/tuval-pi`'s `src/ai-agent/boundary.unit.test.ts`.
 */
describe("the merged feature flags on the node side", () => {
	class Probe extends Context.Service<Probe, {readonly features: TuvalFeatures}>()(
		"tuval/test/Probe",
	) {}

	/** A layer shaped like a backend's: `Features` left open, satisfied by the spawner's kernel. */
	const probe = Layer.effect(
		Probe,
		Effect.map(Features, (features) => ({features})),
	);

	const flagsAtSpawn = (booted: {readonly kernel: Context.Context<Kernel>}) =>
		Effect.scoped(Layer.build(probe).pipe(Effect.provideContext(booted.kernel))).pipe(
			Effect.map((built) => Context.get(built, Probe).features),
		);

	it.effect(
		"reach a row's layer as the defaults when no layer states one",
		() =>
			Effect.gen(function* () {
				const booted = yield* bootDirect(fixture("two-rows"), freshProject());
				assert.deepStrictEqual(yield* flagsAtSpawn(booted), featuresDefault);
			}),
		DIRECT_BOOT_MS,
	);

	// The direction that costs something: `piSubagents` defaults on, so an operator turning it off is
	// the global layer stating `false` over that default — and before #8595 the row's layer read
	// `featuresDefault` and loaded the extension anyway.
	it.effect(
		"reach a row's layer as the global layer states them",
		() =>
			Effect.gen(function* () {
				const booted = yield* bootDirect(fixture("pi-subagents-off"), freshProject());
				const features = yield* flagsAtSpawn(booted);
				assert.deepStrictEqual(features, {...featuresDefault, piSubagents: false});
				assert.deepStrictEqual(subagentExtensionPaths(features), []);
			}),
		DIRECT_BOOT_MS,
	);
});

describe("a booted desk's key bindings follow focus (#9687)", () => {
	/**
	 * The whole path a key takes in a running desk: a press dispatched into the shell process, routed
	 * over the table its focus selects, and a fired binding's spell run by the host back into the
	 * shell. Each binding splits a window, so what fired is read off the desk's window count.
	 */
	it.live(
		"fires the global binding on an empty window and the board, and the project's only in its window",
		() =>
			Effect.gen(function* () {
				const project = projectWithConfig("project-shell-key");
				const booted = yield* boot({
					global: fixture("global-shell-key"),
					project,
					home: freshHome(),
				});
				const inKernel = <A, E>(effect: Effect.Effect<A, E, Kernel>) =>
					effect.pipe(Effect.provideContext(booted.kernel));
				const send = (msg: ShellMsg) =>
					inKernel(ShellDispatch.use((desk) => desk.dispatch(msg))).pipe(Effect.orDie);
				const ctrl = (key: string): ShellMsg => ({
					type: "keys.press",
					key: {key, ctrlKey: true},
				});
				const windowCount = inKernel(
					Effect.map(
						ProcessTable.use((table) => table.list),
						(rows) => {
							const state = shellStateOf(
								rows.find((row) => row.programId === shellId)?.stateSummary().state,
							);
							const workspace = state?.workspaces[state.activeWorkspace];
							return workspace === undefined ? 0 : [...windows(workspace.layout.root)].length;
						},
					),
				);
				// A fired binding runs on a fiber of its own, so its split lands after the press returns.
				const settlesAt = (count: number) =>
					Effect.gen(function* () {
						for (let tries = 0; tries < 200 && (yield* windowCount) < count; tries += 1) {
							yield* Effect.sleep("10 millis");
						}
						yield* Effect.sleep("100 millis");
						assert.strictEqual(yield* windowCount, count);
					});

				assert.strictEqual(yield* windowCount, 1);
				// The focused window is empty, so it runs the global table: the project's key is not
				// there, and the global one is.
				yield* send(ctrl("g"));
				yield* send(ctrl("y"));
				yield* settlesAt(2);

				yield* send({
					type: "window.bind",
					processId: "process-alpha",
					program: ProjectId.of(project).scope("counter"),
				});
				yield* send(ctrl("g"));
				yield* settlesAt(3);

				// The board is the global config's: the project's key stays out, the global one fires.
				yield* send({type: "desk.board.toggle"});
				yield* send(ctrl("g"));
				yield* settlesAt(3);
				yield* send(ctrl("y"));
				yield* settlesAt(4);
			}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
		DIRECT_BOOT_MS,
	);
});
