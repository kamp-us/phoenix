/**
 * `:cron run` against the cron the graph launches, on a real kernel — the case `cron.ts`'s header
 * said was impossible until #8944 landed.
 *
 * The rest of `cron.unit.test.ts` drives the program through `testProgram`, which proves the cells
 * and nothing about reach. This file proves the reach and only that: the compiled spell resolves
 * the declaring program's own live process off `ProcessTable` (`../authoring/own-process.ts`) and
 * delivers through `SpawnedProcesses.send`, whose table `src/launch/` now enrols every graph node
 * into. Before #8944 the resolution found the planned cron and the delivery refused it.
 *
 * `it.live` because the payload crosses the `run` port's queue and pump before the cell that owns
 * it has run, so the assertion waits on a real clock. Every wait is bounded.
 */

import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {PromptPayloadSchema, TurnResultSchema} from "../ai-agent/ports/index.ts";
import {defineProgram} from "../authoring/define-program.ts";
import {port} from "../authoring/port.ts";
import {SpawnedProcesses} from "../commands/core/process.ts";
import {ClientId, type Scope, WorkspaceId} from "../commands/spell.ts";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {memoryStores} from "../durability/stores.ts";
import {launch} from "../launch/launch.ts";
import {compile} from "../ports/compile.ts";
import {type Graph, NodeId} from "../ports/graph.ts";
import {open} from "../ports/wiring.ts";
import {Processes} from "../process/Processes.ts";
import {Registry} from "../registry/Registry.ts";
import {type CronState, cron} from "./cron.ts";

/**
 * A job that fits `jobShape` and answers nothing: what cron does with the answer is the other
 * tests' subject, and a run that starts is the whole of what "the spell reached it" means here.
 */
const job = defineProgram({
	id: "cron-run-job",
	ports: {prompt: port.in(PromptPayloadSchema), result: port.out(TurnResultSchema)},
	init: (): {readonly asked: number} => ({asked: 0}),
	update: {
		prompt: (state: {readonly asked: number}) => [{asked: state.asked + 1}, []],
	},
});

const cronRow = cron({everyMs: null, prompt: "what changed?", job});

const cronNode = NodeId.make("cron");

/** One node and no routes — the shape a config plans a cron as, and the shape the desk boots. */
const graph: Graph = {nodes: [{id: cronNode, program: cronRow.id, on: []}]};

const kernel = SpawnedProcesses.layer({readTimeout: "1 second"}).pipe(
	Layer.provideMerge(Processes.layer),
	Layer.provideMerge(
		Layer.mergeAll(Registry.layer([cronRow, job]), Checkpoints.layer(memoryStores())),
	),
);

const runSpell = (cronRow.spells ?? []).find((spell) => spell.path.at(-1) === "run");
if (runSpell === undefined) throw new Error("the cron row declares no `run` spell");

/** A call from outside any window: nothing about the caller narrows which process this reaches. */
const anonymous: Scope = {
	workspace: WorkspaceId.make("tuval/test"),
	client: ClientId.make("tuval/test"),
};

const launchCron = Effect.gen(function* () {
	const compiled = yield* compile(graph);
	// The same thing `boot` hands `launch`: a program row's `R` is the kernel's to satisfy, and
	// cron's `spawn` effect needs `SpawnedProcesses` and `ProcessSelf` resolved in its handlers.
	const services = yield* Effect.context<never>();
	const launched = yield* launch(compiled, yield* open(compiled), {services});
	const planned = launched.find((process) => process.node === cronNode);
	assert.isDefined(planned);
	return planned!.handle;
});

describe("`:cron run` reaches the cron the graph launched (#8944)", () => {
	it.live("starts a run on the planned process, which the spell refused before", () =>
		Effect.gen(function* () {
			const handle = yield* launchCron;
			const before = handle.getState() as CronState;
			assert.strictEqual(before.child, null);

			yield* runSpell.execute({}, anonymous) as Effect.Effect<unknown, unknown, never>;

			const state = () => handle.getState() as CronState;
			for (let attempt = 0; attempt < 200 && state().child === null; attempt++) {
				yield* Effect.sleep("5 millis");
			}
			assert.isNotNull(state().child, "`:cron run` should have started a job on the planned cron");
			// An on-demand run is not a tick, so the timer's counter is untouched — the proof that the
			// payload came in on the `run` port rather than as a dispatched `tick`.
			assert.strictEqual(state().ticks, 0);
		}).pipe(Effect.scoped, Effect.provide(kernel)),
	);
});
