/**
 * Subprojects in a running desk (#9689): a program in a scratch-home desk's project opens a folder
 * under that project, and the subproject opens with no trust question, reads under its parent's
 * label, keeps its processes behind a boundary only its opener crosses, closes with its parent, and
 * after a restart comes back only when its opener opens it again.
 */

import {mkdirSync, mkdtempSync, realpathSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {NodeFileSystem} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Processes} from "@kampus/tuval-sdk/kernel/process/Processes";
import {ProcessTable} from "@kampus/tuval-sdk/kernel/process/ProcessTable";
import {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {Context, Effect, Option, Schedule, Schema, Stream} from "effect";
import {boot, type Kernel, projectConfig, projectDir} from "../boot.ts";
import type {OpenerState} from "../config-fixtures/subproject-opener.ts";
import {ProjectId} from "../project-id.ts";
import {scratchHome} from "../scratch-home.ts";
import {NESTING_SEPARATOR, OpenProjects, projectLabels, saveOpenProjects} from "./open-projects.ts";
import {Projects} from "./Projects.ts";
import {TrustPrompts} from "./TrustPrompts.ts";

const TIMEOUT = 60_000;

const fixture = (name: string) =>
	fileURLToPath(new URL(`../config-fixtures/${name}.ts`, import.meta.url));

/** A folder whose `.tuval/tuval.config.ts` re-exports the named fixture. */
const projectWith = (name: string): string => {
	const folder = realpathSync(mkdtempSync(join(tmpdir(), "tuval-subproject-")));
	mkdirSync(projectDir(folder));
	writeFileSync(projectConfig(folder), `export {default} from ${JSON.stringify(fixture(name))};\n`);
	return folder;
};

class Unsettled extends Schema.TaggedError<Unsettled>()("Unsettled", {what: Schema.String}) {}

/** Retry `read` until `holds`: a subproject request is carried out on a fiber of its own. */
const eventually = <A, E>(what: string, read: Effect.Effect<A, E>, holds: (value: A) => boolean) =>
	Effect.flatMap(read, (value) =>
		holds(value) ? Effect.succeed(value) : Effect.fail(new Unsettled({what})),
	).pipe(Effect.retry({schedule: Schedule.spaced("50 millis"), times: 100}));

const liveIds = (kernel: Context.Context<Kernel>) =>
	Effect.map(ProcessTable.use((table) => table.list).pipe(Effect.provideContext(kernel)), (rows) =>
		rows.map((row) => row.id as string),
	);

type OpenerMsg =
	| {readonly type: "open" | "close"; readonly folder: string}
	| {readonly type: "reach"; readonly process: string};

const dispatch = (kernel: Context.Context<Kernel>, id: string, msg: OpenerMsg) =>
	Processes.use((processes) => processes.handle(ProcessId.make(id))).pipe(
		Effect.flatMap((handle) =>
			Option.isSome(handle) ? handle.value.dispatch(msg) : Effect.die(`${id} is not live`),
		),
		Effect.provideContext(kernel),
	);

const stateOf = (kernel: Context.Context<Kernel>, id: string) =>
	ProcessTable.use((table) => table.get(ProcessId.make(id))).pipe(
		Effect.map((row) => row.stateSummary().state as OpenerState),
		Effect.provideContext(kernel),
	);

const openProjects = (kernel: Context.Context<Kernel>) => Context.get(kernel, Projects).list;

const openFolders = (kernel: Context.Context<Kernel>) =>
	Effect.map(openProjects(kernel), (open) => open.map((project) => project.folder));

/** What `process` answered for its last `reach` at `target`. */
const reach = (kernel: Context.Context<Kernel>, process: string, target: string) =>
	Effect.gen(function* () {
		yield* dispatch(kernel, process, {type: "reach", process: target});
		return (yield* stateOf(kernel, process)).reach;
	});

describe("a subproject a program opens", () => {
	it.live(
		"opens with no trust question under its parent's label, and only its opener reaches into it",
		() =>
			Effect.gen(function* () {
				const home = scratchHome("subproject-open");
				const parent = projectWith("subproject-parent");
				const sub = projectWith("subproject-child");
				const p = ProjectId.of(parent);
				const s = ProjectId.of(sub);
				const {kernel} = yield* boot({global: fixture("does-not-exist"), project: parent, home});

				yield* dispatch(kernel, p.scope("opener"), {type: "open", folder: sub});
				yield* eventually("the subproject's processes run", liveIds(kernel), (ids) =>
					ids.includes(s.scope("main")),
				);
				// Its folder holds a config, and nothing was asked: the parent's trust carries down.
				assert.deepStrictEqual(
					yield* Stream.runHead(Context.get(kernel, TrustPrompts).pending),
					Option.some([]),
				);
				const open = yield* openProjects(kernel);
				const nested = open.find((project) => project.id.key === s.key);
				assert.strictEqual(nested?.under?.parent.key, p.key);
				assert.strictEqual(nested?.under?.opener, p.scope("opener"));
				assert.deepStrictEqual(
					projectLabels(open).map(({label}) => label),
					[p.name, `${p.name}${NESTING_SEPARATOR}${s.name}`],
				);

				assert.strictEqual(yield* reach(kernel, p.scope("opener"), s.scope("main")), "reached");
				const down = yield* reach(kernel, p.scope("bystander"), s.scope("main"));
				assert.include(down, `program "bystander" in ${p.name}`);
				assert.include(down, `program "counter" in ${p.name}${NESTING_SEPARATOR}${s.name}`);
				assert.include(down, "only the program that opened the subproject reaches into it");
				const up = yield* reach(kernel, s.scope("climber"), p.scope("opener"));
				assert.include(up, `program "climber" in ${p.name}${NESTING_SEPARATOR}${s.name}`);
				assert.include(up, `program "opener" in ${p.name}`);
				assert.include(up, "a subproject cannot reach up to the project it is nested under");
				// The opener reaching its own project is no crossing.
				assert.strictEqual(
					yield* reach(kernel, p.scope("opener"), p.scope("bystander")),
					"reached",
				);
			}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
		TIMEOUT,
	);

	it.live(
		"closes with its parent, its processes stopped",
		() =>
			Effect.gen(function* () {
				const home = scratchHome("subproject-cascade");
				const first = projectWith("planned-counter");
				const parent = projectWith("subproject-parent");
				const sub = projectWith("subproject-child");
				const p = ProjectId.of(parent);
				const s = ProjectId.of(sub);
				// Trusted by a desk that ran before, so opening it asks nothing.
				yield* saveOpenProjects(home, OpenProjects.none.trust(parent));
				const {kernel} = yield* boot({global: fixture("does-not-exist"), project: first, home});
				const projects = Context.get(kernel, Projects);
				yield* projects.open(parent);

				yield* dispatch(kernel, p.scope("opener"), {type: "open", folder: sub});
				yield* eventually("the subproject opens", openFolders(kernel), (open) =>
					open.includes(sub),
				);
				yield* projects.close(parent);
				assert.deepStrictEqual(yield* openFolders(kernel), [first]);
				const live = yield* liveIds(kernel);
				assert.notInclude(live, s.scope("main"));
				assert.notInclude(live, s.scope("climber"));
				assert.notInclude(live, p.scope("opener"));
			}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
		TIMEOUT,
	);

	it.live(
		"comes back after a restart only when its opener opens it again",
		() =>
			Effect.gen(function* () {
				const home = scratchHome("subproject-restart");
				const parent = projectWith("subproject-parent");
				const kept = projectWith("subproject-child");
				const closed = projectWith("subproject-child");
				const p = ProjectId.of(parent);

				yield* Effect.gen(function* () {
					const {kernel} = yield* boot({global: fixture("does-not-exist"), project: parent, home});
					yield* dispatch(kernel, p.scope("opener"), {type: "open", folder: kept});
					yield* dispatch(kernel, p.scope("opener"), {type: "open", folder: closed});
					yield* eventually(
						"both subprojects open",
						openFolders(kernel),
						(open) => open.includes(kept) && open.includes(closed),
					);
					assert.include(yield* liveIds(kernel), ProjectId.of(closed).scope("main"));
					yield* dispatch(kernel, p.scope("opener"), {type: "close", folder: closed});
					// The close answered only once the subproject had closed and its processes stopped.
					assert.notInclude(yield* openFolders(kernel), closed);
					assert.notInclude(yield* liveIds(kernel), ProjectId.of(closed).scope("main"));
				}).pipe(Effect.scoped);

				const {kernel} = yield* boot({global: fixture("does-not-exist"), project: parent, home});
				const open = yield* eventually(
					"the opener reopens its subproject",
					openFolders(kernel),
					(folders) => folders.includes(kept),
				);
				assert.deepStrictEqual(open, [parent, kept]);
				assert.includeMembers([...(yield* liveIds(kernel))], [ProjectId.of(kept).scope("main")]);
			}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
		TIMEOUT,
	);
});
