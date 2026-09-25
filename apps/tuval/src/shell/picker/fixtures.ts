/**
 * The doubles the picker's proofs run against: a registry built from real `Program` rows and a
 * process table that records every spawn. Both are the real service interfaces — `Registry.layer`
 * is the shipped one — so a test that passes here is a test against the shapes the kernel serves.
 */

import type {Cmd} from "@demlik/tea";
import {SessionOpening} from "@kampus/tuval-sdk/kernel/ai-agent/opening";
import {CallingWindow} from "@kampus/tuval-sdk/kernel/commands/scope";
import type {WindowId as CallWindowId} from "@kampus/tuval-sdk/kernel/commands/spell";
import {
	ForgetRefused,
	ProcessIsPlanned,
	ProcessNotFound,
} from "@kampus/tuval-sdk/kernel/process/errors";
import {
	Processes,
	type RemoveError,
	type SpawnOptions,
} from "@kampus/tuval-sdk/kernel/process/Processes";
import {ProcessTable} from "@kampus/tuval-sdk/kernel/process/ProcessTable";
import {
	type Lifecycle,
	type ProcessChange,
	type ProcessHandle,
	ProcessId,
	type ProcessRow,
} from "@kampus/tuval-sdk/kernel/process/process";
import {noSelfReport} from "@kampus/tuval-sdk/kernel/process/self-report";
import {defineMachine} from "@kampus/tuval-sdk/kernel/registry/machine";
import {type AnyProgram, type Program, ProgramId} from "@kampus/tuval-sdk/kernel/registry/program";
import {Registry} from "@kampus/tuval-sdk/kernel/registry/Registry";
import {WindowId} from "@kampus/tuval-sdk/kernel/shell/window/host";
import {Context, Effect, Exit, Layer, Option, PubSub, type Scope, Stream} from "effect";
import {ProcessTablePort} from "../../table/ProcessTablePort.ts";
import {toTableRow} from "../../table/row.ts";

type CountState = {readonly count: number};
type CountMsg = {readonly type: "tick"};

const core = defineMachine<CountState, CountMsg, Cmd<never>, never, unknown>({
	init: (loaded) => [loaded ?? {count: 0}, []],
	update: {tick: (state) => [{count: state.count + 1}, []]},
});

export const programRow = (
	id: string,
	options?: {
		readonly label?: string;
		readonly renderer?: boolean;
		readonly takesKeys?: boolean;
	},
): AnyProgram =>
	({
		id: ProgramId.make(id),
		core,
		ports: {},
		handlers: {},
		capabilities: [],
		...(options?.label === undefined ? {} : {label: options.label}),
		...(options?.takesKeys === true ? {takesKeys: true} : {}),
		...(options?.renderer === false
			? {}
			: {renderer: {kind: "host-native" as const, ref: `tuval/${id}`}}),
		identity: {package: "@kampus/tuval", program: id, version: "1.0.0", digest: `sha256:${id}`},
		placement: {host: "local"},
	}) satisfies Program<CountState, CountMsg, Cmd<never>, never, unknown, never, never>;

export const windowId = (name: string): WindowId => WindowId.make(name);
export const processId = (name: string): ProcessId => ProcessId.make(name);
export const programId = (name: string): ProgramId => ProgramId.make(name);

/** One spawn as the double recorded it — the whole evidence "exactly one process, under the shell". */
export interface SpawnCall {
	readonly programId: ProgramId;
	readonly parent: ProcessId | undefined;
	readonly spawned: ProcessId;
	/**
	 * The session this spawn was for, read back out of the context it was handed. Recorded because
	 * a `{cwd, resume}` that never reaches the child is the failure that looks exactly like a
	 * success from the outside (epic #8070, ruling 2).
	 */
	readonly session: {readonly cwd: string; readonly resume: string | null} | undefined;
	/**
	 * The window the child was told it was opened into, read back out of the same context. Recorded
	 * for the reason `session` is: a window that never reaches the child leaves every kernel call
	 * the child makes parented by nobody, and nothing on this side of the spawn shows it (#8758).
	 */
	readonly window: CallWindowId | undefined;
}

export interface PickerHarness {
	readonly spawns: () => ReadonlyArray<SpawnCall>;
	/** Put a process in the table without going through `spawn`, as a prior mount would have left it. */
	readonly seed: (id: string, programId: string, parent?: string) => Effect.Effect<ProcessId>;
	readonly layer: Layer.Layer<Registry | Processes | ProcessTable | ProcessTablePort>;
}

/**
 * A registry over `rows` plus a process table the test drives. `spawn` mints `process-1`,
 * `process-2`, … in call order, so an assertion can name the id a choice must have produced
 * without reaching for a UUID.
 */
