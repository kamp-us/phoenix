/**
 * Live views over SSE — the owner-isolation fence on OPEN (#2563), on the run-scoped
 * SHARED stage (ADR 0104 step 7, #1027).
 *
 * The invariant `subscribe` already enforces (a control message can't act on another user's
 * connection) was ABSENT on the open path: re-opening someone else's `connectionId` reset
 * their stream. Shared-safe because `definition.add` publishes to the ARGS-scoped
 * `Term.definitions` connection keyed on an `NS`-unique slug, never the global wildcard, so
 * a concurrent file's `definition.add` can't land a frame on this subscription.
 */
import {beforeAll, describe, expect, it} from "vitest";
import {frameData, readEvent, readFrame} from "./_harness.ts";
import {sharedStack} from "./_integration.ts";
import {nsToken} from "./_stage-name.ts";

const h = sharedStack();

const NS = nsToken(import.meta.url);

let alice: {userId: string; cookie: string};
let mallory: {userId: string; cookie: string};

beforeAll(async () => {
	const stamp = Date.now();
	alice = await h.signUpYazar(`${NS}-alice-${stamp}@test.local`, "hunter2hunter2", "alice");
	mallory = await h.signUpYazar(`${NS}-mallory-${stamp}@test.local`, "hunter2hunter2", "mallory");
});

describe("live views — /fate/live owner-isolation fence (#2563)", () => {
	it("a foreign session opening the holder's connectionId is refused (403); the holder's stream survives", async () => {
		const slug = `${NS}-term-${Date.now()}`;
		const connectionId = `${NS}-conn-${Date.now()}`;

		const connect = await h.openSse(connectionId, alice.cookie);
		expect(connect.status).toBe(200);
		const reader = connect.body!.getReader();
		const decoder = new TextDecoder();
		const buffer = {value: ""};
		expect(await readFrame(reader, decoder, buffer)).toContain("connected");

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
			alice.cookie,
		);
		expect(sub.status).toBe(200);

		// The DO is warm (Alice holds it), so the fence answers at once — drive it through
		// `req`, not the ready-poll `openSse`, so the expected non-200 returns immediately
		// instead of riding the readiness budget.
		const hostile = await h.req(`/fate/live?connectionId=${encodeURIComponent(connectionId)}`, {
			headers: {accept: "text/event-stream", cookie: mallory.cookie},
		});
		expect(hostile.status).toBe(403);
		await hostile.body?.cancel();

		// Without the fence, Mallory's open would have bumped the generation and cleared
		// Alice's subscriptions, so this `appendNode` would never arrive.
		const added = await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug: slug, body: "canlı tanım"},
				select: ["id", "body"],
			},
			{cookie: alice.cookie},
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
	});
});
