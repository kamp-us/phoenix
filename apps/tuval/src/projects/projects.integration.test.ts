/**
 * A second project opened into a running desk and closed again, live (#9685): a scratch-home desk
 * boots one project, the `project open` spell opens another with no restart, and `project close`
 * takes it back out while the first keeps running. The second case serves the page over the same
 * desk, so a project whose row names a module renderer has that renderer served once it opens.
 *
 * The trust cases (#9693) answer the "Trust this folder?" question the way a page does, through the
 * kernel's `TrustPrompts`, and read whether the folder's config module was ever imported off a file
 * that module writes as it is evaluated.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {NodeFileSystem} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {SpellExecutor} from "@kampus/tuval-sdk/kernel/commands/executor";
import {ClientId, WorkspaceId} from "@kampus/tuval-sdk/kernel/commands/spell";
import {Processes} from "@kampus/tuval-sdk/kernel/process/Processes";
import {ProcessTable} from "@kampus/tuval-sdk/kernel/process/ProcessTable";
import {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {CallId} from "@kampus/tuval-sdk/kernel/protocol/ids";
import {PROTOCOL_VERSION, SpellCall} from "@kampus/tuval-sdk/kernel/protocol/messages";
import {ProgramId} from "@kampus/tuval-sdk/kernel/registry/program";
import {Registry} from "@kampus/tuval-sdk/kernel/registry/Registry";
import {homeStateDir} from "@kampus/tuval-sdk/kernel/state-dir";
import {Context, Effect, Fiber, Option, Schedule, Schema, Stream} from "effect";
import {boot, type Kernel, projectConfig, projectDir} from "../boot.ts";
import {servePage} from "../page/dev-server.ts";
import {ProjectId} from "../project-id.ts";
import {scratchHome} from "../scratch-home.ts";
import type {TransportServer} from "../shell/transport/server.ts";
import {OpenProjects, readOpenProjects, saveOpenProjects} from "./open-projects.ts";
import {Projects} from "./Projects.ts";
import {TrustPrompts} from "./TrustPrompts.ts";
import type {TrustAnswer} from "./trust-prompt.ts";

const TIMEOUT = 60_000;
const appRoot = dirname(dirname(import.meta.dirname));
/** How Vite spells a `\0`-prefixed virtual id in a URL. */
const VIRTUAL_URL = "/@id/__x00__virtual:tuval/module-renderers";
const RENDERER_REF = "@tuval-fixture/win/window";

const fixture = (name: string) =>
	fileURLToPath(new URL(`../config-fixtures/${name}.ts`, import.meta.url));

const client = {id: ClientId.make("test"), workspace: WorkspaceId.make("ws-1")};

/** A project folder whose `.tuval/tuval.config.ts` re-exports the named fixture. */
const projectWith = (name: string): string => {
	// realpath: macOS resolves /var to /private/var, and Vite answers with the real path.
	const folder = realpathSync(mkdtempSync(join(tmpdir(), "tuval-project-")));
	mkdirSync(projectDir(folder));
	writeFileSync(projectConfig(folder), `export {default} from ${JSON.stringify(fixture(name))};\n`);
	return folder;
};

/**
 * A project folder whose config module writes `marker` when it is evaluated, then re-exports the
 * named fixture: the file existing is the proof the module was imported.
 */
const projectMarking = (name: string): {readonly folder: string; readonly marker: string} => {
	const folder = projectWith(name);
	const marker = join(folder, "imported");
	writeFileSync(
		projectConfig(folder),
		[
			'import {writeFileSync} from "node:fs";',
			`writeFileSync(${JSON.stringify(marker)}, "imported");`,
			`export {default} from ${JSON.stringify(fixture(name))};`,
			"",
		].join("\n"),
	);
	return {folder, marker};
};

/** The question an open of `folder` is waiting on, once it is being asked. */
const questionFor = (kernel: Context.Context<Kernel>, folder: string) =>
	Context.get(kernel, TrustPrompts).pending.pipe(
		Stream.map((pending) => pending.find((prompt) => prompt.folder === folder)),
		Stream.filter((prompt) => prompt !== undefined),
		Stream.runHead,
		Effect.flatMap((head) =>
			Option.isSome(head) ? Effect.succeed(head.value) : Effect.die(`${folder} was never asked`),
		),
	);

/** Open `folder` through the spell, answering its trust question the way a page does. */
const openAnswering = (kernel: Context.Context<Kernel>, folder: string, answer: TrustAnswer) =>
	Effect.gen(function* () {
		const opening = yield* Effect.forkChild(spell(kernel, ["project", "open"], {folder}));
		const prompt = yield* questionFor(kernel, folder);
		assert.isTrue(yield* Context.get(kernel, TrustPrompts).answer(prompt.question, answer));
		return yield* Fiber.join(opening);
	});

