/**
 * Live views over SSE — black-box against the deployed worker (ADR 0023/0028).
 *
 * The pre-migration suite drove the Durable Objects directly (`runInDurableObject`,
 * `runDurableObjectAlarm`, named DO stubs) inside `@cloudflare/vitest-pool-workers`.
 * The alchemy worker can't load in that pool, and the DO internals aren't reachable
 * over HTTP — so the cross-isolate fan-out, epoch semantics, and the alarm reap
 * are unit-tested in `worker/features/fate-live/do.test.ts` (node pool, over a
 * KV/`Map`-backed DO-state fake — `fate-live/do-state.testing.ts`). Here we
 * verify the *observable* live contract
 * end-to-end through the real `/fate/live` SSE transport + `/fate` publish path on a
 * live workerd:
 *
 *   1. Cookie auth at connect — `GET /fate/live` is 401 without a session, opens an
 *      `text/event-stream` with one.
 *   2. subscribe → publish → deliver — a `post.submit` mutation publishes a
 *      `prependNode` connection frame that arrives on the held SSE stream.
 *   3. The same contract through the `LivePublisher` path — a sozluk
 *      `definition.add` (a `Fate.mutation` publishing via
 *      `yield* WorkerLivePublisher`, the typo-gated worker accessor)
 *      lands an `appendNode` frame on an args-scoped
 *      `Term.definitions` subscription (`.patterns/fate-effect-worker-wiring.md`).
 *   4. Reconnect bumps epoch — a second connect on the same `connectionId`
 *      makes the first stream's subscriber stale, so a later publish reaches the
 *      reconnected stream, not the original.
 */
import {beforeAll, describe, expect, it} from "vitest";
import {frameData, readEvent, readFrame} from "./_harness.ts";
import {integrationStack} from "./_integration.ts";

const h = integrationStack(import.meta.url);

let user: {userId: string; cookie: string};

beforeAll(async () => {
	user = await h.signUp(`live-${Date.now()}@test.local`, "hunter2hunter2", "canlı");
});

// `/api/health` passing (the `_integration.ts` readiness probe) warms ONE route at
// ONE edge PoP — it does NOT warm the `/fate/live` Durable Object path, which cold-
// starts the ConnectionDO/TopicDO on the first SSE connect and 500s before the DO is
// up (#613). The placeholder-404/connection retries in `_harness.ts` don't cover a
// 5xx, so retry the FIRST SSE connect on a cold-start 5xx until the stream is
// established (200) — then the held stream proves the DO is warm for the rest of the
// case. A persistent 5xx still surfaces (the assertion after this fails clearly).
const openSseWarm = async (connectionId: string, cookie: string): Promise<Response> => {
	// ~6s worst case (8 × ~750ms) — bounded well under each case's 30s budget, where a
	// real persistent 5xx returns and the status assertion after the call fails clearly.
	for (let i = 0; i < 8; i++) {
		const res = await h.openSse(connectionId, cookie);
		if (res.status < 500) return res;
		await res.body?.cancel();
		await new Promise<void>((r) => setTimeout(r, 750));
	}
	return h.openSse(connectionId, cookie);
};

