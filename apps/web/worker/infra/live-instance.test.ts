/**
 * `ConnectionDO` + `TopicDO` on the Effect DO model — the live fan-out logic
 * (task 5, ADR 0028).
 *
 * Drives the real `makeConnectionInstance` / `makeTopicInstance` builders (the
 * exact code the inline DOs return) over the `do-state` fake — a `node:sqlite`
 * SQL engine + a Map-backed KV — wiring the two instances as in-process siblings:
 * the topic resolves the connection's `{deliver, probe}` RPC and the connection
 * resolves the topic's `{register, deregister}` RPC, exactly as the lazy
 * `getByName` cross-DO calls do in the worker. This proves the acceptance
 * criteria without workerd (the workerd black-box harness is task 7):
 *
 *   - subscribe → publish → the frame arrives on the held SSE stream;
 *   - a reconnect bumps the generation and the prior subscriber row is detected
 *     stale on the next publish (generation-based stale detection);
 *   - the 60s alarm reaps an orphaned row;
 *   - a single unreachable probe never prunes a live subscription.
 *
 * Runs in the node pool.
 */
import {liveEntityTopic} from "@nkzw/fate/server";
import {Effect} from "effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {makeFakeDurableObjectState} from "./__support__/do-state.ts";
import {
	type ConnectionInstance,
	type ConnectionRpc,
	makeConnectionInstance,
	makeTopicInstance,
	type TopicInstance,
	type TopicRpc,
} from "./live-instance.ts";

const run = <A>(effect: Effect.Effect<A, never, never>): Promise<A> => Effect.runPromise(effect);

/**
 * A live "cell": one connection DO + the topic DOs it touches, wired as
 * in-process siblings. `topics` is the registry of topic instances by key (one
 * per `topic:<key>`); a connection's `resolveTopic` and a topic's
 * `resolveConnection` close over these maps, so a `register`/`deliver`/`probe`
 * call hops between the real instances exactly as the worker's `getByName` RPC
 * does.
 */
interface LiveHarness {
	readonly connection: ConnectionInstance;
	readonly topic: (key: string) => TopicInstance;
	readonly close: () => void;
}

function makeHarness(connectionId: string): LiveHarness {
	const cells = {
		connections: new Map<string, ConnectionInstance>(),
		topics: new Map<string, TopicInstance>(),
		topicStates: new Map<string, ReturnType<typeof makeFakeDurableObjectState>>(),
	};

	const resolveConnection = (id: string): Effect.Effect<ConnectionRpc, never, never> =>
		Effect.sync(() => {
			const conn = cells.connections.get(id);
			if (!conn) {
				// An unreachable connection (no instance) → deliver/probe must reject so
				// the topic treats it as "couldn't reach", not "confirmed stale".
				return {
					deliver: () => Effect.die("unreachable connection"),
					probe: () => Effect.die("unreachable connection"),
				};
			}
			return {deliver: conn.deliver, probe: conn.probe};
		});

	const resolveTopic = (key: string): Effect.Effect<TopicRpc, never, never> =>
		Effect.sync(() => {
			let topic = cells.topics.get(key);
			if (!topic) {
				const fake = makeFakeDurableObjectState({id: `topic:${key}`});
				cells.topicStates.set(key, fake);
				topic = makeTopicInstance(fake.state, resolveConnection);
				cells.topics.set(key, topic);
			}
			return {register: topic.register, deregister: topic.deregister};
		});

	const connState = makeFakeDurableObjectState({id: `connection:${connectionId}`});
	const connection = makeConnectionInstance(connState.state, resolveTopic);
	cells.connections.set(connectionId, connection);

	return {
		connection,
		topic: (key) => {
			void resolveTopic(key); // ensure the topic instance exists
			return cells.topics.get(key)!;
		},
		close: () => {
			connState.close();
			for (const s of cells.topicStates.values()) {
				s.close();
			}
		},
	};
}

/** Read the SSE stream off an `openStream` response and collect frames. */
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

let harness: LiveHarness;

afterEach(() => {
	harness?.close();
});