export const pickerHarness = (
	rows: ReadonlyArray<AnyProgram>,
	options?: {readonly spawnFails?: string},
): Effect.Effect<PickerHarness, never, Scope.Scope> =>
	Effect.gen(function* () {
		// Every handle the double hands back shares the test's own Scope: nothing here runs an actor,
		// so a per-process Scope would only be a value nobody closes.
		const scope = yield* Effect.scope;
		const table = new Map<ProcessId, ProcessRow>();
		const calls: Array<SpawnCall> = [];
		const changes = yield* PubSub.unbounded<ProcessChange>();
		let minted = 0;

		const put = (id: ProcessId, programId: ProgramId, parent: ProcessId | undefined) => {
			const lifecycle: Lifecycle = "running";
			const row: ProcessRow = {
				id,
				programId,
				parentId: Option.fromNullishOr(parent),
				ports: {},
				stateSummary: () => ({lifecycle, revision: 0, state: {count: 0}}),
				selfReport: () => noSelfReport,
			};
			table.set(id, row);
			return row;
		};

		const seed = (id: string, programId: string, parent?: string) =>
			Effect.sync(() => {
				const made = ProcessId.make(id);
				put(
					made,
					ProgramId.make(programId),
					parent === undefined ? undefined : ProcessId.make(parent),
				);
				return made;
			});

		const spawn = (programId: ProgramId, spawnOptions?: SpawnOptions) =>
			Effect.suspend(() => {
				if (options?.spawnFails === programId) {
					return Effect.fail(new ProcessNotFound({id: ProcessId.make(programId)}));
				}
				minted += 1;
				const id = ProcessId.make(`process-${minted}`);
				const row = put(id, programId, spawnOptions?.parent);
				const opening =
					spawnOptions === undefined
						? Option.none()
						: Context.getOption(spawnOptions.services, SessionOpening);
				const shown =
					spawnOptions === undefined
						? Option.none()
						: Context.getOption(spawnOptions.services, CallingWindow);
				calls.push({
					programId,
					parent: spawnOptions?.parent,
					spawned: id,
					session: Option.getOrUndefined(opening),
					window: Option.getOrUndefined(Option.map(shown, (held) => held.window)),
				});
				const handle: ProcessHandle = {
					id,
					programId,
					parentId: row.parentId,
					scope,
					dispatch: () => Effect.void,
					dispatchFolded: () =>
						Effect.succeed({
							settled: Exit.void,
							summary: {lifecycle: "running" as const, revision: 0, state: {count: 0}},
						}),
					getState: () => ({count: 0}),
					stop: Effect.void,
				};
				return Effect.succeed(handle);
			});

		const processTable = ProcessTable.of({
			list: Effect.sync(() => [...table.values()]),
			get: (id) =>
				Effect.suspend(() => {
					const row = table.get(id);
					return row === undefined ? Effect.fail(new ProcessNotFound({id})) : Effect.succeed(row);
				}),
			changes: Stream.fromPubSub(changes),
		});

		const port = ProcessTablePort.of({
			rows: Effect.sync(() => [...table.values()].map(toTableRow)),
			changes: Stream.map(Stream.fromPubSub(changes), (change) => ({
				kind: change.kind,
				row: toTableRow(change.row),
			})),
			feed: () => Effect.void,
		});

		const layer = Layer.mergeAll(
			Registry.layer(rows).pipe(Layer.orDie),
			// `handle` answers none: the picker never dispatches into what it spawned, so a double that
			// pretended to hand back a live actor would be claiming more than these tests exercise.
			Layer.succeed(
				Processes,
				Processes.of({
					spawn,
					stop: () => Effect.void,
					remove: () => Effect.void,
					handle: () => Effect.succeed(Option.none()),
				}),
			),
			Layer.succeed(ProcessTable, processTable),
			Layer.succeed(ProcessTablePort, port),
		);

		return {spawns: () => [...calls], seed, layer};
	});

export const shellProcessId = ProcessId.make("shell-process");

/** Which refusal a scripted `Processes.remove` answers with, or none at all. */
export type RemoveRefusal = "planned" | "forget" | "missing";

export interface RemoveHarness {
	/** Every id `remove` was called with, in call order — including the calls that were refused. */
	readonly removed: () => ReadonlyArray<ProcessId>;
	readonly layer: Layer.Layer<Processes>;
}

/**
 * A `Processes` whose `remove` records its argument and answers with one scripted refusal. Only
 * `remove` is served: the removal handler needs nothing else, and a double that stood in for `spawn`
 * as well would be claiming more than `./remove.unit.test.ts` exercises.
 *
 * The `forget` arm's cause rides as the defect `ForgetRefused` declares it to be, so the reason the
 * window renders is read off the cause rather than composed by the handler. Nothing here names the
 * durability slice: no file under `src/shell/` may (`../program.unit.test.ts` scans for it).
 */
export const removeHarness = (options?: {
	readonly refuseWith?: RemoveRefusal;
	/** The `forget` arm's cause message — what the window is expected to end up rendering. */
	readonly reason?: string;
}): Effect.Effect<RemoveHarness> =>
	Effect.sync(() => {
		const calls: Array<ProcessId> = [];
		const refusalOf = (id: ProcessId): Effect.Effect<void, RemoveError> => {
			switch (options?.refuseWith) {
				case "planned":
					return Effect.fail(new ProcessIsPlanned({id}));
				case "forget":
					return Effect.fail(
						new ForgetRefused({id, cause: new Error(options?.reason ?? "the store refused")}),
					);
				case "missing":
					return Effect.fail(new ProcessNotFound({id}));
				default:
					return Effect.void;
			}
		};
		return {
			removed: () => [...calls],
			layer: Layer.succeed(
				Processes,
				Processes.of({
					spawn: () => Effect.die(new Error("test setup: this harness serves remove only")),
					stop: () => Effect.void,
					remove: (id) =>
						Effect.suspend(() => {
							calls.push(id);
							return refusalOf(id);
						}),
					handle: () => Effect.succeed(Option.none()),
				}),
			),
		};
	});

/** The services a picker call needs, as one context — what a test provides in one line. */
export type PickerServices = Context.Context<
	Registry | Processes | ProcessTable | ProcessTablePort
>;
