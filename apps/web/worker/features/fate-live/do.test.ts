/**
 * `LiveDO` on the Effect DO model, driven over the KV-only `do-state` fake: the `live`
 * fake's `getByName` routes by name prefix, so a topic→connection `deliver` and a
 * connection→topic `register` hop between real instances without workerd.
 */
import {RuntimeContext} from "alchemy";
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
	BufferedFrame,
	DeliverFrame,
	LiveLimits,
	PublishMessage,
	SubscribeControl,
	SubscriberRow,
} from "./protocol.ts";
import {topicsForPublish, topicsForSubscribe} from "./protocol.ts";

// alchemy beta.59 colors the DO storage methods with `RuntimeContext` (ADR 0124). The
// KV-only fake never reads it, so `RuntimeContext.phantom` discharges the type
// requirement and keeps these in-process runs `Effect.runPromise`-able.
const run = <A>(effect: Effect.Effect<A, never, RuntimeContext>): Promise<A> =>
	Effect.runPromise(Effect.provide(effect, RuntimeContext.phantom));

/** Generous limits — none of these caps is the thing under test. */
const LIMITS: LiveLimits = {
	maxSubscriptionsPerConnection: 256,
	maxSubscriptionsPerTopic: 256,
	maxQueuedEventsPerConnection: 100,
	maxEncodedEventSize: 64 * 1024,
	deliveryAttemptTimeoutMs: 1500,
	maxBufferedFramesPerTopic: 32,
	bufferedFrameTtlMs: 10_000,
};

type LiveInstance = ReturnType<typeof makeLiveInstance>;

