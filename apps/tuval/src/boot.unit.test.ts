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
import {Context, Effect, Layer, Schema} from "effect";
import {afterEach, expect} from "vitest";
import {sessionListProgram} from "./ai-agent/session-list.ts";
import {
	boot,
	coreSpells,
	defaultGlobalConfig,
	type Kernel,
	projectConfig,
	projectDir,
} from "./boot.ts";
import {Features} from "./feature-flags.ts";
import {featuresDefault, type TuvalFeatures} from "./features.ts";
import {subagentExtensionPaths} from "./pi/server/index.ts";
import {shellSpells} from "./shell/commands/spells.ts";
import {homeStateDir, PROJECT_MARKER} from "./state-dir.ts";

/** Every boot registers these, whatever the config declares; no fixture program declares a spell. */
const CORE_SPELLS = coreSpells.length;
/**
 * The box config declares the shell, whose command rows ride on its row (#7555), and the
 * session-list row, which declares `session.list` (#8101).
 */
const sessionListSpells = sessionListProgram().spells;
if (sessionListSpells === undefined) {
	throw new Error(
		"the session-list row declares spells; the box's spell count is derived from them",
	);
}
const BOX_SPELLS = CORE_SPELLS + shellSpells.length + sessionListSpells.length;

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
): Promise<Run> =>
	new Promise((resolve, reject) => {
		const child: ChildProcess = spawn(process.execPath, [bin, ...args], {stdio: "pipe", env});
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
					programCount: 2,
					spellCount: CORE_SPELLS,
					bindingCount: 0,
					bindingErrors: [],
					stateDir: homeStateDir(project, home),
					adopted: {moved: [], kept: [], unowned: []},
					processCount: 0,
					restoredCount: 0,
				});
			}),
		DIRECT_BOOT_MS,
	);

	it(
		"exits on its own when the config plans no process",
		() => {
			const home = freshHome();
			const project = freshProject();
			const result = run(["--config", fixture("two-rows"), "--project", project], {
				...process.env,
				HOME: home,
			});
			expect(result.status).toBe(0);
			expect(result.stdout).toBe(
				`tuval: booted — 2 program(s), ${CORE_SPELLS} spell(s) registered from ${fixture("two-rows")}; 0 process(es) live, 0 restored from ${homeStateDir(project, home)}\n`,
			);
		},
		spawnBudget(1),
	);

	it(
		"reads ~/.tuval/tuval.config.ts and the cwd's .tuval/tuval.config.ts by default, both merged",
		() => {
			const home = freshHome();
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
			// One line and no more: this boot moved nothing, so the account of what the move left
			// behind has nothing to account for, and the project's config module goes unmentioned.
			expect(result.stdout).toBe(
				`tuval: booted — 3 program(s), ${CORE_SPELLS} spell(s) registered from ${defaultGlobalConfig(home)} + ${projectConfig(project)}; 0 process(es) live, 0 restored from ${homeStateDir(project, home)}\n`,
			);
		},
		spawnBudget(1),
	);

	it(
		"boots with no config module at all: nothing registered, nothing to run",
		() => {
			const home = freshHome();
			const project = freshProject();
			const result = run(["--project", project], {...process.env, HOME: home});
			expect(result.status).toBe(0);
			expect(result.stdout).toBe(
				`tuval: booted — 0 program(s), ${CORE_SPELLS} spell(s) registered from no config module; 0 process(es) live, 0 restored from ${homeStateDir(project, home)}\n`,
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
				`tuval: booted — 9 program(s), ${BOX_SPELLS} spell(s) registered from ${boxConfig}; 3 process(es) live, 0 restored from ${homeStateDir(project, home)}\n`,
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
				`tuval: booted — 9 program(s), ${BOX_SPELLS} spell(s) registered from ${boxConfig}; 3 process(es) live, 3 restored from ${homeStateDir(project, home)}\n`,
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
				assert.strictEqual(report.processCount, 1);
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
					`tuval: booted — 1 program(s), ${CORE_SPELLS} spell(s) registered from ${fixture("one-counter")}; 1 process(es) live, 1 restored from ${homeStateDir(project, home)}\n`,
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
		"refuses to boot on a wrong-shaped project config the same way",
		() => {
			const project = projectWithConfig("wrong-shape");
			const result = run(["--project", project], {...process.env, HOME: freshHome()});
			expect(result.status).toBe(1);
			expect(result.stderr).toBe(
				`tuval: refusing to boot — config module ${projectConfig(project)}: not a v1 config at version: Missing key\n`,
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

	it(
		"boots a full attaching desk over a project holding no files, on the home config alone",
		async () => {
			const home = freshHome();
			mkdirSync(join(home, ".tuval"));
			writeFileSync(
				defaultGlobalConfig(home),
				`export {default} from ${JSON.stringify(boxConfig)};\n`,
			);
			const project = emptyProject();
			const result = await runUntilRunning(["--project", project], {...process.env, HOME: home});
			expect(result.status).toBe(0);
			expect(result.stdout).toContain(
				`3 process(es) live, 0 restored from ${homeStateDir(project, home)}\n`,
			);
			expect(result.stdout).toContain("tuval: process shell program=shell");
			expect(result.stdout).toContain("tuval: desk at http://");
			// The whole point of rule 1: the project is exactly as empty as it was.
			expect(readdirSync(project)).toEqual([]);
		},
		spawnBudget(1),
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
				assert.strictEqual(report.programCount, 3);
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
				assert.strictEqual(again.report.restoredCount, 1);
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
				assert.strictEqual(report.processCount, 1);
				assert.strictEqual(report.restoredCount, 1);
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
 * `pi/ai-agent/boundary.unit.test.ts`.
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
	// a project layer stating `false` over a global `true` — and before this the layer read
	// `featuresDefault` and loaded the extension anyway.
	it.effect(
		"let the project layer's false beat the global layer's true",
		() =>
			Effect.gen(function* () {
				const booted = yield* bootDirect(
					fixture("pi-subagents-on"),
					projectWithConfig("pi-subagents-off"),
				);
				const features = yield* flagsAtSpawn(booted);
				assert.deepStrictEqual(features, {...featuresDefault, piSubagents: false});
				assert.deepStrictEqual(subagentExtensionPaths(features), []);
			}),
		DIRECT_BOOT_MS,
	);

	it.effect(
		"let the project layer's true beat the global layer's false",
		() =>
			Effect.gen(function* () {
				const booted = yield* bootDirect(
					fixture("pi-subagents-off"),
					projectWithConfig("pi-subagents-on"),
				);
				const features = yield* flagsAtSpawn(booted);
				assert.deepStrictEqual(features, {...featuresDefault, piSubagents: true});
				assert.strictEqual(subagentExtensionPaths(features).length, 1);
			}),
		DIRECT_BOOT_MS,
	);
});
