/**
 * The doubles the picker's proofs run against: a registry built from real `Program` rows and a
 * process table that records every spawn. Both are the real service interfaces — `Registry.layer`
 * is the shipped one — so a test that passes here is a test against the shapes the kernel serves.
 */

import {type Cmd, defineMachine} from "@demlik/tea";
import {type Context, Effect, Layer, Option, PubSub, type Scope, Stream} from "effect";
import {ProcessNotFound} from "../../process/errors.ts";
import {Processes, type SpawnOptions} from "../../process/Processes.ts";
import {ProcessTable} from "../../process/ProcessTable.ts";
import {
	type Lifecycle,
	type ProcessChange,
	type ProcessHandle,
	ProcessId,
	type ProcessRow,
} from "../../process/process.ts";
import {type AnyProgram, type Program, ProgramId} from "../../registry/program.ts";
import {Registry} from "../../registry/Registry.ts";
import {ProcessTablePort} from "../../table/ProcessTablePort.ts";
import {toTableRow} from "../../table/row.ts";
import {WindowId} from "../window/host.ts";

type CountState = {readonly count: number};
type CountMsg = {readonly type: "tick"};

const core = defineMachine<CountState, CountMsg, Cmd<never>, never, unknown>({
	init: (loaded) => [loaded ?? {count: 0}, []],
	update: {tick: (state) => [{count: state.count + 1}, []]},
});

export const programRow = (
	id: string,
	options?: {readonly label?: string; readonly renderer?: boolean},
): AnyProgram =>
	({
		id: ProgramId.make(id),
		core,
		ports: {},
		handlers: {},
		capabilities: [],
		...(options?.label === undefined ? {} : {label: options.label}),
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
				calls.push({programId, parent: spawnOptions?.parent, spawned: id});
				const handle: ProcessHandle = {
					id,
					programId,
					parentId: row.parentId,
					scope,
					dispatch: () => Effect.void,
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
			Layer.succeed(Processes, Processes.of({spawn, stop: () => Effect.void})),
			Layer.succeed(ProcessTable, processTable),
			Layer.succeed(ProcessTablePort, port),
		);

		return {spawns: () => [...calls], seed, layer};
	});

export const shellProcessId = ProcessId.make("shell-process");

/** The services a picker call needs, as one context — what a test provides in one line. */
export type PickerServices = Context.Context<
	Registry | Processes | ProcessTable | ProcessTablePort
>;