/**
 * An unknown name resolves to a stub whose every method dies, so a topic probing an
 * unregistered connection sees "couldn't reach", not "confirmed stale".
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
		expect(pub.delivered).toBeGreaterThan(0);

		const frame = await stream.next();
		expect(frame).toContain("event: next");
		const payload = payloadOf(frame);
		expect(payload.kind).toBe("next");
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

		// A connection that is NOT in the cell, so any probe of it dies → "couldn't reach".
		const row: SubscriberRow = {
			topicKey,
			connectionId: "gone",
			subId: "sub-gone",
			generation: 1,
			revision: 1,
			updatedAt: Date.now(),
		};
		const reg = await run(topic.register({row, limits: LIMITS, subscribedAt: Date.now()}));
		expect(reg.ok).toBe(true);
		expect(fake.hasAlarm()).toBe(true);

		// The first failed probe reaps ALL that connection's rows (no consecutive-miss counter).
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
		// The subscription registers under BOTH the args-scoped and the global wildcard topic;
		// the bug was `topicsForPublish` fanning one publish out to both keys.
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

		expect(delivered).toBe(1);

		const first = await stream.next();
		expect(first).toContain("event: connection");
		expect(payloadOf(first).id).toBe(subControl.subId);

		// A pre-fix duplicate would already be buffered, so race `next()` against an idle window.
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

		let sawStale = false;
		for (let i = 0; i < cap + 5; i++) {
			const pub = await run(topic.publish({topicKey, frame: entityFrame, limits}));
			if (pub.delivered === 0) {
				sawStale = true;
				break;
			}
		}
		expect(sawStale).toBe(true);

		const after = await run(topic.publish({topicKey, frame: entityFrame, limits}));
		expect(after.delivered).toBe(0);
	});

	it("publish honors deliveryAttemptTimeoutMs: a hung deliver settles within the budget", async () => {
		const cell = makeLiveCell();
		const topicKey = "Post:post-hung";
		const {instance: topic} = makeTopic(cell, topicKey);

		// A connection whose `deliver` never resolves — a wedged isolate.
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
		const reg = await run(topic.register({row, limits: LIMITS, subscribedAt: Date.now()}));
		expect(reg.ok).toBe(true);

		// The hung deliver must not wedge publish: the attempt times out and publish settles.
		const limits: LiveLimits = {...LIMITS, deliveryAttemptTimeoutMs: 50};
		const started = Date.now();
		const pub = await run(topic.publish({topicKey, frame: entityFrame, limits}));
		const elapsed = Date.now() - started;

		expect(pub.delivered).toBe(0);
		expect(elapsed).toBeLessThan(2000);
		expect(elapsed).toBeGreaterThanOrEqual(40);
	});

	// The #714 publish-vs-register race: .patterns/fate-live-consistency.md
	it("register after publish replays the buffered frame (the #714 catch-up)", async () => {
		const cell = makeLiveCell();
		const connection = makeConnection(cell, "conn-late");
		const topicKey = "Post:post-late";
		const {instance: topic} = makeTopic(cell, topicKey);

		const ownerId = "owner-late";
		const subId = "sub-late";
		const res = await run(
			connection.openStream({
				ownerId,
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);
		const stream = await reader(res);
		expect(await stream.next()).toContain("connected");

		const pub = await run(topic.publish({topicKey, frame: entityFrame, limits: LIMITS}));
		expect(pub.delivered).toBe(0);

		const sub = await run(
			connection.subscribe({subId, topics: [topicKey], ownerId, limits: LIMITS}),
		);
		expect(sub.ok).toBe(true);

		const frame = await stream.next();
		expect(frame).toContain("event: next");
		expect(payloadOf(frame).id).toBe(subId);

		await stream.cancel();
	});

	// Fan-out reaches only the already-registered, replay only the just-registering.
	it("no double-apply: fan-out and replay deliver each frame to a connection at most once", async () => {
		const cell = makeLiveCell();
		const topicKey = "Post:post-dedup";
		const {instance: topic} = makeTopic(cell, topicKey);

		const connEarly = makeConnection(cell, "conn-early");
		const connLate = makeConnection(cell, "conn-late-dedup");

		const resEarly = await run(
			connEarly.openStream({
				ownerId: "owner-early",
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);
		const resLate = await run(
			connLate.openStream({
				ownerId: "owner-late",
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);
		const streamEarly = await reader(resEarly);
		const streamLate = await reader(resLate);
		expect(await streamEarly.next()).toContain("connected");
		expect(await streamLate.next()).toContain("connected");

		await run(
			connEarly.subscribe({
				subId: "sub-early",
				topics: [topicKey],
				ownerId: "owner-early",
				limits: LIMITS,
			}),
		);
		const pub = await run(topic.publish({topicKey, frame: entityFrame, limits: LIMITS}));
		expect(pub.delivered).toBe(1);

		expect(payloadOf(await streamEarly.next()).id).toBe("sub-early");
		const earlyEcho = await Promise.race([
			streamEarly.next(),
			new Promise<"idle">((resolve) => setTimeout(() => resolve("idle"), 50)),
		]);
		expect(earlyEcho).toBe("idle");

		await run(
			connLate.subscribe({
				subId: "sub-late",
				topics: [topicKey],
				ownerId: "owner-late",
				limits: LIMITS,
			}),
		);
		expect(payloadOf(await streamLate.next()).id).toBe("sub-late");
		const lateEcho = await Promise.race([
			streamLate.next(),
			new Promise<"idle">((resolve) => setTimeout(() => resolve("idle"), 50)),
		]);
		expect(lateEcho).toBe("idle");

		await streamEarly.cancel();
		await streamLate.cancel();
	});

	// The topic stamps the SSE `id:` as the per-topic `seq` (#731), so the cursor is that seq.
	it("lastEventId bounds replay to frames newer than the last one the subscriber saw", async () => {
		const cell = makeLiveCell();
		const topicKey = "Post:post-lei";
		const {instance: topic} = makeTopic(cell, topicKey);

		const connection = makeConnection(cell, "conn-lei");
		const res = await run(
			connection.openStream({
				ownerId: "owner-lei",
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);
		const stream = await reader(res);
		expect(await stream.next()).toContain("connected");

		const frameOld: DeliverFrame = {kind: "next", id: "", event: {data: {n: 1}}};
		const frameNew: DeliverFrame = {kind: "next", id: "", event: {data: {n: 2}}};
		await run(topic.publish({topicKey, frame: frameOld, limits: LIMITS}));
		await run(topic.publish({topicKey, frame: frameNew, limits: LIMITS}));

		const sub = await run(
			connection.subscribe({
				subId: "sub-lei",
				topics: [topicKey],
				ownerId: "owner-lei",
				limits: LIMITS,
				lastEventId: "1",
			}),
		);
		expect(sub.ok).toBe(true);

		const frame = await stream.next();
		expect(frame).toContain("id: 2");
		expect(frame).not.toContain("id: 1\n");

		const echo = await Promise.race([
			stream.next(),
			new Promise<"idle">((resolve) => setTimeout(() => resolve("idle"), 50)),
		]);
		expect(echo).toBe("idle");

		await stream.cancel();
	});

	// The #731 replay-side clobber: the old string-equality scan looked for the exact
	// `eventId === lastEventId` in the window, so once the cursor frame aged out it matched
	// nothing and dropped every newer frame too. Replay must skip `seq <= cursor` numerically.
	it("replay delivers strictly-newer even when the cursor frame aged out (the #731 clobber, replay side)", async () => {
		const cell = makeLiveCell();
		const topicKey = "Post:post-clobber";
		const decoyKey = "Post:decoy-clobber";
		const {instance: topic} = makeTopic(cell, topicKey);
		makeTopic(cell, decoyKey);

		const connection = makeConnection(cell, "conn-clobber");
		const ownerId = "owner-clobber";
		const subId = "sub-clobber";
		const res = await run(
			connection.openStream({
				ownerId,
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);
		const stream = await reader(res);
		expect(await stream.next()).toContain("connected");

		// Activate `subId` via the decoy so the replayed deliver isn't stale (generation 1 / revision 1).
		await run(connection.subscribe({subId, topics: [decoyKey], ownerId, limits: LIMITS}));

		// A short TTL: seq 1 is published, then aged past its window; seq 2 lands fresh.
		const limits: LiveLimits = {...LIMITS, bufferedFrameTtlMs: 30};
		const frameOld: DeliverFrame = {kind: "next", id: "", event: {data: {score: 1}}};
		const frameNew: DeliverFrame = {kind: "next", id: "", event: {data: {score: 2}}};
		const beforePublish = Date.now();
		await run(topic.publish({topicKey, frame: frameOld, limits}));
		await new Promise((resolve) => setTimeout(resolve, 50)); // seq 1 ages past the 30ms TTL
		await run(topic.publish({topicKey, frame: frameNew, limits}));

		// Reconnect with cursor `"1"` (now aged out); register from before either publish.
		const row: SubscriberRow = {
			topicKey,
			connectionId: "conn-clobber",
			subId,
			generation: 1,
			revision: 1,
			updatedAt: Date.now(),
		};
		const reg = await run(
			topic.register({row, limits, subscribedAt: beforePublish, lastEventId: "1"}),
		);
		expect(reg.ok).toBe(true);

		const frame = await stream.next();
		expect(frame).toContain("id: 2");
		expect(payloadOf(frame).id).toBe(subId);

		const echo = await Promise.race([
			stream.next(),
			new Promise<"idle">((resolve) => setTimeout(() => resolve("idle"), 50)),
		]);
		expect(echo).toBe("idle");

		await stream.cancel();
	});

	// Replay's primary `subscribedAt` bound: .patterns/fate-live-views.md. These drive `register`
	// directly for a deterministic window edge, and isolate replay from fan-out by subscribing to a
	// DECOY topic while publishing to a SEPARATE topic with no registered row.
	it("a frame published at/after subscribedAt replays (the #714 catch-up window)", async () => {
		const cell = makeLiveCell();
		const topicKey = "Post:post-after";
		const decoyKey = "Post:decoy-after";
		const {instance: topic} = makeTopic(cell, topicKey);
		makeTopic(cell, decoyKey);

		const connection = makeConnection(cell, "conn-after");
		const ownerId = "owner-after";
		const subId = "sub-after";
		const res = await run(
			connection.openStream({
				ownerId,
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);
		const stream = await reader(res);
		expect(await stream.next()).toContain("connected");

		// Activate `subId` on the connection via the decoy (revision 1, generation 1).
		await run(connection.subscribe({subId, topics: [decoyKey], ownerId, limits: LIMITS}));

		// `subscribedAt` set BEFORE the frame's publish time → the frame is at/after intent.
		const beforePublish = Date.now();
		await run(topic.publish({topicKey, frame: entityFrame, limits: LIMITS}));
		const row: SubscriberRow = {
			topicKey,
			connectionId: "conn-after",
			subId,
			generation: 1,
			revision: 1,
			updatedAt: Date.now(),
		};
		const reg = await run(topic.register({row, limits: LIMITS, subscribedAt: beforePublish}));
		expect(reg.ok).toBe(true);

		const frame = await stream.next();
		expect(frame).toContain("event: next");
		expect(payloadOf(frame).id).toBe(subId);

		await stream.cancel();
	});

	it("a frame published before subscribedAt does NOT replay (no stale history)", async () => {
		const cell = makeLiveCell();
		const topicKey = "Post:post-before";
		const decoyKey = "Post:decoy-before";
		const {instance: topic} = makeTopic(cell, topicKey);
		makeTopic(cell, decoyKey);

		const connection = makeConnection(cell, "conn-before");
		const ownerId = "owner-before";
		const subId = "sub-before";
		const res = await run(
			connection.openStream({
				ownerId,
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);
		const stream = await reader(res);
		expect(await stream.next()).toContain("connected");

		await run(connection.subscribe({subId, topics: [decoyKey], ownerId, limits: LIMITS}));

		// `subscribedAt` set WELL AFTER the publish (epoch-absent fallback path) → must not replay.
		await run(topic.publish({topicKey, frame: entityFrame, limits: LIMITS}));
		const row: SubscriberRow = {
			topicKey,
			connectionId: "conn-before",
			subId,
			generation: 1,
			revision: 1,
			updatedAt: Date.now(),
		};
		const reg = await run(topic.register({row, limits: LIMITS, subscribedAt: Date.now() + 60_000}));
		expect(reg.ok).toBe(true);

		const echo = await Promise.race([
			stream.next(),
			new Promise<"idle">((resolve) => setTimeout(() => resolve("idle"), 50)),
		]);
		expect(echo).toBe("idle");

		await stream.cancel();
	});

	it("a register past the TTL window replays nothing (bounded buffer)", async () => {
		const cell = makeLiveCell();
		const topicKey = "Post:post-ttl";
		const {instance: topic} = makeTopic(cell, topicKey);

		const connection = makeConnection(cell, "conn-ttl");
		const res = await run(
			connection.openStream({
				ownerId: "owner-ttl",
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);
		const stream = await reader(res);
		expect(await stream.next()).toContain("connected");

		// A 1ms TTL + a real gap: a 0ms TTL would race the clock, since a same-millisecond
		// publish+register is `now - at === 0` and still inside the `<= ttl` window.
		const limits: LiveLimits = {...LIMITS, bufferedFrameTtlMs: 1};
		await run(topic.publish({topicKey, frame: entityFrame, limits}));
		await new Promise((resolve) => setTimeout(resolve, 20));
		const sub = await run(
			connection.subscribe({
				subId: "sub-ttl",
				topics: [topicKey],
				ownerId: "owner-ttl",
				limits,
			}),
		);
		expect(sub.ok).toBe(true);

		const echo = await Promise.race([
			stream.next(),
			new Promise<"idle">((resolve) => setTimeout(() => resolve("idle"), 50)),
		]);
		expect(echo).toBe("idle");

		await stream.cancel();
	});
});

// The epoch fence (#1072/#1903): a frame published BEFORE this connection's current epoch is
// already in a cursorless reconnect's initial query result, so replaying it would clobber the
// correct value. On a cursorless reconnect under a reused connectionId the epoch bumps, but the
// replayed pre-epoch frame carries the CURRENT generation, so `isStale` doesn't catch it → it
// would leak onto the new stream ahead of the live frame. `replayBuffer` floors at
// `epochStartedAt` (the authoritative causal floor, #1903), which a pre-epoch frame can never
// beat — while a #714 register-race frame (published after `openStream`) still clears it. The
// wall-clock grace that once sat below this floor was itself the #1903 leak and is gone.
describe("LiveDO replay epoch fence (#1072/#1903)", () => {
	// Direct `register` with explicit `subscribedAt` + `epochStartedAt` for a deterministic window
	// edge; decoy topic + separate publish topic isolate replay from fan-out, as above.
	it("a pre-epoch frame inside the clock grace does NOT replay (epoch fence)", async () => {
		const cell = makeLiveCell();
		const topicKey = "Post:post-epoch-fence";
		const decoyKey = "Post:decoy-epoch-fence";
		const {instance: topic} = makeTopic(cell, topicKey);
		makeTopic(cell, decoyKey);

		const connection = makeConnection(cell, "conn-epoch-fence");
		const ownerId = "owner-epoch-fence";
		const subId = "sub-epoch-fence";
		const res = await run(
			connection.openStream({
				ownerId,
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);
		const stream = await reader(res);
		expect(await stream.next()).toContain("connected");

		// Activate `subId` on the connection via the decoy (revision 1, generation 1).
		await run(connection.subscribe({subId, topics: [decoyKey], ownerId, limits: LIMITS}));

		// Buffer a frame on the REAL topic (no row → fan-out delivers nothing).
		const beforePublish = Date.now();
		await run(topic.publish({topicKey, frame: entityFrame, limits: LIMITS}));
		const afterPublish = Date.now();

		// The epoch begins strictly AFTER the frame was buffered, while `subscribedAt` sits inside
		// the old 1s grace — the pre-fix leak the epoch floor now excludes.
		const epochStartedAt = afterPublish + 1;
		const subscribedAt = afterPublish + 100;
		const row: SubscriberRow = {
			topicKey,
			connectionId: "conn-epoch-fence",
			subId,
			generation: 1,
			revision: 1,
			updatedAt: Date.now(),
		};
		expect(beforePublish).toBeLessThan(epochStartedAt); // buffered.at < epoch start ⇒ fenced
		const reg = await run(topic.register({row, limits: LIMITS, subscribedAt, epochStartedAt}));
		expect(reg.ok).toBe(true);

		const echo = await Promise.race([
			stream.next(),
			new Promise<"idle">((resolve) => setTimeout(() => resolve("idle"), 50)),
		]);
		expect(echo).toBe("idle");

		await stream.cancel();
	});

	it("a register-race frame at/after the epoch start still replays (#714 preserved)", async () => {
		const cell = makeLiveCell();
		const topicKey = "Post:post-epoch-race";
		const decoyKey = "Post:decoy-epoch-race";
		const {instance: topic} = makeTopic(cell, topicKey);
		makeTopic(cell, decoyKey);

		const connection = makeConnection(cell, "conn-epoch-race");
		const ownerId = "owner-epoch-race";
		const subId = "sub-epoch-race";
		const res = await run(
			connection.openStream({
				ownerId,
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);
		const stream = await reader(res);
		expect(await stream.next()).toContain("connected");

		await run(connection.subscribe({subId, topics: [decoyKey], ownerId, limits: LIMITS}));

		// The epoch begins BEFORE the publish (stream already open) — the #714 case the fence keeps.
		const epochStartedAt = Date.now();
		const subscribedAt = epochStartedAt;
		await run(topic.publish({topicKey, frame: entityFrame, limits: LIMITS}));
		const row: SubscriberRow = {
			topicKey,
			connectionId: "conn-epoch-race",
			subId,
			generation: 1,
			revision: 1,
			updatedAt: Date.now(),
		};
		const reg = await run(topic.register({row, limits: LIMITS, subscribedAt, epochStartedAt}));
		expect(reg.ok).toBe(true);

		const frame = await stream.next();
		expect(frame).toContain("event: next");
		expect(payloadOf(frame).id).toBe(subId);

		await stream.cancel();
	});

	// The same shape end to end through `openStream` → `subscribe`, not a direct `register`.
	it("a frame buffered before a cursorless reconnect's epoch does not leak onto the new stream", async () => {
		const cell = makeLiveCell();
		const topicKey = "Post:posts-reconnect";
		const {instance: topic} = makeTopic(cell, topicKey);
		const connection = makeConnection(cell, "conn-reconnect");
		const ownerId = "owner-reconnect";

		// First connect (epoch 1), no subscription yet — the frame lands only in the buffer.
		await run(
			connection.openStream({
				ownerId,
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);
		await run(topic.publish({topicKey, frame: entityFrame, limits: LIMITS}));

		// A real gap so the reconnect's epoch is strictly after the buffered frame's `at`.
		await new Promise((resolve) => setTimeout(resolve, 5));

		const res = await run(
			connection.openStream({
				ownerId,
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);
		const stream = await reader(res);
		expect(await stream.next()).toContain("connected");

		const sub = await run(
			connection.subscribe({subId: "sub-reconnect", topics: [topicKey], ownerId, limits: LIMITS}),
		);
		expect(sub.ok).toBe(true);

		const echo = await Promise.race([
			stream.next(),
			new Promise<"idle">((resolve) => setTimeout(() => resolve("idle"), 50)),
		]);
		expect(echo).toBe("idle");

		await stream.cancel();
	});

	// #1903 regression guard: the `epochStartedAt`/`openStream` CAUSAL boundary ALONE
	// separates the two frames the (now-removed) 1s wall-clock grace could not tell apart —
	// the #714 register-race KEEP frame vs the stale pre-vote #1903 DROP frame. Both sit
	// where the OLD grace floor (`subscribedAt - 1000`) would have admitted BOTH; this proves
	// the causal `epochStartedAt` floor is the sole discriminator, so dropping the grace does
	// not regress #714 and does close the #1903 clobber.
	//
	// Timeline modeled (the real #1903 page-reload flake): a stale pre-vote frame is
	// buffered (score:0), THEN the client reloads → `openStream` bumps the epoch
	// (`epochStartedAt = reload instant`, live-do.ts:264), THEN a #714 register-race frame
	// fires after the reconnected stream is open but before `register` commits (score:1),
	// THEN the cursorless (`lastEventId: undefined`) `register` lands. The pre-vote frame is
	// pre-epoch (`at < epochStartedAt`) ⇒ DROP; the race frame is post-epoch
	// (`at >= epochStartedAt`) ⇒ KEEP.
	it("epoch fence alone separates a #714 race-KEEP from a #1903 pre-vote-DROP the old grace could not", async () => {
		const cell = makeLiveCell();
		const topicKey = "Post:post-1903-discriminate";
		const decoyKey = "Post:decoy-1903-discriminate";
		const {instance: topic} = makeTopic(cell, topicKey);
		makeTopic(cell, decoyKey);

		const connection = makeConnection(cell, "conn-1903-discriminate");
		const ownerId = "owner-1903";
		const subId = "sub-1903";
		const res = await run(
			connection.openStream({
				ownerId,
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);
		const stream = await reader(res);
		expect(await stream.next()).toContain("connected");

		// Activate `subId` via the decoy so a replayed deliver to the real topic isn't stale.
		await run(connection.subscribe({subId, topics: [decoyKey], ownerId, limits: LIMITS}));

		// (b) STALE PRE-VOTE frame (score:0), buffered BEFORE the reload's epoch. The real gaps on
		// either side put the two frames' `at` on opposite sides of `epochStartedAt`.
		const preVoteFrame: DeliverFrame = {kind: "next", id: "", event: {data: {score: 0}}};
		const staleAt = Date.now();
		await run(topic.publish({topicKey, frame: preVoteFrame, limits: LIMITS}));

		// The reload's epoch: the causal boundary `openStream` stamps on the reconnect.
		await new Promise((resolve) => setTimeout(resolve, 5));
		const epochStartedAt = Date.now();
		await new Promise((resolve) => setTimeout(resolve, 5));

		// (a) #714 REGISTER-RACE frame (score:1): post-epoch ⇒ must be KEPT.
		const raceFrame: DeliverFrame = {kind: "next", id: "", event: {data: {score: 1}}};
		const raceAt = Date.now();
		await run(topic.publish({topicKey, frame: raceFrame, limits: LIMITS}));
		const afterRace = Date.now();

		// `subscribedAt` sits so BOTH frames were inside the OLD 1s grace, leaving the epoch floor
		// as the only discriminator.
		const subscribedAt = afterRace;
		expect(subscribedAt - 1000).toBeLessThan(staleAt); // the removed grace would KEEP the stale frame
		expect(staleAt).toBeLessThan(epochStartedAt); // pre-vote frame is pre-epoch ⇒ DROP
		expect(raceAt).toBeGreaterThanOrEqual(epochStartedAt); // race frame is post-epoch ⇒ KEEP

		const row: SubscriberRow = {
			topicKey,
			connectionId: "conn-1903-discriminate",
			subId,
			generation: 1,
			revision: 1,
			updatedAt: Date.now(),
		};
		const reg = await run(topic.register({row, limits: LIMITS, subscribedAt, epochStartedAt}));
		expect(reg.ok).toBe(true);

		const kept = await stream.next();
		expect(kept).toContain("event: next");
		expect(payloadOf(kept).id).toBe(subId);
		expect((payloadOf(kept).event.data as {score: number}).score).toBe(1);

		// No second frame: the stale pre-vote was fenced by the epoch floor.
		const echo = await Promise.race([
			stream.next(),
			new Promise<"idle">((resolve) => setTimeout(() => resolve("idle"), 50)),
		]);
		expect(echo).toBe("idle");

		await stream.cancel();
	});
});

// Buffer bounds: .patterns/fate-live-views.md. Non-obvious shape exercised here: prune is
// "prune-then-append" — `appendToBuffer` prunes the EXISTING buffer to the cap and then writes
// the new frame, so storage settles at cap+1, while the read path (`pruneBuffer` inside
// `replayBuffer`) prunes again and hands replay only the newest `cap` survivors.
describe("LiveDO replay buffer count-cap overflow prune", () => {
	const bufferedSeqs = (
		fake: ReturnType<typeof makeDurableObjectStateForTest>,
		topicKey: string,
	): Promise<ReadonlyArray<number>> =>
		run(
			Effect.map(fake.state.storage.list<BufferedFrame>({prefix: `frame:${topicKey}:`}), (map) =>
				[...map.values()].map((entry) => entry.seq).sort((a, b) => a - b),
			),
		);

	it("publishing far past the cap holds at cap+1 retained frames, oldest seqs dropped", async () => {
		const cell = makeLiveCell();
		const topicKey = "Post:post-cap-overflow";
		const {instance: topic, fake} = makeTopic(cell, topicKey);

		const cap = 3;
		const limits: LiveLimits = {...LIMITS, maxBufferedFramesPerTopic: cap};

		const total = 10;
		for (let i = 0; i < total; i++) {
			await run(topic.publish({topicKey, frame: entityFrame, limits}));
		}

		const retained = await bufferedSeqs(fake, topicKey);
		expect(retained.length).toBe(cap + 1);
		expect(retained).toEqual([total - cap, total - cap + 1, total - cap + 2, total]);
		expect(retained[0]).toBe(total - cap);
		expect(retained[retained.length - 1]).toBe(total);
	});

	it("the cap bounds the replay WINDOW to the newest `cap` frames (overflow not replayed)", async () => {
		const cell = makeLiveCell();
		const topicKey = "Post:post-cap-window";
		const decoyKey = "Post:decoy-cap-window";
		const {instance: topic} = makeTopic(cell, topicKey);
		makeTopic(cell, decoyKey);

		const connection = makeConnection(cell, "conn-cap-window");
		const ownerId = "owner-cap-window";
		const subId = "sub-cap-window";
		const res = await run(
			connection.openStream({
				ownerId,
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);
		const stream = await reader(res);
		expect(await stream.next()).toContain("connected");

		// Activate the subId via a decoy topic so the replayed deliver to the REAL topic isn't stale.
		await run(connection.subscribe({subId, topics: [decoyKey], ownerId, limits: LIMITS}));

		// No registered row on the real topic → replay is the only delivery path; a `subscribedAt`
		// from before any publish isolates the COUNT cap from the `subscribedAt` bound.
		const cap = 3;
		const limits: LiveLimits = {...LIMITS, maxBufferedFramesPerTopic: cap};
		const beforePublish = Date.now();
		const total = 6;
		for (let i = 0; i < total; i++) {
			await run(topic.publish({topicKey, frame: entityFrame, limits}));
		}

		const row: SubscriberRow = {
			topicKey,
			connectionId: "conn-cap-window",
			subId,
			generation: 1,
			revision: 1,
			updatedAt: Date.now(),
		};
		const reg = await run(topic.register({row, limits, subscribedAt: beforePublish}));
		expect(reg.ok).toBe(true);

		// SSE `id:` carries the per-topic seq, so assert the exact retained range.
		const seqs: Array<number> = [];
		for (let i = 0; i < cap; i++) {
			const frame = await stream.next();
			expect(payloadOf(frame).id).toBe(subId);
			const idLine = frame.split("\n").find((l) => l.startsWith("id: "))!;
			seqs.push(Number(idLine.slice("id: ".length)));
		}
		expect(seqs).toEqual([total - cap + 1, total - cap + 2, total]);

		const echo = await Promise.race([
			stream.next(),
			new Promise<"idle">((resolve) => setTimeout(() => resolve("idle"), 50)),
		]);
		expect(echo).toBe("idle");

		await stream.cancel();
	});

	it("a cursor at a cap-pruned seq replays the surviving strictly-newer frames, never a pruned one", async () => {
		const cell = makeLiveCell();
		const topicKey = "Post:post-cap-cursor";
		const decoyKey = "Post:decoy-cap-cursor";
		const {instance: topic} = makeTopic(cell, topicKey);
		makeTopic(cell, decoyKey);

		const connection = makeConnection(cell, "conn-cap-cursor");
		const ownerId = "owner-cap-cursor";
		const subId = "sub-cap-cursor";
		const res = await run(
			connection.openStream({
				ownerId,
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);
		const stream = await reader(res);
		expect(await stream.next()).toContain("connected");

		await run(connection.subscribe({subId, topics: [decoyKey], ownerId, limits: LIMITS}));

		// Cursor "2" is a seq EVICTED by the count cap (< the oldest survivor 4): the #731 numeric
		// semantics must replay the whole surviving window, never a pruned frame, never crash.
		const cap = 3;
		const limits: LiveLimits = {...LIMITS, maxBufferedFramesPerTopic: cap};
		const beforePublish = Date.now();
		const total = 6;
		for (let i = 0; i < total; i++) {
			await run(topic.publish({topicKey, frame: entityFrame, limits}));
		}

		const row: SubscriberRow = {
			topicKey,
			connectionId: "conn-cap-cursor",
			subId,
			generation: 1,
			revision: 1,
			updatedAt: Date.now(),
		};
		const reg = await run(
			topic.register({row, limits, subscribedAt: beforePublish, lastEventId: "2"}),
		);
		expect(reg.ok).toBe(true);

		const seqs: Array<number> = [];
		for (let i = 0; i < cap; i++) {
			const frame = await stream.next();
			expect(payloadOf(frame).id).toBe(subId);
			const idLine = frame.split("\n").find((l) => l.startsWith("id: "))!;
			seqs.push(Number(idLine.slice("id: ".length)));
		}
		expect(seqs).toEqual([total - cap + 1, total - cap + 2, total]);

		const echo = await Promise.race([
			stream.next(),
			new Promise<"idle">((resolve) => setTimeout(() => resolve("idle"), 50)),
		]);
		expect(echo).toBe("idle");

		await stream.cancel();
	});
});

describe("LiveDO role-guard: a misrouted RPC no-ops without mutating storage (#1368)", () => {
	// Mirror live-do.ts's KV-key contract so the test can assert storage was (not) touched.
	const GENERATION_KEY = "connection:generation";
	const subscriberKey = (row: SubscriberRow): string =>
		`sub:${row.topicKey}:${row.connectionId}:${row.subId}:${row.generation}:${row.revision}`;

	function makeConnectionWithState(cell: LiveCell, connectionId: string) {
		const name = makeConnectionName(connectionId);
		const fake = makeDurableObjectStateForTest({id: name});
		const instance = makeLiveInstance(fake.state, cell.live as never);
		cell.register(name, instance);
		return {instance, fake};
	}

	const guardRow = (topicKey: string, connectionId: string): SubscriberRow => ({
		topicKey,
		connectionId,
		subId: "sub-guard",
		generation: 1,
		revision: 1,
		updatedAt: Date.now(),
	});

	it("openStream on a topic instance no-ops: no SSE stream, generation never persisted", async () => {
		const cell = makeLiveCell();
		const {instance: topic, fake} = makeTopic(cell, "Post:guard-open");

		const res = await run(
			topic.openStream({
				ownerId: "owner",
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);

		const web = HttpServerResponse.toWeb(res);
		expect(web.status).toBe(404);
		expect(web.headers.get("content-type") ?? "").not.toContain("text/event-stream");

		expect(await run(fake.state.storage.get<number>(GENERATION_KEY))).toBeUndefined();
	});

	it("openStream on the matching connection instance still streams + persists generation (correct-role unchanged)", async () => {
		const cell = makeLiveCell();
		const {instance: connection, fake} = makeConnectionWithState(cell, "conn-open");

		const res = await run(
			connection.openStream({
				ownerId: "owner",
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);
		const stream = await reader(res);
		expect(await stream.next()).toContain("connected");
		expect(await run(fake.state.storage.get<number>(GENERATION_KEY))).toBe(1);

		await stream.cancel();
	});

	it("unregister on a connection instance no-ops: a seeded subscriber key survives", async () => {
		const cell = makeLiveCell();
		const {instance: connection, fake} = makeConnectionWithState(cell, "conn-unreg");
		const row = guardRow("Post:guard-unreg", "conn-unreg");
		const key = subscriberKey(row);
		// Seed the connection's OWN KV with the row's key — an unguarded unregister would delete it.
		await run(fake.state.storage.put(key, row));

		const res = await run(connection.unregister({row}));
		expect(res.ok).toBe(true);

		expect(await run(fake.state.storage.get<SubscriberRow>(key))).toEqual(row);
	});

	it("unregister on the matching topic instance still deletes the row (correct-role unchanged)", async () => {
		const cell = makeLiveCell();
		const topicKey = "Post:guard-unreg-ok";
		const {instance: topic, fake} = makeTopic(cell, topicKey);
		const row = guardRow(topicKey, "conn-x");
		await run(topic.register({row, limits: LIMITS, subscribedAt: Date.now()}));
		const key = subscriberKey(row);
		expect(await run(fake.state.storage.get<SubscriberRow>(key))).toEqual(row);

		const res = await run(topic.unregister({row}));
		expect(res.ok).toBe(true);
		expect(await run(fake.state.storage.get<SubscriberRow>(key))).toBeUndefined();
	});
});

// Branches the fan-out tests never reach: the partial reap, the re-arm, and `check` itself.
describe("LiveDO alarm reap branches (#1369)", () => {
	const subRowCount = (
		fake: ReturnType<typeof makeDurableObjectStateForTest>,
		topicKey: string,
	): Promise<number> =>
		run(
			fake.state.storage
				.list<SubscriberRow>({prefix: `sub:${topicKey}:`})
				.pipe(Effect.map((map) => map.size)),
		);

	it("partial reap: the alarm reaps EXACTLY the stale rows a reachable connection reports, not all", async () => {
		const cell = makeLiveCell();
		const topicKey = "Term:partial-reap";
		const {instance: topic, fake} = makeTopic(cell, topicKey);

		// A reachable connection with ONE live subscription; `check` reports staleness per-row.
		const connection = makeConnection(cell, "conn-partial");
		const ownerId = "owner-partial";
		await run(
			connection.openStream({
				ownerId,
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);
		await run(
			connection.subscribe({subId: "sub-keep", topics: [topicKey], ownerId, limits: LIMITS}),
		);

		// A second row for the SAME connection with no live subscription and the same generation:
		// the verdict is the subscription miss, so a partial reap — not the reach-failure reap-all.
		const staleRow: SubscriberRow = {
			topicKey,
			connectionId: "conn-partial",
			subId: "sub-stale",
			generation: 1,
			revision: 1,
			updatedAt: Date.now(),
		};
		await run(topic.register({row: staleRow, limits: LIMITS, subscribedAt: Date.now()}));
		expect(await subRowCount(fake, topicKey)).toBe(2);

		await run(topic.alarm());

		expect(await subRowCount(fake, topicKey)).toBe(1);
		const pub = await run(topic.publish({topicKey, frame: entityFrame, limits: LIMITS}));
		expect(pub.delivered).toBe(1);
	});

	it("reschedule: rows remaining after a reap re-arm the alarm", async () => {
		const cell = makeLiveCell();
		const topicKey = "Term:reschedule";
		const {instance: topic, fake} = makeTopic(cell, topicKey);

		const connection = makeConnection(cell, "conn-resched");
		const ownerId = "owner-resched";
		await run(
			connection.openStream({
				ownerId,
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);
		await run(
			connection.subscribe({subId: "sub-live", topics: [topicKey], ownerId, limits: LIMITS}),
		);

		// One reapable (no live subscription) + one live row, so the reap leaves rows behind.
		const orphanRow: SubscriberRow = {
			topicKey,
			connectionId: "conn-resched",
			subId: "sub-orphan",
			generation: 1,
			revision: 1,
			updatedAt: Date.now(),
		};
		await run(topic.register({row: orphanRow, limits: LIMITS, subscribedAt: Date.now()}));

		// The platform clears the alarm before firing the handler; the fake does not, so
		// stamp a sentinel and assert the handler RE-arms it past the sentinel.
		await run(fake.state.storage.setAlarm(1));
		await run(topic.alarm());

		expect(await subRowCount(fake, topicKey)).toBe(1);
		const rearmed = await run(fake.state.storage.getAlarm());
		expect(rearmed).not.toBeNull();
		expect(rearmed as number).toBeGreaterThan(1);
	});

	it("no reschedule: a reap that empties the topic leaves the alarm un-armed", async () => {
		const cell = makeLiveCell();
		const topicKey = "Term:empty-reap";
		const {instance: topic, fake} = makeTopic(cell, topicKey);

		// A row for a connection NOT in the cell → its probe dies → reap-all, zero left.
		const row: SubscriberRow = {
			topicKey,
			connectionId: "gone",
			subId: "sub-gone",
			generation: 1,
			revision: 1,
			updatedAt: Date.now(),
		};
		await run(topic.register({row, limits: LIMITS, subscribedAt: Date.now()}));

		await run(fake.state.storage.setAlarm(1));
		await run(topic.alarm());

		expect(await subRowCount(fake, topicKey)).toBe(0);
		expect(await run(fake.state.storage.getAlarm())).toBe(1);
	});

	it("check: classifies stale-by-generation and stale-by-revision against a live connection", async () => {
		const cell = makeLiveCell();
		const topicKey = "Term:check-direct";
		makeTopic(cell, topicKey); // subscribe registers into the topic; it must be reachable.
		const connection = makeConnection(cell, "conn-check");
		const ownerId = "owner-check";
		await run(
			connection.openStream({
				ownerId,
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);
		await run(
			connection.subscribe({subId: "sub-fresh", topics: [topicKey], ownerId, limits: LIMITS}),
		);

		const base = {topicKey, connectionId: "conn-check", subId: "sub-fresh", updatedAt: Date.now()};
		// 0: fresh — matches the live subscription's generation (1) + revision (1).
		const fresh: SubscriberRow = {...base, generation: 1, revision: 1};
		// 1: stale by generation — the connection's current generation is 1.
		const oldGen: SubscriberRow = {...base, generation: 0, revision: 1};
		// 2: stale by revision — live revision is 1, this row claims a newer one.
		const oldRev: SubscriberRow = {...base, generation: 1, revision: 2};

		const {stale} = await run(connection.check({subscriptions: [fresh, oldGen, oldRev]}));
		expect(stale).toEqual([1, 2]);
	});

	it("check: a connection with no open stream reports every probed row stale", async () => {
		const cell = makeLiveCell();
		// Never `openStream`'d → `framesQueue` undefined → the no-open-stream all-stale branch.
		const connection = makeConnection(cell, "conn-closed");
		const topicKey = "Term:check-closed";
		const base = {
			topicKey,
			connectionId: "conn-closed",
			generation: 1,
			revision: 1,
			updatedAt: Date.now(),
		};
		const rows: ReadonlyArray<SubscriberRow> = [
			{...base, subId: "a"},
			{...base, subId: "b"},
		];
		const {stale} = await run(connection.check({subscriptions: rows}));
		expect(stale).toEqual([0, 1]);
	});
});

// The owner-isolation fence on OPEN (#2563): the invariant `subscribe` already
// enforces (:owner check) was absent on `openStream`, so any session re-opening a
// live `connectionId` reset the prior holder (generation bump + subscription clear +
// stream teardown) — a cross-session griefing primitive. The fence refuses a foreign
// re-open at the DO seam WITHOUT disturbing the holder; a first open (no bound owner)
// and a same-owner reconnect pass through unchanged.
describe("LiveDO open-owner fence (#2563)", () => {
	const GENERATION_KEY = "connection:generation";
	const OWNER_KEY = "connection:owner";

	function makeConnectionWithState(cell: LiveCell, connectionId: string) {
		const name = makeConnectionName(connectionId);
		const fake = makeDurableObjectStateForTest({id: name});
		const instance = makeLiveInstance(fake.state, cell.live as never);
		cell.register(name, instance);
		return {instance, fake};
	}

	it("a foreign re-open is refused (403) and leaves the holder's stream, generation and owner intact", async () => {
		const cell = makeLiveCell();
		const {instance: connection, fake} = makeConnectionWithState(cell, "conn-fence");
		const topicKey = "Post:post-fence";
		const {instance: topic} = makeTopic(cell, topicKey);

		const ownerA = "owner-a";
		const subId = "sub-a";
		const res = await run(
			connection.openStream({
				ownerId: ownerA,
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);
		const stream = await reader(res);
		expect(await stream.next()).toContain("connected");
		await run(connection.subscribe({subId, topics: [topicKey], ownerId: ownerA, limits: LIMITS}));
		expect(await run(fake.state.storage.get<number>(GENERATION_KEY))).toBe(1);
		expect(await run(fake.state.storage.get<string>(OWNER_KEY))).toBe(ownerA);

		const hostile = await run(
			connection.openStream({
				ownerId: "attacker",
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);
		const web = HttpServerResponse.toWeb(hostile);
		expect(web.status).toBe(403);
		expect(web.headers.get("content-type") ?? "").not.toContain("text/event-stream");

		// Nothing disturbed: generation, owner, and A's live subscription all survive.
		expect(await run(fake.state.storage.get<number>(GENERATION_KEY))).toBe(1);
		expect(await run(fake.state.storage.get<string>(OWNER_KEY))).toBe(ownerA);
		const pub = await run(topic.publish({topicKey, frame: entityFrame, limits: LIMITS}));
		expect(pub.delivered).toBe(1);
		expect(payloadOf(await stream.next()).id).toBe(subId);

		await stream.cancel();
	});

	it("a first open of a fresh connectionId binds the owner", async () => {
		const cell = makeLiveCell();
		const {instance: connection, fake} = makeConnectionWithState(cell, "conn-fresh");
		expect(await run(fake.state.storage.get<string>(OWNER_KEY))).toBeUndefined();

		const res = await run(
			connection.openStream({
				ownerId: "owner-fresh",
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);
		const stream = await reader(res);
		expect(await stream.next()).toContain("connected");
		expect(await run(fake.state.storage.get<string>(OWNER_KEY))).toBe("owner-fresh");

		await stream.cancel();
	});

	it("a same-owner reconnect still streams and bumps the generation (reconnect path unbroken)", async () => {
		const cell = makeLiveCell();
		const {instance: connection, fake} = makeConnectionWithState(cell, "conn-reopen-same");
		const ownerA = "owner-same";

		await run(
			connection.openStream({
				ownerId: ownerA,
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);
		expect(await run(fake.state.storage.get<number>(GENERATION_KEY))).toBe(1);

		const res = await run(
			connection.openStream({
				ownerId: ownerA,
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);
		const stream = await reader(res);
		expect(await stream.next()).toContain("connected");
		expect(await run(fake.state.storage.get<number>(GENERATION_KEY))).toBe(2);

		await stream.cancel();
	});
});