describe("live fan-out (Effect DO model)", () => {
	beforeEach(() => {
		harness = makeHarness("conn-1");
	});

	it("subscribe → publish → the frame arrives on the held SSE stream", async () => {
		const ownerId = "owner-1";
		const subId = "op-1";
		const res = await run(harness.connection.openStream({ownerId, connectionId: "conn-1"}));
		const stream = await reader(res);
		expect(await stream.next()).toContain("connected");

		const sub = await run(
			harness.connection.subscribe({
				control: {kind: "subscribe", subId, type: "Post", entityId: "post-42"},
				ownerId,
			}),
		);
		expect(sub.ok).toBe(true);

		// The topic DO (a separate instance) holds exactly one subscriber row.
		const topicKey = liveEntityTopic("Post", "post-42");
		const topic = harness.topic(topicKey);

		const inlineData = {__typename: "Post", id: "post-42", score: 7};
		const pub = await run(
			topic.publish({
				kind: "entity",
				match: {type: "Post", entityId: "post-42"},
				frame: {data: inlineData, select: ["score"]},
				eventId: "evt-1",
			}),
		);
		expect(pub.delivered).toBe(1);

		// The frame crossed from the topic to the connection's held stream verbatim.
		const frame = await stream.next();
		expect(frame).toContain("event: next");
		expect(frame).toContain("id: evt-1");
		const dataLine = frame.split("\n").find((l) => l.startsWith("data: "))!;
		const payload = JSON.parse(dataLine.slice("data: ".length)) as {
			kind: string;
			id: string;
			event: {data: unknown; select: string[]};
		};
		expect(payload.kind).toBe("next");
		expect(payload.id).toBe(subId);
		expect(payload.event.data).toEqual(inlineData); // no re-resolution
		expect(payload.event.select).toEqual(["score"]);

		await stream.cancel();
	});

	it("a control message cannot subscribe on another user's behalf", async () => {
		await run(harness.connection.openStream({ownerId: "owner-1", connectionId: "conn-1"}));
		const sub = await run(
			harness.connection.subscribe({
				control: {kind: "subscribe", subId: "op", type: "Post", entityId: "p"},
				ownerId: "owner-2",
			}),
		);
		expect(sub.ok).toBe(false);
	});

	it("a reconnect bumps the generation; the prior row is detected stale on publish", async () => {
		const ownerId = "owner-stale";
		const subId = "stale-op";
		// Open + subscribe at generation 1.
		await run(harness.connection.openStream({ownerId, connectionId: "conn-1"}));
		await run(
			harness.connection.subscribe({
				control: {kind: "subscribe", subId, type: "Comment", entityId: "c-1"},
				ownerId,
			}),
		);
		const topicKey = liveEntityTopic("Comment", "c-1");
		const topic = harness.topic(topicKey);

		// Reconnect: generation bumps to 2 and the prior subscription is dropped.
		// The topic DO still holds the generation-1 row.
		await run(harness.connection.openStream({ownerId, connectionId: "conn-1"}));

		// A publish now finds the generation-1 row stale (connection at gen 2) and
		// prunes it — nothing delivered.
		const pub = await run(
			topic.publish({
				kind: "entity",
				match: {type: "Comment", entityId: "c-1"},
				frame: {data: {__typename: "Comment", id: "c-1", score: 1}},
			}),
		);
		expect(pub.delivered).toBe(0);

		// The row was pruned: a second publish still delivers nothing (no resurrected row).
		const pub2 = await run(
			topic.publish({
				kind: "entity",
				match: {type: "Comment", entityId: "c-1"},
				frame: {data: {__typename: "Comment", id: "c-1", score: 2}},
			}),
		);
		expect(pub2.delivered).toBe(0);
	});

	it("the generation is persisted (survives an eviction) so a reconnect lands higher", async () => {
		// Share the DO's storage across two instances = the same named DO surviving
		// an eviction (fresh in-memory cache over persisted KV).
		const {DatabaseSync} = await import("node:sqlite");
		const db = new DatabaseSync(":memory:");
		const kv = new Map<string, unknown>();
		const s1 = makeFakeDurableObjectState({id: "connection:evict", db, kv});
		const conn1 = makeConnectionInstance(s1.state, () => Effect.die("no topic"));
		await run(conn1.openStream({ownerId: "o", connectionId: "evict"})); // generation → 1
		expect((await run(conn1.probe())).generation).toBe(1);

		// Re-instantiate over the same persisted storage (eviction): the fresh cache
		// reloads generation 1 from KV, and the reconnect bumps to 2 — not back to 1.
		const s2 = makeFakeDurableObjectState({id: "connection:evict", db, kv});
		const conn2 = makeConnectionInstance(s2.state, () => Effect.die("no topic"));
		expect((await run(conn2.probe())).generation).toBe(1);
		await run(conn2.openStream({ownerId: "o", connectionId: "evict"})); // generation → 2
		expect((await run(conn2.probe())).generation).toBe(2);
		s1.close();
		s2.close();
		db.close();
	});

	it("the alarm reaps a row whose connection has reconnected to a higher generation", async () => {
		const ownerId = "owner-alarm";
		const subId = "alarm-op";
		await run(harness.connection.openStream({ownerId, connectionId: "conn-1"}));
		await run(
			harness.connection.subscribe({
				control: {kind: "subscribe", subId, type: "Term", entityId: "t-1"},
				ownerId,
			}),
		);
		const topicKey = liveEntityTopic("Term", "t-1");
		const topic = harness.topic(topicKey);

		// Reconnect (generation 2) — the row is now orphaned at generation 1.
		await run(harness.connection.openStream({ownerId, connectionId: "conn-1"}));

		await run(topic.alarm());

		// The alarm pruned the stale row: a publish delivers nothing.
		const pub = await run(
			topic.publish({
				kind: "entity",
				match: {type: "Term", entityId: "t-1"},
				frame: {data: {__typename: "Term", id: "t-1"}},
			}),
		);
		expect(pub.delivered).toBe(0);
	});

	it("a single unreachable probe does not prune a live subscription", async () => {
		// Build a topic whose connection sibling is always unreachable (no instance),
		// so deliver/probe reject — the topic must treat that as "couldn't reach".
		const topicState = makeFakeDurableObjectState({id: "topic:unreachable"});
		const topic = makeTopicInstance(topicState.state, () =>
			Effect.sync(() => ({
				deliver: () => Effect.die("unreachable"),
				probe: () => Effect.die("unreachable"),
			})),
		);
		await run(topic.register({connectionId: "gone", subId: "op", generation: 1}));

		// One alarm: still unreachable, below the eviction threshold — the row stays,
		// so a (re)deliver attempt still finds it (delivered 0 because unreachable,
		// but the row is not pruned). Publish twice to prove the row survives.
		await run(topic.alarm());
		const pub = await run(
			topic.publish({
				kind: "entity",
				match: {type: "Foo", entityId: "x"},
				frame: {data: {}},
			}),
		);
		// Unreachable connection → not delivered, but the row was NOT pruned (a single
		// failure is "couldn't reach", not "confirmed stale").
		expect(pub.delivered).toBe(0);
		await run(topic.alarm()); // a 2nd miss, still below MAX_PROBE_MISSES (3)
		const pub2 = await run(
			topic.publish({
				kind: "entity",
				match: {type: "Foo", entityId: "x"},
				frame: {data: {}},
			}),
		);
		expect(pub2.delivered).toBe(0); // still unreachable, still present (not crashed)
		topicState.close();
	});

	it("the alarm reaps a connection that stays unreachable across the prune cycle", async () => {
		const topicState = makeFakeDurableObjectState({id: "topic:reap"});
		const topic = makeTopicInstance(topicState.state, () =>
			Effect.sync(() => ({
				deliver: () => Effect.die("unreachable"),
				probe: () => Effect.die("unreachable"),
			})),
		);
		await run(topic.register({connectionId: "dead", subId: "op", generation: 1}));

		// MAX_PROBE_MISSES = 3: the row survives the first two misses and is reaped on
		// the third. After reaping, the registry is empty.
		await run(topic.alarm());
		await run(topic.alarm());
		await run(topic.alarm());
		const rows = await run(
			Effect.flatMap(
				topicState.state.storage.sql.exec("SELECT COUNT(*) AS n FROM subscribers"),
				(c) => c.toArray(),
			),
		);
		expect((rows[0] as {n: number}).n).toBe(0);
		topicState.close();
	});

	it("delivers a connection appendNode frame to a subscribeConnection subscriber", async () => {
		const ownerId = "owner-conn";
		const subId = "op-conn";
		const res = await run(harness.connection.openStream({ownerId, connectionId: "conn-1"}));
		const stream = await reader(res);
		await stream.next(); // : connected

		await run(
			harness.connection.subscribe({
				control: {kind: "subscribeConnection", subId, procedure: "posts"},
				ownerId,
			}),
		);

		const {liveGlobalConnectionTopic} = await import("@nkzw/fate/server");
		const node = {__typename: "Post", id: "post-99", title: "new"};
		const topic = harness.topic(liveGlobalConnectionTopic("posts"));
		await run(
			topic.publish({
				kind: "connection",
				match: {procedure: "posts"},
				frame: {type: "prependNode", nodeType: "Post", edge: {node}},
			}),
		);

		const frame = await stream.next();
		expect(frame).toContain("event: connection");
		const payload = JSON.parse(
			frame
				.split("\n")
				.find((l) => l.startsWith("data: "))!
				.slice("data: ".length),
		) as {kind: string; event: {type: string; edge: {node: unknown}}};
		expect(payload.event.type).toBe("prependNode");
		expect(payload.event.edge.node).toEqual(node);
		await stream.cancel();
	});
});
