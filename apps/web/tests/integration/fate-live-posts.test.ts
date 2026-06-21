/**
 * Live views over SSE — the GLOBAL `topic:posts` half, on a DEDICATED per-file stage
 * (ADR 0104 step 7, #1027). Split from `fate-live.test.ts`: the args-scoped +
 * auth-only cases moved to the run-scoped SHARED stage (`fate-live-scoped.test.ts`).
 *
 * These cases MUST stay on a dedicated stage. Both subscribe to the GLOBAL `posts`
 * connection (no args), so `topicsForPublish` resolves the procedure-wide global
 * wildcard (`liveGlobalConnectionTopic("posts")` — `protocol.ts`): every connection in
 * the stage shares ONE topic DO. On a shared worker, a concurrent file's `post.submit`
 * (e.g. `stats.test.ts`, now on the shared stage) would interleave an extra
 * `prependNode` frame onto that single topic — these tests read the NEXT frame and
 * assert its exact title, so a foreign frame would break the assertion. A dedicated
 * stage isolates the global topic. (connectionIds are already unique; it is the global
 * fan-out that needs the isolation.)
 *
 * See the package seam (`fate-live/cold-start-retry.ts`, #842) for why there is no
 * harness warm-retry wrapper here: the production worker retries a cold-DO transport
 * failure itself, so the first connect/subscribe against a cold DO succeeds without a
 * test-side 5xx loop.
 */
import {beforeAll, describe, expect, it} from "vitest";
import {frameData, readEvent, readFrame} from "./_harness.ts";
import {integrationStack} from "./_integration.ts";

const h = integrationStack(import.meta.url);

let user: {userId: string; cookie: string};

beforeAll(async () => {
	user = await h.signUp(`live-${Date.now()}@test.local`, "hunter2hunter2", "canlı");
});

describe("live views — /fate/live (global topic:posts)", () => {
	it("subscribe → post.submit → prependNode frame arrives on the held SSE stream", async () => {
		const connectionId = `live-conn-${Date.now()}`;
		const connect = await h.openSse(connectionId, user.cookie);
		expect(connect.status).toBe(200);
		expect(connect.headers.get("content-type")).toContain("text/event-stream");

		const reader = connect.body!.getReader();
		const decoder = new TextDecoder();
		const buffer = {value: ""};
		const connected = await readFrame(reader, decoder, buffer);
		expect(connected).toContain("connected");

		// Subscribe the connection to the global `posts` connection feed. The first
		// subscribe hits a cold topic-role DO; the worker seam absorbs the warm window.
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

	it("reconnect on the same connectionId bumps epoch — frames go to the reconnected stream", async () => {
		const connectionId = `live-regen-${Date.now()}`;

		// First stream + subscription.
		const first = await h.openSse(connectionId, user.cookie);
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
		const second = await h.openSse(connectionId, user.cookie);
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
