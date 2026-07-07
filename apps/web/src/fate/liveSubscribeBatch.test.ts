/**
 * Regression for #2273: react-fate's HTTP transport (defined in `@nkzw/fate`, re-exported
 * by `react-fate` — the import phoenix uses) must coalesce same-tick live subscribe control
 * messages into ONE `POST /fate/live`. Unpatched 1.3.1 fired a separate `control([op])` per
 * `add()` after the SSE `open`, so a feed load with N `useLiveView` mounts issued N
 * single-operation POSTs, each re-running better-auth session validation (~22 on an authed
 * /pano load). Fixed by `patches/@nkzw__fate@1.3.1.patch` (ADR 0038), which buffers adds and
 * flushes them as one batched control POST — the same batching the reconnect path already
 * did via `control(resubscribe)`. This drives the native live client through a mocked
 * EventSource + fetch and asserts one POST carries every operation, and that a live frame
 * still routes to each subscription afterward.
 */

import {createHTTPTransport} from "react-fate";
import {describe, expect, it, vi} from "vitest";

type ControlOperation = {
	id: string;
	kind: string;
	entityId?: string;
	type?: string;
	procedure?: string;
};
type ControlBody = {
	connectionId: string;
	operations: ReadonlyArray<ControlOperation>;
	version: number;
};

type Listener = (event: unknown) => void;

// The shape createHTTPTransport's `eventSource` option expects (its EventSourceConstructor
// type is not exported); MockEventSource is asserted to it once at the call site.
type EventSourceCtor = new (
	url: string,
	options?: {withCredentials?: boolean},
) => {
	addEventListener(type: string, listener: (event: Event) => void): void;
	close(): void;
	removeEventListener(type: string, listener: (event: Event) => void): void;
};

// A synchronous EventSource stub: records listeners so the test can drive `open` and dispatch
// live frames deterministically, without a real network stream.
class MockEventSource {
	static instances: MockEventSource[] = [];
	readonly url: string;
	closed = false;
	private readonly listeners = new Map<string, Listener[]>();

	constructor(url: string) {
		this.url = url;
		MockEventSource.instances.push(this);
	}

	addEventListener(type: string, listener: Listener) {
		const arr = this.listeners.get(type) ?? [];
		arr.push(listener);
		this.listeners.set(type, arr);
	}

	removeEventListener(type: string, listener: Listener) {
		const arr = this.listeners.get(type);
		if (arr) {
			this.listeners.set(
				type,
				arr.filter((entry) => entry !== listener),
			);
		}
	}

	emit(type: string, event: unknown) {
		for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
	}

	close() {
		this.closed = true;
	}
}

// Drain the microtask + timer queue so the `open.then(flush)` batch flush and its awaited
// fetch/json settle before we assert.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeFetchMock() {
	const calls: Array<{url: string; body: ControlBody}> = [];
	const fetchMock = vi.fn(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const raw = typeof init?.body === "string" ? init.body : "{}";
			const body: ControlBody = JSON.parse(raw);
			calls.push({body, url: String(input)});
			const results = body.operations.map((op) => ({data: null, id: op.id, ok: true}));
			return new Response(JSON.stringify({results, version: 1}), {
				headers: {"content-type": "application/json"},
				status: 200,
			});
		},
	);
	return {calls, fetchMock};
}

function makeTransport(fetchMock: ReturnType<typeof makeFetchMock>["fetchMock"]) {
	MockEventSource.instances = [];
	const transport = createHTTPTransport({
		eventSource: MockEventSource as EventSourceCtor,
		fetch: fetchMock,
		live: true,
		liveUrl: "/fate/live",
		url: "/fate",
	});
	const subscribeById = transport.subscribeById;
	if (!subscribeById) throw new Error("expected a live-capable transport with subscribeById");
	return {subscribeById, transport};
}

describe("react-fate live transport — same-tick subscribe batching (#2273)", () => {
	it("coalesces same-tick subscribeById calls into ONE /fate/live control POST", async () => {
		const {calls, fetchMock} = makeFetchMock();
		const {subscribeById} = makeTransport(fetchMock);
		const handlers = {a: {onData: vi.fn()}, b: {onData: vi.fn()}, c: {onData: vi.fn()}};

		// Three mounts subscribe in the same synchronous tick, as a feed of PanoPostCards does.
		subscribeById("Post", "a", ["id", "body"], undefined, handlers.a);
		subscribeById("Post", "b", ["id", "body"], undefined, handlers.b);
		subscribeById("Post", "c", ["id", "body"], undefined, handlers.c);

		// Exactly one SSE stream, and no control POST until the stream opens.
		expect(MockEventSource.instances).toHaveLength(1);
		expect(fetchMock).not.toHaveBeenCalled();

		const source = MockEventSource.instances.at(-1);
		expect(source).toBeDefined();
		source?.emit("open", {});
		await settle();

		// The batching guarantee: one POST for all three subscribes, not three.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const call = calls.at(0);
		expect(call?.url).toBe("/fate/live");
		expect(call?.body.operations).toHaveLength(3);
		expect(call?.body.operations.every((op) => op.kind === "subscribe")).toBe(true);
		expect([...(call?.body.operations ?? [])].map((op) => op.entityId).sort()).toEqual([
			"a",
			"b",
			"c",
		]);

		// No subscription is lost: a live frame per entity still routes to its handler.
		source?.emit("next", {
			data: JSON.stringify({
				event: {data: {__typename: "Post", body: "updated-a", id: "a"}, select: ["body"]},
				id: "1",
				kind: "next",
			}),
			lastEventId: "e1",
		});
		source?.emit("next", {
			data: JSON.stringify({
				event: {data: {__typename: "Post", body: "updated-c", id: "c"}, select: ["body"]},
				id: "3",
				kind: "next",
			}),
			lastEventId: "e2",
		});

		expect(handlers.a.onData).toHaveBeenCalledWith(
			{__typename: "Post", body: "updated-a", id: "a"},
			["body"],
		);
		expect(handlers.c.onData).toHaveBeenCalledWith(
			{__typename: "Post", body: "updated-c", id: "c"},
			["body"],
		);
		expect(handlers.b.onData).not.toHaveBeenCalled();
	});

	it("batches a mixed subscribeById + subscribeConnection tick into one POST", async () => {
		const {calls, fetchMock} = makeFetchMock();
		const {transport, subscribeById} = makeTransport(fetchMock);
		const subscribeConnection = transport.subscribeConnection;
		if (!subscribeConnection) throw new Error("expected subscribeConnection on a live transport");

		subscribeById("Post", "a", ["id", "body"], undefined, {onData: vi.fn()});
		subscribeConnection("posts", "Post", undefined, ["id"], undefined, {onEvent: vi.fn()});

		const source = MockEventSource.instances.at(-1);
		source?.emit("open", {});
		await settle();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const kinds = [...(calls.at(0)?.body.operations ?? [])].map((op) => op.kind).sort();
		expect(kinds).toEqual(["subscribe", "subscribeConnection"]);
	});
});
