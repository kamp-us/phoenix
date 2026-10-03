/**
 * A second project opened into a running desk and closed again, live (#9685): a scratch-home desk
 * boots one project, the `project open` spell opens another with no restart, and `project close`
 * takes it back out while the first keeps running. The second case serves the page over the same
 * desk, so a project whose row names a module renderer has that renderer served once it opens.
 *
 * The trust cases (#9693) answer the "Trust this folder?" question the way a page does, through the
 * kernel's `TrustPrompts`, and read whether the folder's config module was ever imported off a file
 * that module writes as it is evaluated.
 *
 * The restart cases (#9688) stop a scratch-home desk and boot another over the same home, which is
 * what a desk restart is: the second desk reads the saved list the first one left.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {basename, dirname, join} from "node:path";
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
import {type BootOptions, boot, type Kernel, projectConfig, projectDir} from "../boot.ts";
import {servePage} from "../page/dev-server.ts";
import {ProjectId} from "../project-id.ts";
import {scratchHome, trustFolders} from "../scratch-home.ts";
import type {TransportServer} from "../shell/transport/server.ts";
import type {BrowsedFolder} from "./open-project-wire.ts";
import {OpenProjects, readOpenProjects, saveOpenProjects} from "./open-projects.ts";
import {Projects} from "./Projects.ts";
import {RecommendPrompts} from "./RecommendPrompts.ts";
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

/**
 * `boot` on `options.project` with that folder trusted in the scratch home first, as a desk that
 * ran before would have left it: these cases are not about the boot folder's trust question (#9977).
 */
