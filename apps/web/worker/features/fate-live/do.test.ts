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
	BufferedFrame,
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
	maxBufferedFramesPerTopic: 32,
	bufferedFrameTtlMs: 10_000,
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
		const reg = await run(topic.register({row, limits: LIMITS, subscribedAt: Date.now()}));
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
		const reg = await run(topic.register({row, limits: LIMITS, subscribedAt: Date.now()}));
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

	// The #714 race: a publish fires before the subscriber's `register` commits, so
	// fan-out delivers to an empty registry. The storage-backed catch-up buffer must
	// replay the missed frame to the connection when its register finally lands.
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

		// Publish BEFORE the subscriber registers — fan-out finds an empty registry.
		const pub = await run(topic.publish({topicKey, frame: entityFrame, limits: LIMITS}));
		expect(pub.delivered).toBe(0);

		// Now the subscribe→register lands (the slow RPC of #714). Replay must deliver
		// the buffered frame to this just-registered connection.
		const sub = await run(
			connection.subscribe({subId, topics: [topicKey], ownerId, limits: LIMITS}),
		);
		expect(sub.ok).toBe(true);

		const frame = await stream.next();
		expect(frame).toContain("event: next");
		expect(payloadOf(frame).id).toBe(subId);

		await stream.cancel();
	});

	// The dedup boundary: an already-registered connection receives a publish via
	// fan-out; a SECOND connection registering afterward gets the same frame via
	// replay. Neither connection ever sees the frame twice — fan-out reaches only the
	// already-registered, replay only the just-registering.
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

		// Only the early connection is registered when the publish fires.
		await run(
			connEarly.subscribe({
				subId: "sub-early",
				topics: [topicKey],
				ownerId: "owner-early",
				limits: LIMITS,
			}),
		);
		const pub = await run(topic.publish({topicKey, frame: entityFrame, limits: LIMITS}));
		expect(pub.delivered).toBe(1); // fan-out reached ONLY the early connection

		// The early connection got it via fan-out — exactly one frame, no replay echo.
		expect(payloadOf(await streamEarly.next()).id).toBe("sub-early");
		const earlyEcho = await Promise.race([
			streamEarly.next(),
			new Promise<"idle">((resolve) => setTimeout(() => resolve("idle"), 50)),
		]);
		expect(earlyEcho).toBe("idle");

		// The late connection registers AFTER the publish → gets the frame via replay,
		// exactly once (fan-out could not have reached it).
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

	// `lastEventId` bounds the replay: a resubscribe carrying the per-topic `seq` it
	// already saw replays ONLY the strictly-newer frames, not the whole window. The
	// topic owns the SSE `id:` (it stamps `eventId = String(seq)` on publish, #731),
	// so the cursor the client carries on reconnect is that seq — here `"1"`.
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

		// Two frames published before any register; the topic stamps seq 1, then 2.
		const frameOld: DeliverFrame = {kind: "next", id: "", event: {data: {n: 1}}};
		const frameNew: DeliverFrame = {kind: "next", id: "", event: {data: {n: 2}}};
		await run(topic.publish({topicKey, frame: frameOld, limits: LIMITS}));
		await run(topic.publish({topicKey, frame: frameNew, limits: LIMITS}));

		// Resubscribe declaring it already saw seq 1 → replay must skip seq 1, deliver seq 2.
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
		// Only the newer frame replays — its SSE `id:` header carries seq 2.
		expect(frame).toContain("id: 2");
		expect(frame).not.toContain("id: 1\n");

		const echo = await Promise.race([
			stream.next(),
			new Promise<"idle">((resolve) => setTimeout(() => resolve("idle"), 50)),
		]);
		expect(echo).toBe("idle");

		await stream.cancel();
	});

	// The #731 fix, at the cursor that exposes it: the reconnect `lastEventId` is the
	// last per-topic `seq` the client saw, and replay must skip `seq <= cursor` and
	// deliver STRICTLY-newer — even when the cursor frame itself has aged out of the
	// window. The old string-equality scan walked the window looking for the exact
	// `eventId === lastEventId`; when that frame is gone it never matches, so it
	// wrongly DROPS every newer frame too — the client never catches up and its scalar
	// is stuck at the stale value it last applied (the #731 clobber, replay side).
	//
	// Drive register directly (deterministic `subscribedAt`) over a SEPARATE topic with
	// no fan-out row, so the only path a frame can arrive is replay. Publish seq 1, then
	// seq 2; age seq 1 out of the window; reconnect with cursor `"1"`. The numeric skip
	// replays seq 2 (`2 > 1`); the string scan, never finding seq 1, drops it.
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

		// Activate `subId` on the connection via the decoy (so the replayed deliver isn't
		// stale), generation 1 / revision 1 — matching the manual row below.
		await run(connection.subscribe({subId, topics: [decoyKey], ownerId, limits: LIMITS}));

		// A short TTL: seq 1 is published, then aged past its window; seq 2 lands fresh.
		const limits: LiveLimits = {...LIMITS, bufferedFrameTtlMs: 30};
		const frameOld: DeliverFrame = {kind: "next", id: "", event: {data: {score: 1}}};
		const frameNew: DeliverFrame = {kind: "next", id: "", event: {data: {score: 2}}};
		const beforePublish = Date.now();
		await run(topic.publish({topicKey, frame: frameOld, limits})); // seq 1 (the cursor frame)
		await new Promise((resolve) => setTimeout(resolve, 50)); // seq 1 ages past the 30ms TTL
		await run(topic.publish({topicKey, frame: frameNew, limits})); // seq 2 (strictly newer, fresh)

		// Reconnect carrying cursor `"1"` — the seq it last saw, now aged out of the window.
		// Register from BEFORE either publish so the `subscribedAt` floor admits seq 2.
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

		// seq 2 replays (strictly newer than the cursor), carrying its SSE `id: 2`. The
		// old string scan would have dropped it (cursor frame seq 1 is gone), stranding
		// the client on the stale score-1 it last applied.
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

	// The PRIMARY replay bound is `subscribedAt`: replay delivers ONLY frames
	// published at/after the subscriber's intent instant. These two tests drive
	// `register` directly with an explicit `subscribedAt` so the window edge is
	// deterministic (no wall-clock race). To isolate the REPLAY path from fan-out,
	// the connection subscribes to a DECOY topic (activating the subId on the
	// connection so the replayed deliver isn't stale) while the frame is published to
	// a SEPARATE topic with NO registered row — so fan-out reaches nothing and the
	// only way the frame can arrive is replay on the manual `register`.
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

		// Publish to the REAL topic (no registered row → fan-out delivers nothing),
		// then register a row with `subscribedAt` set BEFORE the frame's publish time:
		// the frame is at/after intent → replay must deliver it.
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

		// Publish to the REAL topic, then register with `subscribedAt` set WELL AFTER
		// the frame's publish time (past the clock grace) — the frame predates the
		// subscriber's intent, the regression's stale-history case. It must NOT replay.
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

	// The buffer is bounded by TTL: a register that lands past the window gets no
	// replay — the race window is a few seconds, not unbounded retention.
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

		// A 1ms TTL + a real gap before register: the buffered frame is past its
		// window by the time replay runs, so nothing replays. (A 0ms TTL would race
		// the clock — a same-millisecond publish+register is `now - at === 0`, still
		// inside the `<= ttl` window.)
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

		// No replay frame — only the idle timeout resolves.
		const echo = await Promise.race([
			stream.next(),
			new Promise<"idle">((resolve) => setTimeout(() => resolve("idle"), 50)),
		]);
		expect(echo).toBe("idle");

		await stream.cancel();
	});
});

