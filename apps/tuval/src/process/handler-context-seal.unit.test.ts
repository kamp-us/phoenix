/**
 * The seal: a handler resolves its spawn set and nothing else. Before #7972 `toDefinition` put
 * `Effect.provideContext(services)` on each handler, which merges into the fiber's context rather
 * than replacing it (rc.112, `src/internal/effect.ts:2197`), so the same handler resolved a service
 * on one dispatch path and not on another — and a spawn guard written as a removal, like the
 * picker's `Context.omit(ProcessPorts)`, removed nothing.
 *
 * The two paths carry different ambients, which is what makes the disagreement observable:
 * `handle.dispatch` runs `dispatchOnce` on the caller's own fiber (`../host/actor.ts:476`, `484`),
 * while a follow-up Msg goes through `dispatchUnawaited`, an `Effect.runFork` that carries none
 * (`../host/actor.ts:190`). One Msg is driven down both here and the two answers compared, because
 * "the paths agree" is the property, not just "the first one is sealed".
 */

import {defineMachine} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Cause, Context, Effect, Layer} from "effect";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {memoryStores} from "../durability/stores.ts";
import {type AnyProgram, type Program, ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {Processes} from "./Processes.ts";
import type {ProcessTable} from "./ProcessTable.ts";

/** The service under test: never in a spawn set unless a case puts it there. */
class Leak extends Context.Service<Leak, {readonly mark: string}>()("tuval/test/Leak") {}

type State = {readonly probes: number};
type Msg = {readonly type: "probe"} | {readonly type: "probe-again"};
type ProbeCmd = {readonly type: "probe"; readonly path: "direct" | "follow-up"};

/** What one handler saw: the service's own mark, or the message the resolution died with. */
interface Sighting {
	readonly path: ProbeCmd["path"];
	readonly saw: string;
}

const messageOf = (cause: Cause.Cause<never>): string => {
	const error: unknown = Cause.squash(cause);
	return error instanceof Error ? error.message : String(error);
};

const readLeak = (path: ProbeCmd["path"], seen: Array<Sighting>) =>
	Effect.map(Leak, (leak) => leak.mark).pipe(
		Effect.catchCause((cause) => Effect.succeed(messageOf(cause))),
		Effect.tap((saw) => Effect.sync(() => void seen.push({path, saw}))),
	);

/**
 * One `probe` Msg reaches both dispatch paths: its reduce emits the `probe` Cmd, whose handler
 * follows up with `probe-again`, and that follow-up's own Cmd runs on the forked fiber. The row
 * declares no `init` Cmd, so nothing is probed on the spawner's fiber — a third ambient, and not
 * the disagreement under test.
 */
const proberProgram = (seen: Array<Sighting>): AnyProgram =>
	({
		id: ProgramId.make("prober"),
		core: defineMachine<State, Msg, ProbeCmd, never, unknown>({
			init: (loaded) => [loaded ?? {probes: 0}, []],
			update: {
				probe: (state) => [{probes: state.probes + 1}, [{type: "probe", path: "direct"}]],
				"probe-again": (state) => [
					{probes: state.probes + 1},
					[{type: "probe", path: "follow-up"}],
				],
			},
			// Demlik's `Machine` demands a Promise `interpret` beside the row's `handlers`; the host
			// never reads it (#7576).
			interpret: {probe: () => Promise.resolve()},
		}),
		ports: {},
		handlers: {
			probe: (cmd: ProbeCmd) =>
				Effect.map(
					readLeak(cmd.path, seen),
					(): ReadonlyArray<Msg> => (cmd.path === "direct" ? [{type: "probe-again"}] : []),
				),
		},
		capabilities: [],
		identity: {
			package: "@kampus/tuval",
			program: "prober",
			version: "1.0.0",
			digest: "sha256:prober",
		},
		placement: {host: "local"},
	}) satisfies Program<State, Msg, ProbeCmd, never, unknown, never, Leak>;

const prober = ProgramId.make("prober");

const withKernel = <A, E>(
	rows: ReadonlyArray<AnyProgram>,
	body: Effect.Effect<A, E, Processes | ProcessTable>,
) =>
	body.pipe(
		Effect.provide(
			Processes.layer.pipe(
				Layer.provide([Registry.layer(rows), Checkpoints.layer(memoryStores())]),
			),
		),
	);

/**
 * Spawn with `services`, then dispatch from a fiber that holds `Leak` — the shape of the shell
 * forwarding a key into a picker-opened child (`../shell/host/effects.ts:56`).
 */
const probeFrom = (services: Context.Context<never>) => {
	const seen: Array<Sighting> = [];
	return withKernel(
		[proberProgram(seen)],
		Effect.gen(function* () {
			const processes = yield* Processes;
			const handle = yield* processes.spawn(prober, {services});
			yield* handle.dispatch({type: "probe"});
			return seen as ReadonlyArray<Sighting>;
		}),
	).pipe(Effect.provideService(Leak, {mark: "the dispatching fiber's"}), Effect.scoped);
};

describe("a handler's services are its spawn set", () => {
	it.effect("a service only the dispatching fiber holds is not resolvable, on either path", () =>
		Effect.gen(function* () {
			const sightings = yield* probeFrom(Context.empty());

			assert.deepStrictEqual(
				sightings.map((sighting) => sighting.path),
				["direct", "follow-up"],
			);
			for (const sighting of sightings) {
				assert.include(sighting.saw, "Service not found");
				assert.include(sighting.saw, "tuval/test/Leak");
			}
			// Agreement is the property, not just the first row: before the seal the direct path
			// resolved the dispatching fiber's mark and the forked one did not.
			assert.strictEqual(sightings[0]?.saw, sightings[1]?.saw);
		}),
	);

	it.effect(
		"a service the spawn set holds is resolvable on both paths, and it is the spawn's",
		() =>
			Effect.gen(function* () {
				const sightings = yield* probeFrom(Context.make(Leak, {mark: "the spawn set's"}));

				assert.deepStrictEqual(sightings, [
					{path: "direct", saw: "the spawn set's"},
					{path: "follow-up", saw: "the spawn set's"},
				]);
			}),
	);
});