const pendingNow = (kernel: Context.Context<Kernel>) =>
	Effect.map(Stream.runHead(Context.get(kernel, TrustPrompts).pending), Option.getOrNull);

/** A package installed beside a project's config: what that project's module renderer names. */
const installRenderer = (folder: string): string => {
	const pkg = join(projectDir(folder), "node_modules", "@tuval-fixture", "win");
	mkdirSync(pkg, {recursive: true});
	writeFileSync(
		join(pkg, "package.json"),
		JSON.stringify({
			name: "@tuval-fixture/win",
			version: "1.0.0",
			type: "module",
			exports: {"./window": "./window.js"},
		}),
	);
	const file = join(pkg, "window.js");
	writeFileSync(
		file,
		'export const admits = () => true;\nexport default {kind: "module", render: () => "opened-after-boot"};\n',
	);
	return file;
};

class Unsettled extends Schema.TaggedError<Unsettled>()("Unsettled", {what: Schema.String}) {}

/** Retry `check` until it holds: the page server applies a new renderer set on a fiber of its own. */
const eventually = <A, E>(what: string, read: Effect.Effect<A, E>, holds: (value: A) => boolean) =>
	Effect.flatMap(read, (value) =>
		holds(value) ? Effect.succeed(value) : Effect.fail(new Unsettled({what})),
	).pipe(Effect.retry({schedule: Schedule.spaced("50 millis"), times: 100}));

const spell = (
	kernel: Context.Context<Kernel>,
	path: readonly [string, ...string[]],
	args: unknown,
) =>
	Effect.gen(function* () {
		const executor = yield* SpellExecutor;
		return yield* executor.execute(
			new SpellCall({
				type: "spell.call",
				version: PROTOCOL_VERSION,
				id: CallId.make(`${path.join(".")}-${Math.random()}`),
				path,
				args,
			}),
			client,
		);
	}).pipe(Effect.provideContext(kernel));

const liveIds = (kernel: Context.Context<Kernel>) =>
	Effect.map(ProcessTable.use((table) => table.list).pipe(Effect.provideContext(kernel)), (rows) =>
		rows.map((row) => row.id as string),
	);

const logLines = (kernel: Context.Context<Kernel>) =>
	ProcessTable.use((table) => table.get(ProcessId.make("log"))).pipe(
		Effect.map(
			(row) => (row.stateSummary().state as {readonly lines: ReadonlyArray<number>}).lines,
		),
		Effect.provideContext(kernel),
	);

const tick = (kernel: Context.Context<Kernel>, id: string) =>
	Processes.use((processes) => processes.handle(ProcessId.make(id))).pipe(
		Effect.flatMap((handle) =>
			Option.isSome(handle)
				? handle.value.dispatch({type: "tick"})
				: Effect.die(`${id} is not live`),
		),
		Effect.provideContext(kernel),
	);

const manifestIds = (stateDir: string): ReadonlyArray<string> => {
	const file = join(stateDir, "manifest.json");
	if (!existsSync(file)) return [];
	const manifest = JSON.parse(readFileSync(file, "utf8")) as {
		readonly processes: ReadonlyArray<{readonly id: string}>;
	};
	return manifest.processes.map((entry) => entry.id);
};

/** The page server needs a launch URL to answer and a fence to tell; nothing here attaches. */
const transport: TransportServer = {
	port: 1,
	publishRegistry: Effect.void,
	launchUrl: "ws://127.0.0.1:1/?token=none",
	admitLoopbackPort: () => {},
};

class FetchFailed extends Schema.TaggedError<FetchFailed>()("FetchFailed", {
	cause: Schema.Defect(),
}) {}

const text = (url: URL) =>
	Effect.tryPromise({
		try: () => fetch(url).then((response) => response.text()),
		catch: (cause) => new FetchFailed({cause}),
	});

