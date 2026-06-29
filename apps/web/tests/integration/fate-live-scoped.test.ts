/**
 * Live views over SSE — the ARGS-SCOPED + auth-only half, on the run-scoped SHARED
 * stage (ADR 0104 step 7, #1027). Split from `fate-live.test.ts`: the global
 * `topic:posts` cases (which interleave frames under concurrency and can't share a
 * worker) live in `fate-live-posts.test.ts` on a DEDICATED stage.
 *
 * Both cases here are shared-safe. The auth-only 401 case never touches a topic DO.
 * The `definition.add → appendNode` case subscribes to the ARGS-scoped
 * `Term.definitions` connection keyed on a slug: the `definition.add` resolver
 * publishes via `live.topic("Term.definitions", {id: slug})`, and
 * `topicsForPublish` resolves the args-scoped key alone (args !== undefined →
 * `liveConnectionTopic(procedure, args)`, never the global wildcard — `protocol.ts`).
 * An `NS`-unique slug makes that topic key unique to this file, so a concurrent file's
 * `definition.add` (e.g. `stats.test.ts`, also on the shared stage) publishes to a
 * DIFFERENT slug's key and can't land a frame on this subscription.
 *
 * See the package seam (`fate-live/cold-start-retry.ts`, #842) for why there is no
 * harness warm-retry wrapper here: the production worker retries a cold-DO transport
 * failure itself, so the first connect/subscribe against a cold DO succeeds without a
 * test-side 5xx loop.
 */
import {beforeAll, describe, expect, it} from "vitest";
import {frameData, readEvent, readFrame} from "./_harness.ts";
import {sharedStack} from "./_integration.ts";
import {nsToken} from "./_stage-name.ts";

const h = sharedStack();

const NS = nsToken(import.meta.url);

let user: {userId: string; cookie: string};

beforeAll(async () => {
	user = await h.signUp(`${NS}-${Date.now()}@test.local`, "hunter2hunter2", "canlı");
});

describe("live views — /fate/live (args-scoped)", () => {
	it("rejects a connect with no session cookie (401)", async () => {
		const res = await h.req("/fate/live?connectionId=no-cookie", {
			headers: {accept: "text/event-stream"},
		});
		expect(res.status).toBe(401);
		await res.body?.cancel();
	});

	it("subscribe → definition.add → appendNode arrives — the LivePublisher path end-to-end", async () => {
		// `definition.add` is a `Fate.mutation`: its publish goes through the
		// per-request `LivePublisher` value (worker `livePublisherFor`) — this case
		// proves that surface reaches a subscribed connection through the deployed
		// DO fan-out.
		const slug = `${NS}-term-${Date.now()}`;
		const connectionId = `${NS}-sozluk-${Date.now()}`;
		const connect = await h.openSse(connectionId, user.cookie);
		expect(connect.status).toBe(200);

		const reader = connect.body!.getReader();
		const decoder = new TextDecoder();
		const buffer = {value: ""};
		const connected = await readFrame(reader, decoder, buffer);
		expect(connected).toContain("connected");

		// Subscribe to the ARGS-scoped `Term.definitions` connection for this slug —
		// the exact topic the mutation's `live.topic(..., {id: slug})` publishes to.
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
		// No per-test timeout override: inherit the 120s integration default. The
		// prior 30s clamp was tighter than the harness's own cold-DO readiness budget
		// (openSse + liveControl each poll up to SSE_READY_DEADLINE_MS = 60s), so a
		// cold connection+topic DO under CI load could spend the whole 30s in those
		// sanctioned readiness polls before the assertions ran — a flake, not a
		// fan-out defect (the #714 register-race replay buffer guarantees delivery).
	});
});
