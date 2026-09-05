/**
 * Restore's services, over the two boots that make them visible: a process the picker spawned is no
 * graph node, so `restore` is the only thing that brings it back, and what it brings back has to
 * carry what its handlers require.
 *
 * Two halves. The `ProcessPorts` one (#7789) runs on the demo counter, whose `announce` both
 * requires that service and emits on it. The kernel-context one (#7951) runs on a local probe row
 * whose handler needs a kernel service: both spawners now hand over the same kernel context, so the
 * restored process resolves it exactly as the freshly spawned one did.
 */

import {defineMachine} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer, Option} from "effect";
import {SpawnedProcesses} from "../commands/core/process.ts";
import {counterId, counterProgram} from "../demo/counter.ts";
import {PortNotWired} from "../ports/errors.ts";
import {NodeId} from "../ports/graph.ts";
import {HandlerFailed} from "../process/errors.ts";
import {Processes} from "../process/Processes.ts";
import {ProcessTable} from "../process/ProcessTable.ts";
import type {ProcessId} from "../process/process.ts";
import {type AnyProgram, type Program, ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {Checkpoints} from "./Checkpoints.ts";
import {restore} from "./restore.ts";
import {type CheckpointStores, memoryStores} from "./stores.ts";

const counterRows = [counterProgram({everyMs: null})];

/**
 * A kernel service `restore` itself does not need — `SpellBridge` is the real one (`src/boot.ts`),
 * and this stands in for it without dragging the spell machinery into this file. Being outside
 * restore's own four requirements is what makes the probe below falsifiable: the context around a
 * restore already holds those four, so a handler needing one of them would resolve it whatever
 * `SpawnOptions.services` said.
 */
class ProbeMark extends Context.Service<ProbeMark, {readonly label: string}>()(
	"tuval/test/ProbeMark",
) {
	static readonly layer = Layer.succeed(ProbeMark, {label: "from-the-kernel"});
}

/** One boot's kernel; the state dir is the caller's, so two of these share what was checkpointed. */
const kernel = (stores: CheckpointStores, rows: ReadonlyArray<AnyProgram>) =>
	Layer.mergeAll(SpawnedProcesses.layer({readTimeout: "1 second"}), ProbeMark.layer).pipe(
		Layer.provideMerge(Processes.layer),
		Layer.provideMerge(Layer.mergeAll(Registry.layer(rows), Checkpoints.layer(stores))),
	);

/** The picker's spawn path: a process under no node, checkpointed, then left for the next boot. */
const firstBoot = (stores: CheckpointStores) =>
	Effect.gen(function* () {
		const spawned = yield* SpawnedProcesses;
		return yield* spawned.spawn(counterId, Option.none());
	}).pipe(Effect.provide(kernel(stores, counterRows)), Effect.orDie);

/**
 * The second boot: restore, then tick the process back. `announce` is a Cmd handler, so what its
 * emit fails with reaches the dispatcher wrapped in `HandlerFailed`.
 */
const secondBoot = (id: ProcessId, stores: CheckpointStores) =>
	Effect.gen(function* () {
		const restored = yield* restore(Context.empty());
		assert.deepStrictEqual(
			restored.map((handle) => handle.id),
			[id],
		);
		const handle = restored[0]!;
		const raised = yield* handle.dispatch({type: "tick"}).pipe(Effect.flip);
		assert.instanceOf(raised, HandlerFailed);
		const failure = raised as HandlerFailed;
		const live = yield* ProcessTable.use((table) => table.list);
		return {failure, state: handle.getState(), live: live.map((row) => row.id)};
	}).pipe(Effect.provide(kernel(stores, counterRows)), Effect.orDie);

describe("restore's services", () => {
	it.effect("a picker-spawned process comes back with the ProcessPorts its handler requires", () =>
		Effect.gen(function* () {
			const stores = memoryStores();
			const id = yield* firstBoot(stores);

			const {failure, state, live} = yield* secondBoot(id, stores);

			// Reaching the emit is the proof the service was there: before #7789 the handler died on
			// the empty context restore spawned it with, one step earlier.
			assert.strictEqual(failure.programId, counterId);
			assert.strictEqual(failure.cmdType, "announce");
			assert.instanceOf(failure.cause, PortNotWired);
			assert.deepStrictEqual(state, {count: 1});
			assert.deepStrictEqual(live, [id]);
		}),
	);

	it.effect("its emit fails PortNotWired naming the restored process and the port", () =>
		Effect.gen(function* () {
			const stores = memoryStores();
			const id = yield* firstBoot(stores);

			const {failure} = yield* secondBoot(id, stores);

			const cause = failure.cause as PortNotWired;
			assert.instanceOf(cause, PortNotWired);
			assert.strictEqual(cause.node, NodeId.make(id));
			assert.strictEqual(cause.port, "ticks");
			assert.include(cause.message, "ticks");
		}),
	);
});

const probeId = ProgramId.make("kernel-probe");

interface ProbeState {
	readonly looks: number;
}
type ProbeMsg = {readonly type: "look"};
type ProbeCmd = {readonly type: "count"};

/**
 * A row whose one handler needs a kernel service and no ports — the shape a picker-opened Claude row
 * has once its layer's own requirement rides out onto the row (#7951). It reports through a sink the
 * test owns rather than a follow-up Msg: the host dispatches follow-ups unawaited
 * (`src/host/actor.ts`), so a state read after `dispatch` would race one.
 */
const probeProgram = (sink: Array<string>): AnyProgram =>
	({
		id: probeId,
		core: defineMachine<ProbeState, ProbeMsg, ProbeCmd, never, unknown>({
			init: (loaded) => [loaded ?? {looks: 0}, []],
			update: {look: (state) => [{looks: state.looks + 1}, [{type: "count"}]]},
			subs: [],
			interpret: {count: () => Promise.resolve()},
		}),
		ports: {},
		handlers: {
			count: () =>
				Effect.gen(function* () {
					const mark = yield* ProbeMark;
					sink.push(mark.label);
					return [] as ReadonlyArray<ProbeMsg>;
				}),
		},
		capabilities: [],
		renderer: {kind: "host-native", ref: "tuval/test/kernel-probe"},
		identity: {
			package: "@kampus/tuval",
			program: "kernel-probe",
			version: "1.0.0",
			digest: "sha256:kernel-probe",
		},
		placement: {host: "local"},
	}) satisfies Program<ProbeState, ProbeMsg, ProbeCmd, never, unknown, never, ProbeMark>;

const probeKernel = (stores: CheckpointStores, sink: Array<string>) =>
	Layer.build(kernel(stores, [probeProgram(sink)]));

/** The picker's open path (`src/shell/picker/open.ts`): a process under no node, given the kernel. */
const probeFirstBoot = (stores: CheckpointStores, sink: Array<string>) =>
	Effect.gen(function* () {
		const kernelContext = yield* probeKernel(stores, sink);
		const handle = yield* Context.get(kernelContext, Processes).spawn(probeId, {
			services: kernelContext,
		});
		yield* handle.dispatch({type: "look"});
		return handle.id;
	}).pipe(Effect.scoped, Effect.orDie);

/**
 * Boot's restore path (`src/boot.ts`): the same kernel context, to what the graph never planned.
 * `restore` itself is run over its own four requirements and nothing else, so `ProbeMark` can only
 * reach the process through `services` — which is what makes the assertion below falsifiable.
 */
const probeSecondBoot = (stores: CheckpointStores, sink: Array<string>) =>
	Effect.gen(function* () {
		const kernelContext = yield* probeKernel(stores, sink);
		const restored = yield* restore(kernelContext).pipe(
			Effect.provideContext(
				Context.pick(Checkpoints, Processes, ProcessTable, Registry)(kernelContext),
			),
		);
		const handle = restored[0]!;
		yield* handle.dispatch({type: "look"});
		return {id: handle.id, state: handle.getState()};
	}).pipe(Effect.scoped, Effect.orDie);

describe("restore's kernel context", () => {
	it.effect("a restored picker-opened process resolves the kernel service its handler needs", () =>
		Effect.gen(function* () {
			const stores = memoryStores();
			const fresh: Array<string> = [];
			const id = yield* probeFirstBoot(stores, fresh);

			const restored: Array<string> = [];
			const second = yield* probeSecondBoot(stores, restored);

			assert.strictEqual(second.id, id);
			// The handler resolved the service on both boots, so what the restored process was given
			// is what the freshly spawned one was given.
			assert.deepStrictEqual(fresh, ["from-the-kernel"]);
			assert.deepStrictEqual(restored, ["from-the-kernel"]);
			// Two looks, one per boot — the second folded onto the state the first checkpointed.
			assert.deepStrictEqual(second.state, {looks: 2});
		}),
	);
});
