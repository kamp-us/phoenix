/**
 * `LiveDO` (the unified, KV-backed live fan-out DO) on the Effect DO model.
 *
 * Drives the real {@link makeLiveInstance} builder over the KV-only `do-state`
 * fake, wiring `connection:`- and `topic:`-named instances as in-process
 * siblings. The `live` fake's `getByName` routes by name prefix to the matching
 * instance's {@link LiveRpcSurface}, exactly as the worker's cross-role RPC does —
 * so a topic→connection `deliver` and a connection→topic `register` hop between
 * the real instances, proving the acceptance criteria without workerd.
 */
import {Effect} from "effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {describe, expect, it} from "vitest";
import {makeDurableObjectStateForTest} from "./do-state.testing.ts";
import {
	type LiveRpcSurface,
	makeConnectionName,
	makeLiveInstance,
	makeTopicName,
} from "./live-do.ts";
import type {
	DeliverFrame,
	LiveLimits,
	PublishMessage,
	SubscribeControl,
	SubscriberRow,
} from "./protocol.ts";
import {topicsForPublish, topicsForSubscribe} from "./protocol.ts";

const run = <A>(effect: Effect.Effect<A, never, never>): Promise<A> => Effect.runPromise(effect);

/** Generous limits — none of these caps is the thing under test. */
const LIMITS: LiveLimits = {
	maxSubscriptionsPerConnection: 256,
	maxSubscriptionsPerTopic: 256,
	maxQueuedEventsPerConnection: 100,
	maxEncodedEventSize: 64 * 1024,
	deliveryAttemptTimeoutMs: 1500,
};

type LiveInstance = ReturnType<typeof makeLiveInstance>;

/**
 * An in-process `live` namespace fake. An unknown name resolves to a stub whose
 * every method dies, so a topic probing an unregistered connection sees "couldn't
 * reach" (not "confirmed stale").
 */
interface LiveCell {
	readonly live: {readonly getByName: (name: string) => LiveRpcSurface};
	readonly register: (name: string, instance: LiveInstance) => void;
	readonly instances: Map<string, LiveInstance>;
}

function makeLiveCell(): LiveCell {
	const instances = new Map<string, LiveInstance>();
	const unreachable: LiveRpcSurface = {
		subscribe: () => Effect.die("unreachable instance"),
		unsubscribe: () => Effect.die("unreachable instance"),
		deliver: () => Effect.die("unreachable instance"),
		check: () => Effect.die("unreachable instance"),
		register: () => Effect.die("unreachable instance"),
		unregister: () => Effect.die("unreachable instance"),
		publish: () => Effect.die("unreachable instance"),
	};
	const getByName = (name: string): LiveRpcSurface => {
		const instance = instances.get(name);
		if (!instance) {
			return unreachable;
		}
		return {
			subscribe: instance.subscribe,
			unsubscribe: instance.unsubscribe,
			deliver: instance.deliver,
			check: instance.check,
			register: instance.register,
			unregister: instance.unregister,
			publish: instance.publish,
		};
	};
	return {
		live: {getByName: getByName as never},
		register: (name, instance) => instances.set(name, instance),
		instances,
	};
}

function makeConnection(cell: LiveCell, connectionId: string): LiveInstance {
	const name = makeConnectionName(connectionId);
	const fake = makeDurableObjectStateForTest({id: name});
	const instance = makeLiveInstance(fake.state, cell.live as never);
	cell.register(name, instance);
	return instance;
}

function makeTopic(
	cell: LiveCell,
	topicKey: string,
): {
	readonly instance: LiveInstance;
	readonly fake: ReturnType<typeof makeDurableObjectStateForTest>;
} {
	const name = makeTopicName(topicKey);
	const fake = makeDurableObjectStateForTest({id: name});
	const instance = makeLiveInstance(fake.state, cell.live as never);
	cell.register(name, instance);
	return {instance, fake};
}