const trustedBoot = (options: BootOptions) =>
	Effect.suspend(() => {
		trustFolders(options.home, [options.project]);
		return boot(options);
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
				const {kernel} = yield* trustedBoot({global: fixture("log-global"), project: first, home});
				const counter = beta.scope("counter");
				// Trusted up front, so the boot folder opened with no question (#9977).
				assert.deepStrictEqual(yield* pendingNow(kernel), []);

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
				assert.notInclude(manifestIds(homeStateDir(first, home)), counter);
				assert.include(manifestIds(homeStateDir(first, home)), alpha.scope("main"));
				assert.deepStrictEqual(yield* readOpenProjects(home), {
					version: 1,
					projects: [{folder: first}, {folder: second}],
					trusted: [first, second],
					recommends: [],
					recent: [second, first],
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

				// "Open project…" reads the closed project back as recent, and not open (#9697).
				const recent = yield* spell(kernel, ["project", "recent"], {});
				assert.isTrue(recent.ok, JSON.stringify(recent));
				if (recent.ok) {
					assert.deepStrictEqual(recent.result, [
						{folder: second, name: ProjectId.of(second).name, key: beta.key, open: false},
						{folder: first, name: ProjectId.of(first).name, key: alpha.key, open: true},
					]);
				}
				// Its folder browser lists the folder the closed project sits in, marking its config.
				const browsed = yield* spell(kernel, ["project", "browse"], {folder: dirname(second)});
				assert.isTrue(browsed.ok, JSON.stringify(browsed));
				if (browsed.ok) {
					const listed = (browsed.result as {readonly folders: ReadonlyArray<BrowsedFolder>})
						.folders;
					assert.deepInclude(listed, {
						name: basename(second),
						folder: second,
						hasConfig: true,
						open: false,
					});
				}
				assert.deepStrictEqual(yield* readOpenProjects(home), {
					version: 1,
					projects: [{folder: first}],
					trusted: [first, second],
					recommends: [],
					recent: [second, first],
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
				const booted = yield* trustedBoot({
					global: fixture("does-not-exist"),
					project: first,
					home,
				});
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
				const {kernel} = yield* trustedBoot({global: fixture("log-global"), project: first, home});
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
					trusted: [first],
					recommends: [],
					recent: [first],
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
				const {kernel} = yield* trustedBoot({global: fixture("log-global"), project: first, home});

				const opened = yield* openAnswering(kernel, folder, "trust");
				assert.isTrue(opened.ok, JSON.stringify(opened));
				assert.isTrue(existsSync(marker));
				assert.include(yield* liveIds(kernel), ProjectId.of(folder).scope("counter"));
				const saved = yield* readOpenProjects(home);
				assert.deepStrictEqual(saved?.trusted, [first, folder]);

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
				const {kernel} = yield* trustedBoot({global: fixture("log-global"), project: first, home});
				assert.deepStrictEqual(yield* pendingNow(kernel), []);

				const opened = yield* spell(kernel, ["project", "open"], {folder: bare}).pipe(
					Effect.timeout("20 seconds"),
				);
				assert.isTrue(opened.ok, JSON.stringify(opened));
				assert.deepStrictEqual(yield* pendingNow(kernel), []);
				assert.deepStrictEqual((yield* readOpenProjects(home))?.trusted, [first]);
			}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
		TIMEOUT,
	);
});

describe("the folder a desk boots with (#9977)", () => {
	it.live(
		"is asked about before its config is imported, and a yes opens it and remembers it",
		() =>
			Effect.gen(function* () {
				const home = scratchHome("projects-boot-yes");
				const {folder, marker} = projectMarking("planned-counter");
				const {kernel, report} = yield* boot({
					global: fixture("log-global"),
					project: folder,
					home,
				});
				assert.deepStrictEqual(report.first, {_tag: "Asking", folder});
				assert.isFalse(
					existsSync(marker),
					"the boot folder's config ran before the person answered",
				);
				assert.deepStrictEqual(report.sources, [fixture("log-global")]);
				assert.deepStrictEqual(yield* openFolders(kernel), []);
				assert.includeMembers([...(yield* liveIds(kernel))], ["shell", "log"]);

				// The question the page is sent is the one `project open` asks.
				const prompt = yield* questionFor(kernel, folder);
				assert.deepStrictEqual(prompt, {
					question: prompt.question,
					folder,
					name: ProjectId.of(folder).name,
				});
				assert.isFalse(
					existsSync(marker),
					"the boot folder's config ran before the person answered",
				);
				assert.isTrue(yield* Context.get(kernel, TrustPrompts).answer(prompt.question, "trust"));

				yield* eventually("the boot folder to open", openFolders(kernel), (open) =>
					open.includes(folder),
				);
				assert.isTrue(existsSync(marker));
				assert.include(yield* liveIds(kernel), ProjectId.of(folder).scope("main"));
				const saved = yield* readOpenProjects(home);
				assert.deepStrictEqual(saved?.trusted, [folder]);
				assert.deepStrictEqual(
					saved?.projects.map((project) => project.folder),
					[folder],
				);
			}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
		TIMEOUT,
	);

	it.live(
		"left untrusted on a no, keeps the desk running on the home and global layers with its own state",
		() =>
			Effect.gen(function* () {
				const home = scratchHome("projects-boot-no");
				const {folder, marker} = projectMarking("planned-counter");
				const {kernel, report} = yield* boot({
					global: fixture("log-global"),
					project: folder,
					home,
				});
				const before = yield* liveIds(kernel);

				const prompt = yield* questionFor(kernel, folder);
				assert.isTrue(yield* Context.get(kernel, TrustPrompts).answer(prompt.question, "refuse"));
				yield* eventually(
					"the question to leave the page",
					pendingNow(kernel),
					(pending) => (pending ?? []).length === 0,
				);

				assert.isFalse(existsSync(marker), "a refused boot folder's config module was imported");
				assert.deepStrictEqual(yield* openFolders(kernel), []);
				assert.deepStrictEqual([...(yield* liveIds(kernel))].sort(), [...before].sort());
				assert.deepStrictEqual((yield* readOpenProjects(home))?.trusted ?? [], []);
				// The desk saves into a state directory of its own, not the refused folder's.
				assert.strictEqual(report.deskStateDir, homeStateDir(home, home));
				assert.includeMembers([...manifestIds(report.deskStateDir)], ["shell", "log"]);
				assert.isFalse(existsSync(homeStateDir(folder, home)));
			}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
		TIMEOUT,
	);
});

describe("a project's recommended packages (#9695)", () => {
	const recommendsNow = (kernel: Context.Context<Kernel>) =>
		Effect.map(
			Stream.runHead(Context.get(kernel, RecommendPrompts).pending),
			(head) => Option.getOrNull(head) ?? [],
		);

	/** The packages `folder` is being asked about, once `count` of them are waiting. */
	const askedFor = (kernel: Context.Context<Kernel>, folder: string, count: number) =>
		Context.get(kernel, RecommendPrompts).pending.pipe(
			Stream.map((pending) => pending.filter((prompt) => prompt.folder === folder)),
			Stream.filter((prompts) => prompts.length === count),
			Stream.runHead,
			Effect.map(Option.getOrThrow),
			Effect.timeout("20 seconds"),
		);

	it.live(
		"asks once the folder is trusted, remembers each answer, and asks nothing on the next open",
		() =>
			Effect.gen(function* () {
				const home = scratchHome("projects-recommends");
				const first = projectWith("planned-counter");
				const folder = projectWith("counter-recommending");
				const {kernel} = yield* trustedBoot({global: fixture("log-global"), project: first, home});

				const opening = yield* Effect.forkChild(spell(kernel, ["project", "open"], {folder}));
				const trust = yield* questionFor(kernel, folder);
				// Waiting on trust, the folder's config is unread, so nothing it recommends is asked.
				assert.deepStrictEqual(yield* recommendsNow(kernel), []);
				assert.isTrue(yield* Context.get(kernel, TrustPrompts).answer(trust.question, "trust"));
				const opened = yield* Fiber.join(opening);
				assert.isTrue(opened.ok, JSON.stringify(opened));

				const asked = yield* askedFor(kernel, folder, 2);
				assert.deepStrictEqual(
					asked.map((prompt) => prompt.package),
					["@kampus/tuval-worktree", "tuval-cron"],
				);
				assert.strictEqual(asked[0]?.name, ProjectId.of(folder).name);
				const prompts = Context.get(kernel, RecommendPrompts);
				assert.isTrue(yield* prompts.answer(asked[0]?.question ?? "", "decline"));
				assert.isTrue(yield* prompts.answer(asked[1]?.question ?? "", "install"));
				yield* askedFor(kernel, folder, 0);

				const saved = yield* eventually(
					"both answers saved",
					readOpenProjects(home).pipe(Effect.provide(NodeFileSystem.layer)),
					(record) => Object.keys(record?.recommends[0]?.answers ?? {}).length === 2,
				);
				assert.deepStrictEqual(saved?.recommends, [
					{folder, answers: {"@kampus/tuval-worktree": "decline", "tuval-cron": "install"}},
				]);
				// Nothing is installed on either answer: no package appears beside the project's config.
				assert.isFalse(existsSync(join(projectDir(folder), "node_modules")));

				const closed = yield* spell(kernel, ["project", "close"], {folder});
				assert.isTrue(closed.ok, JSON.stringify(closed));
				const again = yield* spell(kernel, ["project", "open"], {folder}).pipe(
					Effect.timeout("20 seconds"),
				);
				assert.isTrue(again.ok, JSON.stringify(again));
				assert.deepStrictEqual(yield* recommendsNow(kernel), []);
			}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
		TIMEOUT,
	);

	it.live(
		"never reads what an untrusted folder recommends",
		() =>
			Effect.gen(function* () {
				const home = scratchHome("projects-recommends-untrusted");
				const first = projectWith("planned-counter");
				const {folder, marker} = projectMarking("counter-recommending");
				const {kernel} = yield* trustedBoot({global: fixture("log-global"), project: first, home});

				const opened = yield* openAnswering(kernel, folder, "refuse");
				assert.isFalse(opened.ok, JSON.stringify(opened));
				assert.isFalse(existsSync(marker), "the untrusted folder's config module was imported");
				assert.deepStrictEqual(yield* recommendsNow(kernel), []);
				assert.deepStrictEqual((yield* readOpenProjects(home))?.recommends, []);
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
				const {kernel} = yield* trustedBoot({
					global: fixture("folder-probe"),
					project: first,
					home,
				});

				assert.strictEqual(yield* folderOf(kernel, "probe"), home);
				assert.strictEqual(yield* folderOf(kernel, ProjectId.of(first).scope("probe")), first);

				const opened = yield* spell(kernel, ["project", "open"], {folder: second});
				assert.isTrue(opened.ok, JSON.stringify(opened));
				assert.strictEqual(yield* folderOf(kernel, ProjectId.of(second).scope("probe")), second);
			}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
		TIMEOUT,
	);
});

const openFolders = (kernel: Context.Context<Kernel>) =>
	Effect.map(Context.get(kernel, Projects).list, (open) => open.map((project) => project.folder));

const savedFolders = (home: string) =>
	Effect.map(readOpenProjects(home), (saved) => saved?.projects.map(({folder}) => folder));

describe("a desk restart", () => {
	it.live(
		"reopens the projects that were open, each restored from its own state, and a closed one stays closed",
		() =>
			Effect.gen(function* () {
				const home = scratchHome("projects-restart");
				const first = projectWith("planned-counter");
				const second = projectWith("counter-into-global-log");
				const closed = projectWith("counter-into-global-log");
				const counter = ProjectId.of(second).scope("counter");

				yield* Effect.gen(function* () {
					const {kernel} = yield* trustedBoot({
						global: fixture("log-global"),
						project: first,
						home,
					});
					assert.isTrue((yield* openAnswering(kernel, second, "trust")).ok);
					assert.isTrue((yield* openAnswering(kernel, closed, "trust")).ok);
					yield* tick(kernel, counter);
					yield* eventually(
						"the log records the tick",
						logLines(kernel),
						(lines) => lines.length === 1,
					);
					const closing = yield* spell(kernel, ["project", "close"], {folder: closed});
					assert.isTrue(closing.ok, JSON.stringify(closing));
				}).pipe(Effect.scoped);

				const {kernel, report} = yield* trustedBoot({
					global: fixture("log-global"),
					project: first,
					home,
				});
				assert.deepStrictEqual(yield* openFolders(kernel), [first, second]);
				assert.deepStrictEqual(report.reopened, [second]);
				assert.deepStrictEqual(report.skipped, []);
				const live = yield* liveIds(kernel);
				assert.includeMembers(
					[...live],
					["shell", "log", ProjectId.of(first).scope("main"), counter],
				);
				assert.notInclude(live, ProjectId.of(closed).scope("counter"));
				// The counter comes back at its checkpoint, read from its own project's state directory.
				assert.include(manifestIds(homeStateDir(second, home)), counter);
				assert.notInclude(manifestIds(homeStateDir(first, home)), counter);
				yield* tick(kernel, counter);
				const lines = yield* eventually(
					"the log records the restored counter's tick",
					logLines(kernel),
					(recorded) => recorded.length === 2,
				);
				assert.deepStrictEqual(lines, [1, 2]);
				assert.deepStrictEqual(yield* savedFolders(home), [first, second]);
			}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
		TIMEOUT,
	);

	it.live(
		"skips a deleted folder and an untrusted one with a notice naming each, and opens the rest",
		() =>
			Effect.gen(function* () {
				const home = scratchHome("projects-restart-skip");
				const first = projectWith("planned-counter");
				const gone = projectWith("counter-into-global-log");
				const {folder: revoked, marker} = projectMarking("counter-into-global-log");
				const kept = projectWith("counter-into-global-log");
				// A desk that stopped with all three open. Since then one folder was deleted, and the other
				// lost its trust: the saved list no longer names it among the trusted folders.
				const stopped = OpenProjects.restoring({
					version: 1,
					projects: [gone, revoked, kept].map((folder) => ({folder})),
					trusted: [gone, kept],
					recommends: [],
					recent: [],
				});
				yield* saveOpenProjects(home, stopped);
				rmSync(gone, {recursive: true, force: true});

				const {kernel, report} = yield* trustedBoot({
					global: fixture("log-global"),
					project: first,
					home,
				});
				assert.deepStrictEqual(yield* openFolders(kernel), [first, kept]);
				assert.deepStrictEqual(report.reopened, [kept]);
				assert.deepStrictEqual(
					report.skipped.map((skip) => skip.folder),
					[gone, revoked],
				);
				assert.include(report.skipped[0]?.message, gone);
				assert.include(report.skipped[1]?.message, revoked);
				assert.include(report.skipped[1]?.message, "not trusted");
				// Nothing from the untrusted folder ran, and nobody was asked about it.
				assert.isFalse(existsSync(marker), "an untrusted folder's config module was imported");
				assert.deepStrictEqual(yield* pendingNow(kernel), []);
				const live = yield* liveIds(kernel);
				assert.include(live, ProjectId.of(kept).scope("counter"));
				assert.notInclude(live, ProjectId.of(revoked).scope("counter"));
				// Neither skipped folder is open, so the saved list stops naming them.
				assert.deepStrictEqual(yield* savedFolders(home), [first, kept]);
			}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
		TIMEOUT,
	);
});

describe("a project node running a global program", () => {
	it.live(
		"stops with its project's close, checkpoints into the project's state, and the reopen succeeds",
		() =>
			Effect.gen(function* () {
				const home = scratchHome("projects-global-node");
				const first = projectWith("planned-counter");
				const second = projectWith("runs-global-log");
				const watch = ProjectId.of(second).scope("watch");
				const {kernel} = yield* trustedBoot({global: fixture("log-global"), project: first, home});

				assert.isTrue((yield* openAnswering(kernel, second, "trust")).ok);
				assert.includeMembers([...(yield* liveIds(kernel))], ["log", watch]);
				assert.include(manifestIds(homeStateDir(second, home)), watch);
				assert.notInclude(manifestIds(homeStateDir(first, home)), watch);

				const closed = yield* spell(kernel, ["project", "close"], {folder: second});
				assert.isTrue(closed.ok, JSON.stringify(closed));
				const after = yield* liveIds(kernel);
				assert.notInclude(after, watch);
				assert.include(after, "log");

				const reopened = yield* spell(kernel, ["project", "open"], {folder: second});
				assert.isTrue(reopened.ok, JSON.stringify(reopened));
				assert.lengthOf(
					(yield* liveIds(kernel)).filter((id) => id === watch),
					1,
				);
			}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
		TIMEOUT,
	);
});

describe("a project reopened on restart", () => {
	it.live(
		"reports each row it refuses by name, beside the boot project's",
		() =>
			Effect.gen(function* () {
				const home = scratchHome("projects-restart-refused");
				const first = projectWith("planned-counter");
				const kept = projectWith("sdk-out-of-range-counter");
				yield* saveOpenProjects(
					home,
					OpenProjects.restoring({
						version: 1,
						projects: [{folder: kept}],
						trusted: [kept],
						recommends: [],
						recent: [],
					}),
				);

				const {kernel, report} = yield* trustedBoot({
					global: fixture("log-global"),
					project: first,
					home,
				});
				assert.deepStrictEqual(report.reopened, [kept]);
				const messages = report.refused.map((each) => each.message);
				const refusal = messages.find((message) => message.includes("future-counter"));
				assert.isDefined(refusal, JSON.stringify(messages));
				assert.include(refusal, ProjectId.of(kept).key);
				assert.include(yield* liveIds(kernel), ProjectId.of(kept).scope("main"));
			}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
		TIMEOUT,
	);
});
