/**
 * LiveDO + publish-only LiveEventBus — the real-time fan-out infrastructure
 * (task 11, ADR 0023).
 *
 * Runs inside workerd against the real `LIVE_DO` Durable Object binding. Three
 * gates the operator requires:
 *
 *   1. **Cross-isolate delivery** — a `live.*` published to a topic DO is
 *      delivered over SSE to a connection subscribed elsewhere. The connection
 *      DO (`connection:<id>`) and the topic DO (`topic:<key>`) are distinct DO
 *      instances reached by separate stubs, so a frame crossing from one to the
 *      other proves the fan-out works across the isolate boundary an in-memory
 *      bus can't cross. We read the SSE frame off the connection's held stream
 *      and assert it carries the inline-published `data` verbatim — the DO does
 *      no re-resolution. `runInDurableObject` inspects the topic DO's durable
 *      subscriber registry.
 *   2. **Cookie auth at connect** — `GET /fate/live` is rejected (401) without a
 *      better-auth session cookie and accepted (200, `text/event-stream`) with
 *      one. No token in the URL.
 *   3. **Stale-subscriber pruning** — a subscriber row whose connection has since
 *      reconnected (generation bumped) is pruned on the next publish, and the
 *      60s alarm prunes a row whose connection stream is gone.
 *   4. **LiveDO isolation (the two hardening bugs)** — `generation` is persisted
 *      so it survives DO eviction (a re-instantiated connection does not report
 *      `0` and let a stale row pass as current), and a transport/deserialize
 *      failure while reaching a connection does NOT prune the subscriber row.
 */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference path="../../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
import {env, runDurableObjectAlarm, runInDurableObject, SELF} from "cloudflare:test";
import {liveEntityTopic} from "@nkzw/fate/server";
import {Effect} from "effect";
import {beforeAll, describe, expect, it} from "vitest";
import baselineMigration from "../../worker/db/drizzle/migrations/0000_d1_baseline.sql";
import type {LiveDO} from "../../worker/fate/live-do";
import {FateRuntime} from "../../worker/fate/runtime";
import {Pasaport} from "../../worker/features/pasaport/Pasaport";

declare module "cloudflare:test" {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: required by pool-workers
	interface ProvidedEnv extends Env {}
}

async function applyViewMigrations() {
	const statements = baselineMigration
		.split(/;\s*\n/)
		.map((s) => s.trim())
		.filter(Boolean);
	for (const stmt of statements) {
		try {
			await env.PHOENIX_DB.prepare(stmt).run();
		} catch (err) {
			const msg = String((err as Error).message ?? err);
			if (
				!msg.includes("already exists") &&
				!msg.includes("duplicate column") &&
				!msg.includes("no such table") &&
				!msg.includes("no such index")
			) {
				throw err;
			}
		}
	}
}

/** Connection-role stub for a connection id (named, so addressable cross-isolate). */
function connectionStub(id: string) {
	return env.LIVE_DO.get(env.LIVE_DO.idFromName(`connection:${id}`));
}

/** Topic-role stub for a topic key. */
function topicStub(key: string) {
	return env.LIVE_DO.get(env.LIVE_DO.idFromName(`topic:${key}`));
}

/** Read one SSE event (delimited by a blank line) off a stream reader. */
async function readFrame(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	decoder: TextDecoder,
	buffer: {value: string},
): Promise<string> {
	for (let i = 0; i < 50; i++) {
		const idx = buffer.value.indexOf("\n\n");
		if (idx !== -1) {
			const frame = buffer.value.slice(0, idx);
			buffer.value = buffer.value.slice(idx + 2);
			return frame;
		}
		const {value, done} = await reader.read();
		if (done) {
			return buffer.value;
		}
		buffer.value += decoder.decode(value, {stream: true});
	}
	throw new Error("timed out waiting for SSE frame");
}