/** A minimal entity `next` frame; `id` is `""` (the publish stamps the subId). */
const entityFrame: DeliverFrame = {kind: "next", id: "", event: {data: {score: 7}}};

async function reader(response: HttpServerResponse.HttpServerResponse) {
	const web = HttpServerResponse.toWeb(response);
	expect(web.headers.get("content-type")).toContain("text/event-stream");
	const r = web.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	return {
		next: async (): Promise<string> => {
			for (let i = 0; i < 50; i++) {
				const idx = buffer.indexOf("\n\n");
				if (idx !== -1) {
					const frame = buffer.slice(0, idx);
					buffer = buffer.slice(idx + 2);
					return frame;
				}
				const {value, done} = await r.read();
				if (done) {
					return buffer;
				}
				buffer += decoder.decode(value, {stream: true});
			}
			throw new Error("timed out waiting for SSE frame");
		},
		cancel: () => r.cancel(),
	};
}

function payloadOf(frame: string): {kind: string; id: string; event: {data: unknown}} {
	const dataLine = frame.split("\n").find((l) => l.startsWith("data: "))!;
	return JSON.parse(dataLine.slice("data: ".length));
}

describe("LiveDO live fan-out (KV model)", () => {
	it("subscribe → publish → frame arrives stamped with the subscriber's subId", async () => {
		const cell = makeLiveCell();
		const connection = makeConnection(cell, "conn-1");
		const topicKey = "Post:post-42";
		const {instance: topic} = makeTopic(cell, topicKey);

		const ownerId = "owner-1";
		const subId = "sub-1";
		const res = await run(
			connection.openStream({
				ownerId,
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);
		const stream = await reader(res);
		expect(await stream.next()).toContain("connected");

		const sub = await run(
			connection.subscribe({subId, topics: [topicKey], ownerId, limits: LIMITS}),
		);
		expect(sub.ok).toBe(true);

		const pub = await run(topic.publish({topicKey, frame: entityFrame, limits: LIMITS}));
		// `delivered > 0` proves the topic→connection cross-role path fired (a
		// wrong namespace-routing fake would silently pass with delivered 0).
		expect(pub.delivered).toBeGreaterThan(0);

		const frame = await stream.next();
		expect(frame).toContain("event: next");
		const payload = payloadOf(frame);
		expect(payload.kind).toBe("next");
		// Per-subscriber id: stamped at delivery from the row's subId, not publish.
		expect(payload.id).toBe(subId);

		await stream.cancel();
	});

	it("a reconnect bumps the generation; the prior row is stale on publish", async () => {
		const cell = makeLiveCell();
		const connection = makeConnection(cell, "conn-stale");
		const topicKey = "Comment:c-1";
		const {instance: topic} = makeTopic(cell, topicKey);

		const ownerId = "owner-stale";
		const subId = "sub-stale";
		await run(
			connection.openStream({
				ownerId,
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);
		await run(connection.subscribe({subId, topics: [topicKey], ownerId, limits: LIMITS}));

		// Reconnect: generation bumps; the topic still holds the old-generation row.
		await run(
			connection.openStream({
				ownerId,
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);

		const pub = await run(topic.publish({topicKey, frame: entityFrame, limits: LIMITS}));
		expect(pub.delivered).toBe(0);
	});

	it("the alarm reaps a subscriber row on the first failed probe", async () => {
		const cell = makeLiveCell();
		const topicKey = "Term:t-1";
		const {instance: topic, fake} = makeTopic(cell, topicKey);

		// Register a row directly for a connection that is NOT in the cell, so any
		// probe of `connection:gone` dies → "couldn't reach".
		const row: SubscriberRow = {
			topicKey,
			connectionId: "gone",
			subId: "sub-gone",
			generation: 1,
			revision: 1,
			updatedAt: Date.now(),
		};
		const reg = await run(topic.register({row, limits: LIMITS}));
		expect(reg.ok).toBe(true);
		expect(fake.hasAlarm()).toBe(true);

		// First failed probe reaps ALL that connection's rows (void-faithful — no
		// consecutive-miss counter).
		await run(topic.alarm());

		const pub = await run(topic.publish({topicKey, frame: entityFrame, limits: LIMITS}));
		expect(pub.delivered).toBe(0);
	});

	it("per-subscriber frame.id: 2 subs / 1 topic each get their OWN subId", async () => {
		const cell = makeLiveCell();
		const topicKey = "Post:post-77";
		const {instance: topic} = makeTopic(cell, topicKey);

		const connA = makeConnection(cell, "conn-a");
		const connB = makeConnection(cell, "conn-b");

		const resA = await run(
			connA.openStream({
				ownerId: "owner-a",
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);
		const resB = await run(
			connB.openStream({
				ownerId: "owner-b",
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);
		const streamA = await reader(resA);
		const streamB = await reader(resB);
		expect(await streamA.next()).toContain("connected");
		expect(await streamB.next()).toContain("connected");

		const subIdA = "sub-a";
		const subIdB = "sub-b";
		await run(
			connA.subscribe({subId: subIdA, topics: [topicKey], ownerId: "owner-a", limits: LIMITS}),
		);
		await run(
			connB.subscribe({subId: subIdB, topics: [topicKey], ownerId: "owner-b", limits: LIMITS}),
		);

		const pub = await run(topic.publish({topicKey, frame: entityFrame, limits: LIMITS}));
		expect(pub.delivered).toBe(2);

		expect(payloadOf(await streamA.next()).id).toBe(subIdA);
		expect(payloadOf(await streamB.next()).id).toBe(subIdB);

		await streamA.cancel();
		await streamB.cancel();
	});

	it("connection sub under specific+global topics gets ONE frame per publish (no double-delivery)", async () => {
		// A connection subscription registers under BOTH the args-scoped and global
		// wildcard topic. The bug: `topicsForPublish` fanned a single publish out to
		// both keys, so the connection (in both topic DOs) was `deliver`ed twice.
		// Drive the FULL path (subscribe → register, publish) to assert real wiring.
		const cell = makeLiveCell();
		const connection = makeConnection(cell, "conn-dd");

		const procedure = "posts";
		const args = {categoryId: "fruit"};

		const subControl: SubscribeControl = {
			kind: "subscribeConnection",
			subId: "sub-dd",
			procedure,
			args,
		};
		const subscribeTopics = topicsForSubscribe(subControl);
		expect(subscribeTopics.length).toBe(2);
		const topics = new Map(
			subscribeTopics.map((key) => [key, makeTopic(cell, key).instance] as const),
		);

		const ownerId = "owner-dd";
		const res = await run(
			connection.openStream({
				ownerId,
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);
		const stream = await reader(res);
		expect(await stream.next()).toContain("connected");

		const sub = await run(
			connection.subscribe({
				subId: subControl.subId,
				topics: [...subscribeTopics],
				ownerId,
				limits: LIMITS,
			}),
		);
		expect(sub.ok).toBe(true);

		const message: PublishMessage = {
			kind: "connection",
			match: {procedure, args},
			frame: {
				type: "prependNode",
				nodeType: "Post",
				edge: {node: {id: "post-new"}},
			},
		};
		const publishTopics = topicsForPublish(message);
		// The fix: a connection publish with args resolves to EXACTLY ONE key, not both.
		expect(publishTopics.length).toBe(1);

		let delivered = 0;
		for (const key of publishTopics) {
			const topic = topics.get(key);
			expect(topic, `publish topic ${key} has no DO`).toBeDefined();
			const pub = await run(
				topic!.publish({
					topicKey: key,
					frame: {kind: "connection", id: "", event: message.frame},
					limits: LIMITS,
				}),
			);
			delivered += pub.delivered;
		}

		// The connection was reached exactly once across the whole publish.
		expect(delivered).toBe(1);

		const first = await stream.next();
		expect(first).toContain("event: connection");
		expect(payloadOf(first).id).toBe(subControl.subId);

		// No second frame: race `next()` against a short idle window. A pre-fix
		// duplicate would already be buffered and returned immediately.
		const second = await Promise.race([
			stream.next(),
			new Promise<"idle">((resolve) => setTimeout(() => resolve("idle"), 50)),
		]);
		expect(second).toBe("idle");

		await stream.cancel();
	});

	it("a stalled connection past the queue cap is closed and the row goes stale", async () => {
		const cell = makeLiveCell();
		const connection = makeConnection(cell, "conn-backpressure");
		const topicKey = "Post:post-stall";
		const {instance: topic} = makeTopic(cell, topicKey);

		const ownerId = "owner-backpressure";
		const subId = "sub-backpressure";

		// Tiny cap; the SSE stream is NEVER read (no `reader(res)`), so nothing drains.
		const cap = 2;
		const limits: LiveLimits = {...LIMITS, maxQueuedEventsPerConnection: cap};
		await run(connection.openStream({ownerId, maxQueuedEventsPerConnection: cap}));
		const sub = await run(connection.subscribe({subId, topics: [topicKey], ownerId, limits}));
		expect(sub.ok).toBe(true);

		// Publish past the cap: the queue fills, the next deliver is refused, the
		// connection closes, and the row goes stale (void's 410 on queue full).
		let sawStale = false;
		for (let i = 0; i < cap + 5; i++) {
			const pub = await run(topic.publish({topicKey, frame: entityFrame, limits}));
			if (pub.delivered === 0) {
				sawStale = true;
				break;
			}
		}
		expect(sawStale).toBe(true);

		// Stream closed: a subsequent deliver finds no queue → stale.
		const after = await run(topic.publish({topicKey, frame: entityFrame, limits}));
		expect(after.delivered).toBe(0);
	});

	it("publish honors deliveryAttemptTimeoutMs: a hung deliver settles within the budget", async () => {
		const cell = makeLiveCell();
		const topicKey = "Post:post-hung";
		const {instance: topic} = makeTopic(cell, topicKey);

		// A connection whose `deliver` never resolves — a wedged isolate. Full
		// `LiveInstance` (the rest die if touched) so no cast is needed.
		const hung: LiveInstance = {
			openStream: () => Effect.die("unused"),
			subscribe: () => Effect.die("unused"),
			unsubscribe: () => Effect.die("unused"),
			deliver: () => Effect.never,
			check: () => Effect.die("unused"),
			register: () => Effect.die("unused"),
			unregister: () => Effect.die("unused"),
			publish: () => Effect.die("unused"),
			alarm: () => Effect.die("unused"),
		};
		cell.register(makeConnectionName("hung"), hung);

		const row: SubscriberRow = {
			topicKey,
			connectionId: "hung",
			subId: "sub-hung",
			generation: 1,
			revision: 1,
			updatedAt: Date.now(),
		};
		const reg = await run(topic.register({row, limits: LIMITS}));
		expect(reg.ok).toBe(true);

		// A tight budget: the hung deliver must NOT wedge publish — the
		// `Effect.timeout(deliveryAttemptTimeoutMs)` fires, the attempt is "couldn't
		// reach" (delivered 0), and publish settles within the budget.
		const limits: LiveLimits = {...LIMITS, deliveryAttemptTimeoutMs: 50};
		const started = Date.now();
		const pub = await run(topic.publish({topicKey, frame: entityFrame, limits}));
		const elapsed = Date.now() - started;

		expect(pub.delivered).toBe(0);
		// Settled near the budget, not hung forever (generous ceiling for CI jitter).
		expect(elapsed).toBeLessThan(2000);
		expect(elapsed).toBeGreaterThanOrEqual(40);
	});
});