describe("a project opened into a running desk", () => {
	it.live(
		"starts its programs with no restart, and closing it leaves the first project running",
		() =>
			Effect.gen(function* () {
				const home = scratchHome("projects-open");
				const first = projectWith("planned-counter");
				const second = projectWith("counter-into-global-log");
				const alpha = ProjectId.of(first);
				const beta = ProjectId.of(second);
				const {kernel, report} = yield* boot({global: fixture("log-global"), project: first, home});
				const counter = beta.scope("counter");

				const opened = yield* openAnswering(kernel, second, "trust");
				assert.isTrue(opened.ok, JSON.stringify(opened));
				assert.includeMembers(
					[...(yield* liveIds(kernel))],
					["shell", "log", alpha.scope("main"), counter],
				);
				const row = yield* Registry.use((registry) =>
					registry.resolve(ProgramId.make(beta.scope("counter"))),
				).pipe(Effect.provideContext(kernel));
				assert.strictEqual(row.id, beta.scope("counter"));

				// The connection the project declared: its counter's tick reaches the global log.
				yield* tick(kernel, counter);
				yield* eventually(
					"the log records the tick",
					logLines(kernel),
					(lines) => lines.length === 1,
				);

				// Each project checkpoints under its own state directory.
				assert.include(manifestIds(homeStateDir(second, home)), counter);
				assert.isTrue(existsSync(join(homeStateDir(second, home), "processes", `${counter}.json`)));
				assert.notInclude(manifestIds(report.stateDir), counter);
				assert.include(manifestIds(report.stateDir), alpha.scope("main"));
				assert.deepStrictEqual(yield* readOpenProjects(home), {
					version: 1,
					projects: [{folder: first}, {folder: second}],
					trusted: [second],
				});

				const closed = yield* spell(kernel, ["project", "close"], {folder: second});
				assert.isTrue(closed.ok, JSON.stringify(closed));
				const after = yield* liveIds(kernel);
				assert.notInclude(after, counter);
				assert.includeMembers([...after], ["shell", "log", alpha.scope("main")]);
				const gone = yield* Registry.use((registry) =>
					Effect.flip(registry.resolve(ProgramId.make(beta.scope("counter")))),
				).pipe(Effect.provideContext(kernel));
				assert.strictEqual(gone._tag, "tuval/ProgramNotFound");
				assert.deepStrictEqual(yield* readOpenProjects(home), {
					version: 1,
					projects: [{folder: first}],
					trusted: [second],
				});

				// Reopening brings the counter back at its checkpoint, with its connection restored. The
				// folder is trusted now, so this open is not asked about.
				const reopened = yield* spell(kernel, ["project", "open"], {folder: second});
				assert.isTrue(reopened.ok, JSON.stringify(reopened));
				if (reopened.ok) assert.include(reopened.result as object, {restored: 1});
				yield* tick(kernel, counter);
				const lines = yield* eventually(
					"the log records the reopened counter's tick",
					logLines(kernel),
					(recorded) => recorded.length === 2,
				);
				assert.deepStrictEqual(lines, [1, 2]);
			}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
		TIMEOUT,
	);

	it.live(
		"has a module renderer it declares served by the running page, and drops it on close",
		() =>
			Effect.gen(function* () {
				const home = scratchHome("projects-renderer");
				const first = projectWith("planned-counter");
				const second = projectWith("module-renderer-counter");
				const file = installRenderer(second);
				// Trusted by a desk that ran before: the saved list is what this boot reads its trust from.
				yield* saveOpenProjects(home, OpenProjects.none.trust(second));
				const booted = yield* boot({global: fixture("does-not-exist"), project: first, home});
				const projects = Context.get(booted.kernel, Projects);
				const page = yield* servePage({
					root: appRoot,
					transport,
					port: 0,
					moduleRenderers: booted.moduleRenderers,
					moduleRendererChanges: projects.renderers,
				});
				const loader = text(new URL(VIRTUAL_URL, page.url));
				assert.notInclude(yield* loader, RENDERER_REF);

				const opened = yield* spell(booted.kernel, ["project", "open"], {folder: second});
				assert.isTrue(opened.ok, JSON.stringify(opened));
				const served = yield* eventually("the loader names the renderer", loader, (source) =>
					source.includes(`"${RENDERER_REF}"`),
				);
				// Resolved from the project's own config, where the package is installed.
				assert.include(served, file);
				assert.include(yield* text(new URL(`/@fs${file}`, page.url)), "opened-after-boot");

				const closed = yield* spell(booted.kernel, ["project", "close"], {folder: second});
				assert.isTrue(closed.ok, JSON.stringify(closed));
				yield* eventually(
					"the loader drops the renderer",
					loader,
					(source) => !source.includes(RENDERER_REF),
				);
			}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
		TIMEOUT,
	);
});

describe("the first open of a folder", () => {
	it.live(
		"asks before importing its config, and a no leaves nothing from it running",
		() =>
			Effect.gen(function* () {
				const home = scratchHome("projects-trust-no");
				const first = projectWith("planned-counter");
				const {folder, marker} = projectMarking("counter-into-global-log");
				const {kernel} = yield* boot({global: fixture("log-global"), project: first, home});
				const before = yield* liveIds(kernel);

				const opening = yield* Effect.forkChild(spell(kernel, ["project", "open"], {folder}));
				const prompt = yield* questionFor(kernel, folder);
				assert.strictEqual(prompt.name, ProjectId.of(folder).name);
				assert.isFalse(existsSync(marker), "the config module ran before the person answered");

				assert.isTrue(yield* Context.get(kernel, TrustPrompts).answer(prompt.question, "refuse"));
				const refused = yield* Fiber.join(opening);
				assert.isFalse(refused.ok, JSON.stringify(refused));
				if (!refused.ok) {
					assert.strictEqual(refused.error.tag, "tuval/FolderNotTrusted");
					assert.include(refused.error.message, folder);
				}
				assert.isFalse(existsSync(marker), "a refused folder's config module was imported");
				assert.deepStrictEqual([...(yield* liveIds(kernel))].sort(), [...before].sort());
				assert.deepStrictEqual(yield* pendingNow(kernel), []);
				const open = yield* Context.get(kernel, Projects).list;
				assert.deepStrictEqual(
					open.map((project) => project.folder),
					[first],
				);
				assert.deepStrictEqual(yield* readOpenProjects(home), {
					version: 1,
					projects: [{folder: first}],
					trusted: [],
				});
			}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
		TIMEOUT,
	);

	it.live(
		"opens on a yes and remembers it, so the next open does not ask",
		() =>
			Effect.gen(function* () {
				const home = scratchHome("projects-trust-yes");
				const first = projectWith("planned-counter");
				const {folder, marker} = projectMarking("counter-into-global-log");
				const {kernel} = yield* boot({global: fixture("log-global"), project: first, home});

				const opened = yield* openAnswering(kernel, folder, "trust");
				assert.isTrue(opened.ok, JSON.stringify(opened));
				assert.isTrue(existsSync(marker));
				assert.include(yield* liveIds(kernel), ProjectId.of(folder).scope("counter"));
				const saved = yield* readOpenProjects(home);
				assert.deepStrictEqual(saved?.trusted, [folder]);

				const closed = yield* spell(kernel, ["project", "close"], {folder});
				assert.isTrue(closed.ok, JSON.stringify(closed));
				// Asked nothing: the open completes with no answer given, and no question ever waits.
				const again = yield* spell(kernel, ["project", "open"], {folder: `${folder}/`}).pipe(
					Effect.timeout("20 seconds"),
				);
				assert.isTrue(again.ok, JSON.stringify(again));
				assert.deepStrictEqual(yield* pendingNow(kernel), []);
			}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
		TIMEOUT,
	);

	it.live(
		"never asks about a folder with no config, the home config or the desk layer",
		() =>
			Effect.gen(function* () {
				const home = scratchHome("projects-trust-none");
				const first = projectWith("planned-counter");
				const bare = realpathSync(mkdtempSync(join(tmpdir(), "tuval-bare-")));
				// The boot read the home config and the desk layer, and asked nothing to do it.
				const {kernel} = yield* boot({global: fixture("log-global"), project: first, home});
				assert.deepStrictEqual(yield* pendingNow(kernel), []);

				const opened = yield* spell(kernel, ["project", "open"], {folder: bare}).pipe(
					Effect.timeout("20 seconds"),
				);
				assert.isTrue(opened.ok, JSON.stringify(opened));
				assert.deepStrictEqual(yield* pendingNow(kernel), []);
				assert.deepStrictEqual((yield* readOpenProjects(home))?.trusted, []);
			}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
		TIMEOUT,
	);
});

describe("the folder a process runs in (#9694)", () => {
	/** The folder the process at `id` wrote into its state, once it has written one. */
	const folderOf = (kernel: Context.Context<Kernel>, id: string) =>
		eventually(
			`process ${id} to report its folder`,
			Context.get(kernel, ProcessTable)
				.get(ProcessId.make(id))
				.pipe(
					Effect.map(
						(row) => (row.stateSummary().state as {readonly folder: string | null}).folder,
					),
				),
			(folder) => folder !== null,
		);

	it.live(
		"is the home folder for the desk's own programs and each project's folder for its programs",
		() =>
			Effect.gen(function* () {
				const home = scratchHome("projects-folder");
				const first = projectWith("folder-probe");
				const second = projectWith("folder-probe");
				yield* saveOpenProjects(home, OpenProjects.none.trust(second));
				const {kernel} = yield* boot({global: fixture("folder-probe"), project: first, home});

				assert.strictEqual(yield* folderOf(kernel, "probe"), home);
				assert.strictEqual(yield* folderOf(kernel, ProjectId.of(first).scope("probe")), first);

				const opened = yield* spell(kernel, ["project", "open"], {folder: second});
				assert.isTrue(opened.ok, JSON.stringify(opened));
				assert.strictEqual(yield* folderOf(kernel, ProjectId.of(second).scope("probe")), second);
			}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
		TIMEOUT,
	);
});