/** Sign up a user through the worker-mounted better-auth route; return its cookie. */
async function signUpUser(
	email: string,
	password: string,
	name: string,
): Promise<{userId: string; cookie: string}> {
	const req = new Request("https://test.local/api/auth/sign-up/email", {
		method: "POST",
		headers: {"content-type": "application/json"},
		body: JSON.stringify({email, password, name}),
	});
	const runtime = FateRuntime.make(env, req, null);
	let response: Response;
	try {
		response = await runtime.runPromise(
			Effect.gen(function* () {
				const pasaport = yield* Pasaport;
				return yield* pasaport.handleAuth(req);
			}),
		);
	} finally {
		await runtime.dispose();
	}
	if (!response.ok) {
		throw new Error(`sign-up failed: ${response.status} ${await response.text()}`);
	}
	const setCookie = response.headers.get("set-cookie");
	if (!setCookie) {
		throw new Error("sign-up returned no set-cookie");
	}
	// `set-cookie` may carry attributes (Path, HttpOnly, …); keep just `name=value`.
	const cookie = setCookie
		.split(",")
		.map((part) => part.split(";")[0]!.trim())
		.filter((kv) => kv.includes("="))
		.join("; ");
	const data = (await response.json()) as {user?: {id: string}};
	if (!data.user?.id) {
		throw new Error("sign-up returned no user id");
	}
	return {userId: data.user.id, cookie};
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("LiveDO cross-isolate delivery", () => {
	it("delivers a live.update published to a topic DO to a connection subscribed elsewhere", async () => {
		const connId = "x-conn-1";
		const ownerId = "owner-1";
		const subId = "op-1";
		const conn = connectionStub(connId);

		// 1. Open the SSE stream on the connection DO.
		const connectRes = await conn.fetch(
			`https://live/connect?ownerId=${encodeURIComponent(ownerId)}`,
		);
		expect(connectRes.status).toBe(200);
		expect(connectRes.headers.get("content-type")).toContain("text/event-stream");
		const reader = connectRes.body!.getReader();
		const decoder = new TextDecoder();
		const buffer = {value: ""};
		// First frame is the `: connected` comment.
		const connected = await readFrame(reader, decoder, buffer);
		expect(connected).toContain("connected");

		// 2. Subscribe the connection to a `Post` entity — registers on the topic DO.
		const subRes = await conn.fetch("https://live/subscribe", {
			method: "POST",
			body: JSON.stringify({
				control: {kind: "subscribe", subId, type: "Post", entityId: "post-42"},
				ownerId,
			}),
		});
		expect(subRes.status).toBe(200);

		// The topic DO (a *different* instance) now holds one subscriber row.
		const topicKey = liveEntityTopic("Post", "post-42");
		const rowCount = await runInDurableObject(
			topicStub(topicKey),
			(_instance: LiveDO, state) =>
				state.storage.sql.exec("SELECT COUNT(*) AS n FROM subscribers").one().n as number,
		);
		expect(rowCount).toBe(1);

		// 3. Publish an entity update to the topic DO with inline-resolved data.
		const inlineData = {__typename: "Post", id: "post-42", score: 7};
		const pubRes = await topicStub(topicKey).fetch("https://live/publish", {
			method: "POST",
			body: JSON.stringify({
				kind: "entity",
				match: {type: "Post", entityId: "post-42"},
				frame: {data: inlineData, select: ["score"]},
				eventId: "evt-1",
			}),
		});
		expect(((await pubRes.json()) as {delivered: number}).delivered).toBe(1);

		// 4. The frame crosses to the connection DO's held stream verbatim.
		const frame = await readFrame(reader, decoder, buffer);
		expect(frame).toContain("event: next");
		expect(frame).toContain("id: evt-1");
		const dataLine = frame.split("\n").find((l) => l.startsWith("data: "))!;
		const payload = JSON.parse(dataLine.slice("data: ".length)) as {
			kind: string;
			id: string;
			event: {data: {id: string; score: number}; select: string[]};
		};
		expect(payload.kind).toBe("next");
		expect(payload.id).toBe(subId);
		// The DO did no re-resolution — the inline data is relayed as published.
		expect(payload.event.data).toEqual(inlineData);
		expect(payload.event.select).toEqual(["score"]);

		await reader.cancel();
	});

	it("delivers a connection appendNode frame across instances", async () => {
		const connId = "x-conn-2";
		const ownerId = "owner-2";
		const subId = "op-conn";
		const conn = connectionStub(connId);
		const connectRes = await conn.fetch(`https://live/connect?ownerId=${ownerId}`);
		const reader = connectRes.body!.getReader();
		const decoder = new TextDecoder();
		const buffer = {value: ""};
		await readFrame(reader, decoder, buffer); // : connected

		await conn.fetch("https://live/subscribe", {
			method: "POST",
			body: JSON.stringify({
				control: {kind: "subscribeConnection", subId, procedure: "posts"},
				ownerId,
			}),
		});

		const node = {__typename: "Post", id: "post-99", title: "new"};
		// A connection publish reaches the global topic for `posts`.
		const {liveGlobalConnectionTopic} = await import("@nkzw/fate/server");
		await topicStub(liveGlobalConnectionTopic("posts")).fetch("https://live/publish", {
			method: "POST",
			body: JSON.stringify({
				kind: "connection",
				match: {procedure: "posts"},
				frame: {type: "prependNode", nodeType: "Post", edge: {node}},
			}),
		});

		const frame = await readFrame(reader, decoder, buffer);
		expect(frame).toContain("event: connection");
		const dataLine = frame.split("\n").find((l) => l.startsWith("data: "))!;
		const payload = JSON.parse(dataLine.slice("data: ".length)) as {
			kind: string;
			event: {type: string; nodeType: string; edge: {node: unknown}};
		};
		expect(payload.kind).toBe("connection");
		expect(payload.event.type).toBe("prependNode");
		expect(payload.event.edge.node).toEqual(node);

		await reader.cancel();
	});
});

describe("LiveDO cookie auth at connect", () => {
	it("rejects GET /fate/live without a session cookie", async () => {
		const res = await SELF.fetch("https://test.local/fate/live?connectionId=anon-conn");
		expect(res.status).toBe(401);
		const body = (await res.json()) as {results: Array<{error: {code: string}}>};
		expect(body.results[0]!.error.code).toBe("UNAUTHORIZED");
	});

	it("accepts GET /fate/live with a valid session cookie", async () => {
		const {cookie} = await signUpUser("live-auth@test.local", "supersecret123", "Live Auth");
		const res = await SELF.fetch("https://test.local/fate/live?connectionId=auth-conn", {
			headers: {cookie},
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		await res.body?.cancel();
	});
});

describe("LiveDO stale-subscriber pruning", () => {
	it("prunes a row whose connection has reconnected (generation bump) on publish", async () => {
		const connId = "stale-conn-1";
		const ownerId = "owner-stale";
		const subId = "stale-op";
		const conn = connectionStub(connId);

		// Open + subscribe (generation 1).
		const first = await conn.fetch(`https://live/connect?ownerId=${ownerId}`);
		const firstReader = first.body!.getReader();
		await conn.fetch("https://live/subscribe", {
			method: "POST",
			body: JSON.stringify({
				control: {kind: "subscribe", subId, type: "Comment", entityId: "c-1"},
				ownerId,
			}),
		});
		const topicKey = liveEntityTopic("Comment", "c-1");
		const before = await runInDurableObject(
			topicStub(topicKey),
			(_i: LiveDO, s) =>
				s.storage.sql.exec("SELECT COUNT(*) AS n FROM subscribers").one().n as number,
		);
		expect(before).toBe(1);

		// Reconnect the same connection: generation bumps to 2, dropping the prior
		// subscription. The topic DO still holds the generation-1 row.
		await firstReader.cancel();
		const second = await conn.fetch(`https://live/connect?ownerId=${ownerId}`);
		const secondReader = second.body!.getReader();

		// A publish now finds the generation-1 row stale (connection is at gen 2)
		// and prunes it.
		const pub = await topicStub(topicKey).fetch("https://live/publish", {
			method: "POST",
			body: JSON.stringify({
				kind: "entity",
				match: {type: "Comment", entityId: "c-1"},
				frame: {data: {__typename: "Comment", id: "c-1", score: 1}},
			}),
		});
		expect(((await pub.json()) as {delivered: number}).delivered).toBe(0);

		const after = await runInDurableObject(
			topicStub(topicKey),
			(_i: LiveDO, s) =>
				s.storage.sql.exec("SELECT COUNT(*) AS n FROM subscribers").one().n as number,
		);
		expect(after).toBe(0);

		await secondReader.cancel();
	});

	it("prunes a row whose connection stream is gone via the 60s alarm", async () => {
		const connId = "stale-conn-2";
		const ownerId = "owner-alarm";
		const subId = "alarm-op";
		const conn = connectionStub(connId);

		const res = await conn.fetch(`https://live/connect?ownerId=${ownerId}`);
		const reader = res.body!.getReader();
		await conn.fetch("https://live/subscribe", {
			method: "POST",
			body: JSON.stringify({
				control: {kind: "subscribe", subId, type: "Term", entityId: "t-1"},
				ownerId,
			}),
		});
		const topicKey = liveEntityTopic("Term", "t-1");

		// Reconnect to a fresh generation, then cancel — the prior subscription's
		// row is now orphaned (its generation no longer matches the connection).
		await reader.cancel();
		const reconnect = await conn.fetch(`https://live/connect?ownerId=${ownerId}`);
		await reconnect.body!.cancel();

		const ran = await runDurableObjectAlarm(topicStub(topicKey));
		expect(ran).toBe(true);

		const after = await runInDurableObject(
			topicStub(topicKey),
			(_i: LiveDO, s) =>
				s.storage.sql.exec("SELECT COUNT(*) AS n FROM subscribers").one().n as number,
		);
		expect(after).toBe(0);
	});
});

describe("LiveDO generation survives eviction (BUG §4a)", () => {
	it("a re-instantiated connection reports its persisted generation, not 0", async () => {
		const connId = "evict-conn-1";
		const ownerId = "owner-evict";
		const conn = connectionStub(connId);

		// Open the stream — generation bumps to 1 and is persisted to DO storage.
		const res = await conn.fetch(`https://live/connect?ownerId=${ownerId}`);
		await res.body!.cancel();

		// The persisted generation is in DO storage (survives eviction), not just
		// in memory.
		const persisted = await runInDurableObject(connectionStub(connId), (_i: LiveDO, s) =>
			s.storage.get<number>("generation"),
		);
		expect(persisted).toBe(1);

		// Simulate a DO eviction: clear the in-memory generation cache so the next
		// access has to reload from storage. A bug where `generation` lives only in
		// memory would reset to 0 here.
		await runInDurableObject(connectionStub(connId), (instance: LiveDO) => {
			(instance as unknown as {generation: number | undefined}).generation = undefined;
		});

		// Probe the re-instantiated connection: it reports the persisted value (1),
		// NOT a reset 0. A stale row registered at generation 1 would therefore be
		// (correctly) treated as still-current, and a *new* reconnect lands on 2 —
		// so no collision with the stale row.
		const probe = await conn.fetch("https://live/probe", {method: "POST"});
		expect(((await probe.json()) as {generation: number}).generation).toBe(1);
	});

	it("a stale pre-eviction row is pruned because the reconnect lands on a higher generation", async () => {
		const connId = "evict-conn-2";
		const ownerId = "owner-evict-2";
		const subId = "evict-op";
		const conn = connectionStub(connId);

		// Open + subscribe at generation 1.
		const first = await conn.fetch(`https://live/connect?ownerId=${ownerId}`);
		await conn.fetch("https://live/subscribe", {
			method: "POST",
			body: JSON.stringify({
				control: {kind: "subscribe", subId, type: "Post", entityId: "evict-post"},
				ownerId,
			}),
		});
		await first.body!.cancel();
		const topicKey = liveEntityTopic("Post", "evict-post");

		// Simulate eviction by clearing the in-memory cache, then reconnect. With a
		// persisted counter the reconnect reads 1 from storage and bumps to 2; an
		// in-memory-only counter would reset to 0 and bump back to 1 — colliding
		// with the stale row.
		await runInDurableObject(connectionStub(connId), (instance: LiveDO) => {
			(instance as unknown as {generation: number | undefined}).generation = undefined;
		});
		const reconnect = await conn.fetch(`https://live/connect?ownerId=${ownerId}`);
		await reconnect.body!.cancel();

		const probe = await conn.fetch("https://live/probe", {method: "POST"});
		expect(((await probe.json()) as {generation: number}).generation).toBe(2);

		// Publishing now finds the generation-1 row stale (connection at gen 2) and
		// prunes it — no cross-talk onto the fresh stream.
		const pub = await topicStub(topicKey).fetch("https://live/publish", {
			method: "POST",
			body: JSON.stringify({
				kind: "entity",
				match: {type: "Post", entityId: "evict-post"},
				frame: {data: {__typename: "Post", id: "evict-post", score: 1}},
			}),
		});
		expect(((await pub.json()) as {delivered: number}).delivered).toBe(0);

		const after = await runInDurableObject(
			topicStub(topicKey),
			(_i: LiveDO, s) =>
				s.storage.sql.exec("SELECT COUNT(*) AS n FROM subscribers").one().n as number,
		);
		expect(after).toBe(0);
	});
});

describe("LiveDO leaves rows on transport failure (BUG §4d)", () => {
	it("publish does not prune a subscriber row when the connection DO is unreachable", async () => {
		const ownerId = "owner-unreachable";
		const subId = "unreachable-op";
		const topicKey = liveEntityTopic("Term", "unreachable-term");

		// Register a row pointing at a connection id that is a well-formed DO id but
		// whose `/deliver` will throw inside `publish` (forced below). We seed the
		// row directly via a real connection so the id is a valid `idFromString`.
		const conn = connectionStub("unreachable-conn");
		const open = await conn.fetch(`https://live/connect?ownerId=${ownerId}`);
		await conn.fetch("https://live/subscribe", {
			method: "POST",
			body: JSON.stringify({
				control: {kind: "subscribe", subId, type: "Term", entityId: "unreachable-term"},
				ownerId,
			}),
		});
		await open.body!.cancel();

		const before = await runInDurableObject(
			topicStub(topicKey),
			(_i: LiveDO, s) =>
				s.storage.sql.exec("SELECT COUNT(*) AS n FROM subscribers").one().n as number,
		);
		expect(before).toBe(1);

		// Make the connection DO throw on the next `/deliver` by stubbing its fetch
		// to reject — simulating a transport/deserialize failure (network blip, DO
		// crash mid-parse). The publish must treat this as "couldn't reach", not
		// "confirmed stale", and leave the row.
		await runInDurableObject(connectionStub("unreachable-conn"), (instance: LiveDO) => {
			(instance as unknown as {fetch: () => Promise<Response>}).fetch = () => {
				throw new Error("simulated transport failure");
			};
		});

		const pub = await topicStub(topicKey).fetch("https://live/publish", {
			method: "POST",
			body: JSON.stringify({
				kind: "entity",
				match: {type: "Term", entityId: "unreachable-term"},
				frame: {data: {__typename: "Term", id: "unreachable-term"}},
			}),
		});
		expect(((await pub.json()) as {delivered: number}).delivered).toBe(0);

		// The row survives: an unreachable connection is not confirmed stale.
		const after = await runInDurableObject(
			topicStub(topicKey),
			(_i: LiveDO, s) =>
				s.storage.sql.exec("SELECT COUNT(*) AS n FROM subscribers").one().n as number,
		);
		expect(after).toBe(1);
	});

	it("alarm does not prune a subscriber row when the connection DO probe fails", async () => {
		const ownerId = "owner-alarm-fail";
		const subId = "alarm-fail-op";
		const topicKey = liveEntityTopic("Comment", "alarm-fail-c");

		const conn = connectionStub("alarm-fail-conn");
		const open = await conn.fetch(`https://live/connect?ownerId=${ownerId}`);
		await conn.fetch("https://live/subscribe", {
			method: "POST",
			body: JSON.stringify({
				control: {kind: "subscribe", subId, type: "Comment", entityId: "alarm-fail-c"},
				ownerId,
			}),
		});
		await open.body!.cancel();

		// Force the connection's `/probe` to throw.
		await runInDurableObject(connectionStub("alarm-fail-conn"), (instance: LiveDO) => {
			(instance as unknown as {fetch: () => Promise<Response>}).fetch = () => {
				throw new Error("simulated probe failure");
			};
		});

		const ran = await runDurableObjectAlarm(topicStub(topicKey));
		expect(ran).toBe(true);

		// The alarm could not reach the connection — the row is left, not pruned.
		const after = await runInDurableObject(
			topicStub(topicKey),
			(_i: LiveDO, s) =>
				s.storage.sql.exec("SELECT COUNT(*) AS n FROM subscribers").one().n as number,
		);
		expect(after).toBe(1);
	});
});