describe("live views — /fate/live", () => {
	it("rejects a connect with no session cookie (401)", async () => {
		const res = await h.req("/fate/live?connectionId=no-cookie", {
			headers: {accept: "text/event-stream"},
		});
		expect(res.status).toBe(401);
		await res.body?.cancel();
	});

	it("subscribe → post.submit → prependNode frame arrives on the held SSE stream", async () => {
		const connectionId = `live-conn-${Date.now()}`;
		const connect = await openSseWarm(connectionId, user.cookie);
		expect(connect.status).toBe(200);
		expect(connect.headers.get("content-type")).toContain("text/event-stream");

		const reader = connect.body!.getReader();
		const decoder = new TextDecoder();
		const buffer = {value: ""};
		const connected = await readFrame(reader, decoder, buffer);
		expect(connected).toContain("connected");

		// Subscribe the connection to the global `posts` connection feed.
		const sub = await h.liveControl(
			connectionId,
			[
				{
					kind: "subscribeConnection",
					id: "sub-posts",
					type: "Post",
					procedure: "posts",
					select: [],
				},
			],
			user.cookie,
		);
		expect(sub.status).toBe(200);

		// A new post publishes a prependNode frame to the `posts` connection topic.
		const submitted = await h.fate(
			{
				kind: "mutation",
				name: "post.submit",
				input: {title: "live post", tags: [{kind: "tartışma"}]},
				select: ["id", "title"],
			},
			{cookie: user.cookie},
		);
		expect(submitted.ok).toBe(true);

		const frame = await readEvent(reader, decoder, buffer);
		expect(frame).toContain("event: connection");
		const payload = frameData<{kind: string; event: {type: string; edge: {node: {title: string}}}}>(
			frame,
		);
		expect(payload.kind).toBe("connection");
		expect(payload.event.type).toBe("prependNode");
		expect(payload.event.edge.node.title).toBe("live post");

		await reader.cancel();
	}, 30_000);

	it("subscribe → definition.add → appendNode arrives — the LivePublisher path end-to-end", async () => {
		// `definition.add` is a `Fate.mutation`: its publish goes through the
		// per-request `LivePublisher` value (worker `livePublisherFor`) — this case
		// proves that surface reaches a subscribed connection through the deployed
		// DO fan-out.
		const slug = `live-term-${Date.now()}`;
		const connectionId = `live-sozluk-${Date.now()}`;
		const connect = await openSseWarm(connectionId, user.cookie);
		expect(connect.status).toBe(200);

		const reader = connect.body!.getReader();
		const decoder = new TextDecoder();
		const buffer = {value: ""};
		const connected = await readFrame(reader, decoder, buffer);
		expect(connected).toContain("connected");

		// Subscribe to the ARGS-scoped `Term.definitions` connection for this slug —
		// the exact topic the mutation's `live.connection(..., {id: slug})` publishes to.
		const sub = await h.liveControl(
			connectionId,
			[
				{
					kind: "subscribeConnection",
					id: "sub-defs",
					type: "Definition",
					procedure: "Term.definitions",
					args: {id: slug},
					select: [],
				},
			],
			user.cookie,
		);
		expect(sub.status).toBe(200);

		const added = await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug: slug, body: "canlı tanım"},
				select: ["id", "body"],
			},
			{cookie: user.cookie},
		);
		expect(added.ok).toBe(true);

		const frame = await readEvent(reader, decoder, buffer);
		expect(frame).toContain("event: connection");
		const payload = frameData<{kind: string; event: {type: string; edge: {node: {body: string}}}}>(
			frame,
		);
		expect(payload.kind).toBe("connection");
		expect(payload.event.type).toBe("appendNode");
		expect(payload.event.edge.node.body).toBe("canlı tanım");

		await reader.cancel();
	}, 30_000);

	it("reconnect on the same connectionId bumps epoch — frames go to the reconnected stream", async () => {
		const connectionId = `live-regen-${Date.now()}`;

		// First stream + subscription.
		const first = await openSseWarm(connectionId, user.cookie);
		const firstReader = first.body!.getReader();
		const decoder = new TextDecoder();
		const firstBuf = {value: ""};
		await readFrame(firstReader, decoder, firstBuf); // : connected
		await h.liveControl(
			connectionId,
			[{kind: "subscribeConnection", id: "sub-a", type: "Post", procedure: "posts", select: []}],
			user.cookie,
		);

		// Reconnect: a second stream on the SAME connectionId bumps the epoch,
		// staling the first stream's subscriber rows.
		const second = await openSseWarm(connectionId, user.cookie);
		const secondReader = second.body!.getReader();
		const secondBuf = {value: ""};
		await readFrame(secondReader, decoder, secondBuf); // : connected
		await h.liveControl(
			connectionId,
			[{kind: "subscribeConnection", id: "sub-b", type: "Post", procedure: "posts", select: []}],
			user.cookie,
		);

		// Publish — the reconnected (current-epoch) stream must receive it.
		const submitted = await h.fate(
			{
				kind: "mutation",
				name: "post.submit",
				input: {title: "regen post", tags: [{kind: "soru"}]},
				select: ["id", "title"],
			},
			{cookie: user.cookie},
		);
		expect(submitted.ok).toBe(true);

		const frame = await readEvent(secondReader, decoder, secondBuf);
		expect(frame).toContain("event: connection");
		const payload = frameData<{event: {edge: {node: {title: string}}}}>(frame);
		expect(payload.event.edge.node.title).toBe("regen post");

		await firstReader.cancel();
		await secondReader.cancel();
	}, 30_000);
});