// The epoch fence (#1072): the `subscribedAt - REPLAY_CLOCK_GRACE_MS` time-grace alone
// admits ANY frame published within 1s before a (re)subscribe — including a frame published
// BEFORE this connection's current epoch began. On a cursorless reconnect under a reused
// connectionId the epoch bumps, but the replayed pre-epoch frame carries the CURRENT
// generation, so `isStale` doesn't catch it → it leaks onto the new stream ahead of the live
// frame. `replayBuffer` now ALSO floors at `epochStartedAt`, which a pre-epoch frame can never
// beat — while a #714 register-race frame (published after `openStream`) still clears it. The
// existing `subscribedAt + 60_000` test only covers the coarse past-grace case; these cover the
// grace-window edge that leaked.
describe("LiveDO replay epoch fence (#1072)", () => {
	// Driven via direct `register` with explicit `subscribedAt` + `epochStartedAt` so the
	// window edges are deterministic (no wall-clock race), mirroring the `subscribedAt`-floor
	// tests: subscribe to a DECOY topic to activate the subId on the connection, publish to a
	// SEPARATE topic with NO registered row (fan-out reaches nothing), so replay is the only
	// path the frame could arrive by.
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

		// The epoch began strictly AFTER the frame was buffered (a reconnect past the
		// publish), while `subscribedAt` sits INSIDE the 1s grace — so the time-grace floor
		// alone (`subscribedAt - 1000` ≈ `afterPublish - 900` ≤ buffered.at) WOULD admit it
		// (the pre-fix leak). The epoch floor (`epochStartedAt` > buffered.at) excludes it.
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

		// The epoch began BEFORE the frame was published (the stream was already open when
		// the race frame fired) and `subscribedAt` is at the epoch start — the #714 catch-up
		// case. `buffered.at >= epochStartedAt`, so the fence does NOT exclude it.
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

	// The real-client flake shape end to end: a cursorless reconnect under a reused
	// connectionId, driven through `openStream` → `subscribe` (which threads the recorded
	// `epochStartedAt`), not a direct `register`. A small real gap before the reconnect makes
	// `epochStartedAt` strictly later than the buffered frame yet far inside the 1s grace, so
	// pre-fix the time-grace floor would leak the prior frame onto the reconnected stream.
	it("a frame buffered before a cursorless reconnect's epoch does not leak onto the new stream", async () => {
		const cell = makeLiveCell();
		const topicKey = "Post:posts-reconnect";
		const {instance: topic} = makeTopic(cell, topicKey);
		const connection = makeConnection(cell, "conn-reconnect");
		const ownerId = "owner-reconnect";

		// First connect (epoch 1): a connection exists so the frame is realistic, but no
		// subscription yet — the published frame lands only in the buffer.
		await run(
			connection.openStream({
				ownerId,
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);
		await run(topic.publish({topicKey, frame: entityFrame, limits: LIMITS}));

		// A real gap so the reconnect's `epochStartedAt` is strictly after the buffered
		// frame's `at`, yet far inside the 1s grace (pre-fix, the grace floor still admits it).
		await new Promise((resolve) => setTimeout(resolve, 5));

		// Reconnect under the SAME connectionId (epoch 2): generation bumps, a fresh
		// `epochStartedAt` is recorded — strictly after the buffered frame.
		const res = await run(
			connection.openStream({
				ownerId,
				maxQueuedEventsPerConnection: LIMITS.maxQueuedEventsPerConnection,
			}),
		);
		const stream = await reader(res);
		expect(await stream.next()).toContain("connected");

		// Cursorless resubscribe on the reconnected stream → register (generation 2) →
		// replay. The buffered frame predates epoch 2, so the epoch fence excludes it.
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
});

// The OTHER buffer bound is the count cap (`maxBufferedFramesPerTopic`): the ring
// stays small so a topic DO's storage can't grow without limit under a publish
// storm with no subscriber to drain it. Prune runs INLINE on every publish
// (`appendToBuffer`) and on register (`replayBuffer`), with no background sweep.
//
// Non-obvious shape exercised here: prune is "prune-then-append" — `appendToBuffer`
// prunes the EXISTING buffer (to the cap) and then writes the new frame, so storage
// settles at cap+1 frames, while the read path (`pruneBuffer` inside `replayBuffer`)
// prunes again and only ever hands replay the newest `cap` survivors. The cap is the
// thing under test, so these drive it directly with a small `maxBufferedFramesPerTopic`.
describe("LiveDO replay buffer count-cap overflow prune", () => {
	/** The seqs currently retained in a topic's storage-backed ring, ascending. */
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

		// Cap of 3, no registered subscriber: every publish only writes the ring.
		const cap = 3;
		const limits: LiveLimits = {...LIMITS, maxBufferedFramesPerTopic: cap};

		// Publish far past the cap (seq 1..10). Prune-then-append settles storage at
		// cap+1: the prune (which runs BEFORE the append) trims the existing ring to
		// `cap`, then the new frame lands → `cap + 1` retained.
		const total = 10;
		for (let i = 0; i < total; i++) {
			await run(topic.publish({topicKey, frame: entityFrame, limits}));
		}

		const retained = await bufferedSeqs(fake, topicKey);
		// (a) bounded: never grows with publish count — exactly cap+1, not `total`.
		expect(retained.length).toBe(cap + 1);
		// (b)+(c) the SURVIVORS are the newest contiguous window: seqs 7,8,9,10. The
		// oldest (1..6) were pruned, lowest-seq-first.
		expect(retained).toEqual([total - cap, total - cap + 1, total - cap + 2, total]);
		expect(retained[0]).toBe(total - cap); // oldest survivor
		expect(retained[retained.length - 1]).toBe(total); // newest survivor retained
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

		// Activate the subId on the connection via a decoy topic (revision 1 /
		// generation 1), so the replayed deliver to the REAL topic isn't stale.
		await run(connection.subscribe({subId, topics: [decoyKey], ownerId, limits: LIMITS}));

		// Cap of 3; publish seq 1..6 to the real topic (no registered row → fan-out
		// reaches nothing, so replay is the only delivery path). A `subscribedAt` from
		// before any publish admits the whole surviving window, isolating the COUNT cap
		// from the `subscribedAt` bound.
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

		// Replay hands back exactly the newest `cap` frames, in order — the read-path
		// prune drops the cap+1th oldest survivor from the window. SSE `id:` carries the
		// per-topic seq, so we assert the exact retained seq range: 4, 5, 6.
		const seqs: Array<number> = [];
		for (let i = 0; i < cap; i++) {
			const frame = await stream.next();
			expect(payloadOf(frame).id).toBe(subId);
			const idLine = frame.split("\n").find((l) => l.startsWith("id: "))!;
			seqs.push(Number(idLine.slice("id: ".length)));
		}
		expect(seqs).toEqual([total - cap + 1, total - cap + 2, total]); // 4, 5, 6 — never seq 1..3

		// No further frame: the overflow (seq 1..3) was pruned, not replayed.
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

		// Cap of 3; publish seq 1..6 — survivors are 4,5,6 (per the prune above). The
		// client reconnects carrying cursor "2": a seq that has been EVICTED by the
		// count cap (it's < the oldest survivor 4). The numeric-cursor semantics (#731)
		// must resolve this to "replay everything still buffered strictly newer than 2"
		// — i.e. the whole surviving window 4,5,6 — never deliver a pruned frame, never
		// crash on a cursor it can't find in the window.
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

		// Survivors 4,5,6 all satisfy `seq > 2`, so the whole window replays in order;
		// the pruned seqs (1,2,3) are simply gone — none is delivered.
		const seqs: Array<number> = [];
		for (let i = 0; i < cap; i++) {
			const frame = await stream.next();
			expect(payloadOf(frame).id).toBe(subId);
			const idLine = frame.split("\n").find((l) => l.startsWith("id: "))!;
			seqs.push(Number(idLine.slice("id: ".length)));
		}
		expect(seqs).toEqual([total - cap + 1, total - cap + 2, total]); // 4, 5, 6

		const echo = await Promise.race([
			stream.next(),
			new Promise<"idle">((resolve) => setTimeout(() => resolve("idle"), 50)),
		]);
		expect(echo).toBe("idle");

		await stream.cancel();
	});
});

describe("LiveDO role-guard: a misrouted RPC no-ops without mutating storage (#1368)", () => {
	// Mirror live-do.ts's internal KV-key contract so the test can assert storage
	// was (not) touched directly: GENERATION_KEY is the connection-role generation
	// slot; subscriberKey is the topic-role subscriber row key.
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

		// No-op shape: not the `text/event-stream` a connection's openStream returns.
		const web = HttpServerResponse.toWeb(res);
		expect(web.status).toBe(404);
		expect(web.headers.get("content-type") ?? "").not.toContain("text/event-stream");

		// No mutation: the generation slot was never written (a connection's
		// openStream would have persisted 1).
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
		// Seed the connection's OWN KV with the row's key — an unguarded unregister
		// would `delete` it on this wrong-role call.
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
