/**
 * A commit publishes whatever its Cmds do. The state a Msg produced is applied and checkpointed
 * before any handler runs, so the process's public revision is owed it either way — and before
 * #8538 it was not: `Tuval.host.commit` ran `onCommit` after `runInterpret` in the same error
 * channel, so a failing handler aborted the commit before the `revision++` and the
 * `state-changed` publish that live in `Processes.spawn`'s `onCommit`.
 *
 * The pairing is the point. One program and one Msg, spawned twice: wired ports (a graph-planned
 * process) and `unwired` ports (what `../shell/picker/open.ts` grants everything it opens, so
 * every emit fails `PortNotWired`). Both must reach revision 1 — the wired case passed before the
 * fix, the unwired one answered `{count: 1}` at revision 0, which is the picker-opened window
 * painting its first state forever. Two cases rather than one because that asymmetry is what
 * distinguishes this process's publication stopping from a desk-wide transport failure.
 */

import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer} from "effect";
import {counterId, counterProgram} from "../demo/counter.ts";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {memoryStores} from "../durability/stores.ts";
import {NodeId} from "../ports/graph.ts";
import {ProcessPorts, unwired} from "../ports/ProcessPorts.ts";
import {Registry} from "../registry/Registry.ts";
import {Processes} from "./Processes.ts";

/** Ports that accept every emit, standing in for a graph route to this process's `ticks`. */
const wired = ProcessPorts.of({emit: () => Effect.succeed([])});

/** Spawn the demo counter with `ports`, drive one `key`, and read the fold's own summary. */
const dispatchOnce = (ports: Context.Service.Shape<typeof ProcessPorts>) =>
	Effect.gen(function* () {
		const processes = yield* Processes;
		const handle = yield* processes.spawn(counterId, {
			services: Context.make(ProcessPorts, ports),
		});
		return (yield* handle.dispatchFolded({type: "key", key: "a"})).summary;
	}).pipe(
		Effect.provide(
			Processes.layer.pipe(
				Layer.provide([
					// `everyMs: null` so the only commit under test is the dispatched one.
					Registry.layer([counterProgram({everyMs: null})]),
					Checkpoints.layer(memoryStores()),
				]),
			),
		),
		Effect.scoped,
	);

describe("a commit publishes however its Cmds settle", () => {
	it.effect("a process whose Cmd handler succeeds advances its revision", () =>
		Effect.gen(function* () {
			const summary = yield* dispatchOnce(wired);

			assert.deepStrictEqual(summary.state, {count: 1});
			assert.strictEqual(summary.revision, 1);
		}),
	);

	it.effect("a process whose Cmd handler fails advances its revision too", () =>
		Effect.gen(function* () {
			const summary = yield* dispatchOnce(unwired(NodeId.make("window-0")));

			// The Msg applied: the reducer ran and the state was checkpointed before `announce`.
			assert.deepStrictEqual(summary.state, {count: 1});
			// And the world was told. This read 0 before #8538 — the window's stale count.
			assert.strictEqual(summary.revision, 1);
		}),
	);
});
