/**
 * Boots a desk over a project whose config imports three program files, edits them and the helpers
 * they call between reloads, and prints what the live processes held at each step as the last line of stdout, in JSON.
 * `./hot-swap.unit.test.ts` runs it as a child for the same reason `./module-generations.probe.ts`
 * is one: only a plain `node` process re-reads a file the config imports by path.
 *
 *   node src/hot-swap.probe.ts <empty-project-dir> <scratch-home>
 */

import {mkdirSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {NodeFileSystem} from "@effect/platform-node";
import {Processes} from "@kampus/tuval-sdk/kernel/process/Processes";
import {type ProcessHandle, ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {Effect, Option} from "effect";
import {type Booted, boot} from "./boot.ts";

const [project, home] = process.argv.slice(2);
if (project === undefined || home === undefined) {
	throw new Error("usage: hot-swap.probe.ts <empty-project-dir> <scratch-home>");
}

interface TallyCode {
	/** What a `bump` adds, and the name it stamps on the state. */
	readonly step: number;
	readonly by: string;
	readonly version: string;
}

/**
 * The edited program, import-free so it resolves from a temp dir. Its `init` reads back only a state
 * its own version wrote, and turns any other into its refused-restore state.
 */
const tallySource = ({step, by, version}: TallyCode): string => `
const reads = (raw) => raw !== null && typeof raw === "object" && raw.version === ${JSON.stringify(version)};
export const tally = {
	id: "tally",
	core: {
		init: (loaded) => [
			loaded === null || loaded === undefined
				? {version: ${JSON.stringify(version)}, count: 0, by: ${JSON.stringify(by)}}
				: reads(loaded) ? loaded : {refused: loaded},
			[],
		],
		update: {
			bump: (state) => [
				"refused" in state ? state : {...state, count: state.count + ${step}, by: ${JSON.stringify(by)}},
				[],
			],
		},
	},
	ports: {},
	handlers: {},
	capabilities: [],
	identity: {package: "probe", program: "tally", version: ${JSON.stringify(version)}, digest: "sha256:tally"},
	placement: {host: "local"},
};
`;

/** The program no step edits. Its `init` counts the runs it has booted, so a restart shows. */
const steadySource = `
export const steady = {
	id: "steady",
	core: {
		init: (loaded) => [{boots: (loaded?.boots ?? 0) + 1, seen: loaded?.seen ?? 0}, []],
		update: {see: (state) => [{...state, seen: state.seen + 1}, []]},
	},
	ports: {},
	handlers: {},
	capabilities: [],
	identity: {package: "probe", program: "steady", version: "1.0.0", digest: "sha256:steady"},
	placement: {host: "local"},
};
`;

/**
 * The program whose edits stay inside helpers: `restore`, in its own file, which its `init` calls,
 * and `shout`, in a file it imports. Its rows' functions carry types, so their text is what Node's
 * type stripping left, not the file as written.
 */
const echoSource = (restoredBy: string): string => `
import {shout} from "./shout.ts";
type Echo = {readonly said: string; readonly restoredBy: string};
const restore = (loaded: Partial<Echo> | null | undefined): Echo => ({
	said: loaded?.said ?? "",
	restoredBy: ${JSON.stringify(restoredBy)},
});
export const echo = {
	id: "echo",
	core: {
		init: (loaded: Partial<Echo> | null | undefined) => [restore(loaded), []],
		update: {say: (state: Echo, msg: {readonly text: string}) => [{...state, said: shout(msg.text)}, []]},
	},
	ports: {},
	handlers: {},
	capabilities: [],
	identity: {package: "probe", program: "echo", version: "1.0.0", digest: "sha256:echo"},
	placement: {host: "local"},
};
`;

const shoutSource = (suffix: string): string =>
	`export const shout = (text: string): string => text.toUpperCase() + ${JSON.stringify(suffix)};\n`;

const configSource = `
import {echo} from "../programs/echo.ts";
import {steady} from "../programs/steady.ts";
import {tally} from "../programs/tally.ts";
export default {
	version: 1,
	programs: [tally, steady, echo],
	graph: {nodes: [
		{id: "tally", program: "tally", on: []},
		{id: "steady", program: "steady", on: []},
		{id: "echo", program: "echo", on: []},
	]},
};
`;

const tallyFile = join(project, "programs", "tally.ts");
const echoFile = join(project, "programs", "echo.ts");
const shoutFile = join(project, "programs", "shout.ts");
mkdirSync(join(project, ".tuval"), {recursive: true});
mkdirSync(join(project, "programs"), {recursive: true});
writeFileSync(join(project, "package.json"), JSON.stringify({type: "module"}));
writeFileSync(join(project, ".tuval", "tuval.config.ts"), configSource);
writeFileSync(join(project, "programs", "steady.ts"), steadySource);
writeFileSync(tallyFile, tallySource({step: 1, by: "v1", version: "1.0.0"}));
writeFileSync(echoFile, echoSource("restore-v1"));
writeFileSync(shoutFile, shoutSource("!"));

const handleOf = (booted: Booted, id: string) =>
	Processes.use((processes) => processes.handle(ProcessId.make(id))).pipe(
		Effect.flatMap((handle) =>
			Option.match(handle, {
				onNone: () => Effect.die(`no live process "${id}"`),
				onSome: (live): Effect.Effect<ProcessHandle> => Effect.succeed(live),
			}),
		),
		Effect.provideContext(booted.kernel),
	);

const reloaded = (booted: Booted) =>
	booted.reload.pipe(
		Effect.match({
			onSuccess: (report) => ({
				switched: report.switched,
				restoreRefused: report.restoreRefused,
				pending: report.pending,
			}),
			onFailure: (refused) => ({refused: refused.message}),
		}),
	);

const probe = Effect.gen(function* () {
	const booted = yield* boot({global: join(project, "no-global-layer.ts"), project, home});
	const tally = yield* handleOf(booted, "tally");
	const steady = yield* handleOf(booted, "steady");
	yield* tally.dispatch({type: "bump"});
	yield* tally.dispatch({type: "bump"});
	yield* steady.dispatch({type: "see"});
	const before = {tally: tally.getState(), steady: steady.getState()};

	writeFileSync(tallyFile, tallySource({step: 10, by: "v2", version: "1.0.0"}));
	const edited = yield* reloaded(booted);
	const afterEdit = {tally: tally.getState(), handle: (yield* handleOf(booted, "tally")).id};
	yield* tally.dispatch({type: "bump"});
	const bumped = tally.getState();

	writeFileSync(tallyFile, 'throw new Error("tally is half-edited");\n');
	const broken = yield* reloaded(booted);
	yield* tally.dispatch({type: "bump"});
	const afterBroken = tally.getState();

	writeFileSync(tallyFile, tallySource({step: 1, by: "v3", version: "2.0.0"}));
	const bumpedVersion = yield* reloaded(booted);
	const afterVersion = tally.getState();

	const echo = yield* handleOf(booted, "echo");
	yield* echo.dispatch({type: "say", text: "hi"});
	const echoBefore = echo.getState();

	const unedited = yield* reloaded(booted);

	writeFileSync(echoFile, echoSource("restore-v2"));
	const restoreEdited = yield* reloaded(booted);
	const afterRestoreEdit = echo.getState();

	writeFileSync(shoutFile, shoutSource("?"));
	const shoutEdited = yield* reloaded(booted);
	yield* echo.dispatch({type: "say", text: "again"});
	const afterShoutEdit = echo.getState();

	return {
		before,
		edited,
		afterEdit,
		bumped,
		broken,
		afterBroken,
		bumpedVersion,
		afterVersion,
		echoBefore,
		unedited,
		restoreEdited,
		afterRestoreEdit,
		shoutEdited,
		afterShoutEdit,
		steady: steady.getState(),
	};
});

const outcome = await Effect.runPromise(
	probe.pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);
console.log(JSON.stringify(outcome));
