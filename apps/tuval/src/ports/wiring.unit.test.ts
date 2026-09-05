import {assert, describe, it} from "@effect/vitest";
import {Effect, Fiber, Queue} from "effect";
import {type AnyProgram, type PortBound, ProgramId} from "../registry/index.ts";
import {Registry} from "../registry/Registry.ts";
import {compile} from "./compile.ts";
import {PayloadRejected, PortNotWired} from "./errors.ts";
import {consumer, producer} from "./fixtures.ts";
import type {Graph} from "./graph.ts";
import {NodeId} from "./graph.ts";
import {open, type Wiring} from "./wiring.ts";

const p = {node: NodeId.make("p"), port: "ticks"};
const c = {node: NodeId.make("c"), port: "ticks"};
const d = {node: NodeId.make("d"), port: "ticks"};

const fanOut: Graph = {
	nodes: [
		{
			id: p.node,
			program: ProgramId.make("producer"),
			on: [
				{port: "ticks", to: c},
				{port: "ticks", to: d},
			],
		},
		{id: c.node, program: ProgramId.make("consumer"), on: []},
		{id: d.node, program: ProgramId.make("consumer-d"), on: []},
	],
};

const oneRoute: Graph = {
	nodes: [
		{id: p.node, program: ProgramId.make("producer"), on: [{port: "ticks", to: c}]},
		{id: c.node, program: ProgramId.make("consumer"), on: []},
	],
};

const wired = <A, E>(
	rows: ReadonlyArray<AnyProgram>,
	graph: Graph,
	body: (wiring: Wiring) => Effect.Effect<A, E>,
) =>
	Effect.scoped(Effect.flatMap(Effect.flatMap(compile(graph), open), body)).pipe(
		Effect.provide(Registry.layer(rows)),
	);

const drain = (wiring: Wiring, at: typeof c): Effect.Effect<ReadonlyArray<unknown>, PortNotWired> =>
	Effect.flatMap(wiring.inbox(at), (inbox) =>
		Effect.flatMap(Queue.size(inbox), (n) =>
			n === 0 ? Effect.succeed<ReadonlyArray<unknown>>([]) : Queue.takeAll(inbox),
		),
	);

describe("ports.open", () => {
	it.effect("delivers a compatible route's messages in emit order", () =>
		Effect.gen(function* () {
			const received = yield* wired([producer, consumer()], oneRoute, (wiring) =>
				Effect.gen(function* () {
					for (const n of [1, 2, 3, 4, 5]) {
						yield* wiring.emit(p, n);
					}
					return yield* drain(wiring, c);
				}),
			);
			assert.deepStrictEqual(received, [1, 2, 3, 4, 5]);
		}),
	);

	it.effect(
		"fans one emit out to every target in compiled route order, each keeping its own order",
		() =>
			Effect.gen(function* () {
				const [deliveries, atC, atD] = yield* wired(
					[producer, consumer(), consumer("consumer-d")],
					fanOut,
					(wiring) =>
						Effect.gen(function* () {
							const first = yield* wiring.emit(p, 1);
							yield* wiring.emit(p, 2);
							return [first, yield* drain(wiring, c), yield* drain(wiring, d)] as const;
						}),
				);
				assert.deepStrictEqual(deliveries, [
					{to: c, accepted: true},
					{to: d, accepted: true},
				]);
				assert.deepStrictEqual(atC, [1, 2]);
				assert.deepStrictEqual(atD, [1, 2]);
			}),
	);

	it.effect(
		"rejects a payload the target's predicate refuses, naming node, program, port and kind",
		() =>
			Effect.gen(function* () {
				const error = yield* wired([producer, consumer()], oneRoute, (wiring) =>
					Effect.flip(wiring.emit(p, "not a number")),
				);
				assert.instanceOf(error, PayloadRejected);
				const rejected = error as PayloadRejected;
				assert.strictEqual(rejected.node, "c");
				assert.strictEqual(rejected.program, "consumer");
				assert.strictEqual(rejected.port, "ticks");
				assert.strictEqual(rejected.kind, "tick/v1");
			}),
	);

	it.effect("refuses an emit from a port that was never wired, and an inbox for one", () =>
		Effect.gen(function* () {
			const [emit, inbox] = yield* wired([producer, consumer()], oneRoute, (wiring) =>
				Effect.all(
					[
						Effect.flip(wiring.emit({node: p.node, port: "beats"}, 1)),
						Effect.flip(wiring.inbox({node: c.node, port: "beats"})),
					],
					{concurrency: 1},
				),
			);
			assert.instanceOf(emit, PortNotWired);
			assert.instanceOf(inbox, PortNotWired);
		}),
	);

	const overCapacity = (bound: PortBound) =>
		wired([producer, consumer("consumer", bound)], oneRoute, (wiring) =>
			Effect.gen(function* () {
				const deliveries = [];
				for (const n of [1, 2, 3]) {
					deliveries.push(...(yield* wiring.emit(p, n)));
				}
				const inbox = yield* wiring.inbox(c);
				return {
					accepted: deliveries.map((x) => x.accepted),
					size: yield* Queue.size(inbox),
					held: yield* Queue.takeAll(inbox),
				};
			}),
		);

	it.effect("dropping: an over-capacity write is refused and the queue does not grow", () =>
		Effect.gen(function* () {
			const result = yield* overCapacity({capacity: 2, overflow: "dropping"});
			assert.deepStrictEqual(result, {accepted: [true, true, false], size: 2, held: [1, 2]});
		}),
	);

	it.effect("sliding: an over-capacity write evicts the oldest and the queue does not grow", () =>
		Effect.gen(function* () {
			const result = yield* overCapacity({capacity: 2, overflow: "sliding"});
			assert.deepStrictEqual(result, {accepted: [true, true, true], size: 2, held: [2, 3]});
		}),
	);

	it.effect("suspend: an over-capacity write waits for a take instead of growing the queue", () =>
		Effect.gen(function* () {
			const result = yield* wired(
				[producer, consumer("consumer", {capacity: 2, overflow: "suspend"})],
				oneRoute,
				(wiring) =>
					Effect.gen(function* () {
						yield* wiring.emit(p, 1);
						yield* wiring.emit(p, 2);
						const third = yield* Effect.forkChild(wiring.emit(p, 3));
						yield* Effect.yieldNow;
						const inbox = yield* wiring.inbox(c);
						const sizeWhileBlocked = yield* Queue.size(inbox);
						const first = yield* Queue.take(inbox);
						yield* Fiber.join(third);
						return {sizeWhileBlocked, first, rest: yield* Queue.takeAll(inbox)};
					}),
			);
			assert.deepStrictEqual(result, {sizeWhileBlocked: 2, first: 1, rest: [2, 3]});
		}),
	);

	it.effect("shuts every inbox down when the scope closes", () =>
		Effect.gen(function* () {
			const inbox = yield* wired([producer, consumer()], oneRoute, (wiring) => wiring.inbox(c));
			const offered = yield* Queue.offer(inbox as Queue.Queue<unknown>, 1);
			assert.strictEqual(offered, false);
		}),
	);
});
