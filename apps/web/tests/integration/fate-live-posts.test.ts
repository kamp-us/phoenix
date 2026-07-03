/**
 * Live views over SSE — the GLOBAL `topic:posts` half, on a DEDICATED per-file stage
 * (ADR 0104 step 7, #1027). Split from `fate-live.test.ts`: the args-scoped +
 * auth-only cases moved to the run-scoped SHARED stage (`fate-live-scoped.test.ts`).
 *
 * These cases MUST stay on a dedicated stage. Both subscribe to the GLOBAL `posts`
 * connection (no args), so `topicsForPublish` resolves the procedure-wide global
 * wildcard (`liveGlobalConnectionTopic("posts")` — `protocol.ts`): every connection in
 * the stage shares ONE topic DO. On a shared worker, a concurrent file's `post.submit`
 * (e.g. `stats.test.ts`, now on the shared stage) would interleave a foreign
 * `prependNode` frame onto that single topic and break an exact-title assertion. A
 * dedicated stage isolates the global topic from OTHER files. (connectionIds are already
 * unique; it is the global fan-out that needs the isolation.)
 *
 * Within this file the two cases share that ONE topic DO, and a buffered cross-epoch frame
 * (a prior run/epoch's, or the first case's `live post` reaching the reconnect stream) can
 * be the next frame — the worker does not epoch-fence old-epoch frames for real clients
 * (#1072, open). Both cases therefore drain frames until they see their OWN title (`live
 * post` / `regen post`) rather than asserting the very next frame.
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

		// Read until THIS case's own frame arrives. Both cases publish to the ONE global
		// `posts` topic DO on this shared dedicated stage, so a buffered cross-epoch frame
		// (a prior run/epoch's prependNode) can be the next frame — the worker does not
		// epoch-fence old-epoch frames for real clients (the deeper correctness question is
		// #1072, which stays open). Asserting the very NEXT frame is `live post` is fragile
		// against such a buffered foreign frame; instead drain frames until we see our OWN
		// `live post` prependNode, mirroring the reconnect case below. Bounded: a stream that
		// never delivers `live post` still fails.
		let payload: {kind: string; event: {type: string; edge: {node: {title: string}}}} | undefined;
		for (let i = 0; i < 10 && payload?.event.edge.node.title !== "live post"; i++) {
			const frame = await readEvent(reader, decoder, buffer);
			expect(frame).toContain("event: connection");
			payload = frameData<{kind: string; event: {type: string; edge: {node: {title: string}}}}>(
				frame,
			);
		}
		expect(payload?.kind).toBe("connection");
		expect(payload?.event.type).toBe("prependNode");
		expect(payload?.event.edge.node.title).toBe("live post");

		await reader.cancel();
	});

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

		// Read until THIS case's own frame arrives. Both cases publish to the ONE global
		// `posts` topic DO on this shared dedicated stage, so the prior `post.submit` case's
		// `live post` prependNode can still be buffered on this stream — the worker does not
		// epoch-fence old-epoch frames for real clients (the deeper correctness question is
		// #1072, which stays open). Asserting the very NEXT frame would read that stale frame;
		// instead drain prior-title frames until we see `regen post`, which preserves the
		// intent — the reconnected (current-epoch) stream DOES deliver the new frame — without
		// reading a leaked one. Bounded: a stream that never delivers `regen post` still fails.
		let title: string | undefined;
		for (let i = 0; i < 10 && title !== "regen post"; i++) {
			const frame = await readEvent(secondReader, decoder, secondBuf);
			expect(frame).toContain("event: connection");
			title = frameData<{event: {edge: {node: {title: string}}}}>(frame).event.edge.node.title;
		}
		expect(title).toBe("regen post");

		await firstReader.cancel();
		await secondReader.cancel();
	});
});
