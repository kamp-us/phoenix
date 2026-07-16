/**
 * Behavior-pin for the `@nkzw/fate` pnpm patch (ADR 0038). The patch makes
 * `createHTTPTransport`'s native live client coalesce same-tick `add` (subscribe)
 * operations into ONE `/fate/live` control POST: upstream 1.3.1 fired its own
 * `control([op])` per `add` after the SSE `open`, so a feed load with N `useLiveView`
 * mounts issued N single-op POSTs, each re-validating the session (phoenix #2273). The
 * patch buffers adds and flushes them once per tick across the `open` microtask
 * boundary, and — on a rejected flush — discards the whole batch as a group and reports
 * the error. This file pins BOTH: N same-tick subscribes ⇒ exactly one control POST, and
 * a rejected coalesced flush drops every batched op (not one) and reports the error. Reds
 * if the patch is dropped: unpatched, each `add` POSTs on its own, so N subscribes issue N
 * POSTs and the count assertions fail.
 */
// @patch-pin: @nkzw/fate@1.3.1

import {createHTTPTransport} from "react-fate";
import {describe, expect, it, vi} from "vitest";

type ControlOperation = {id: string; kind: string; entityId?: string};
type ControlBody = {operations: ReadonlyArray<ControlOperation>};
type Listener = (event: unknown) => void;

// The `fetch` option createHTTPTransport calls for control POSTs — the same narrow shape the
// sibling batching test passes; assignable to the transport option without a cast.
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

// createHTTPTransport's EventSourceConstructor type is not exported; asserted once at the
// call site.
type EventSourceCtor = new (
	url: string,
	options?: {withCredentials?: boolean},
) => {
	addEventListener(type: string, listener: (event: Event) => void): void;
	close(): void;
	removeEventListener(type: string, listener: (event: Event) => void): void;
};

// Synchronous EventSource stub: records listeners so the test drives `open` deterministically
// without a real network stream.
class MockEventSource {
	static instances: MockEventSource[] = [];
	readonly url: string;
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
		if (arr)
			this.listeners.set(
				type,
				arr.filter((entry) => entry !== listener),
			);
	}

	emit(type: string, event: unknown) {
		for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
	}

	close() {}
}

// Drain the microtask + timer queue so `open.then(flushAdds)` and its awaited fetch settle.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const okResponse = (body: ControlBody): Response =>
	new Response(
		JSON.stringify({
			results: body.operations.map((op) => ({data: null, id: op.id, ok: true})),
			version: 1,
		}),
		{headers: {"content-type": "application/json"}, status: 200},
	);

function makeTransport(fetchMock: FetchLike) {
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
	return {subscribeById};
}

const onlySource = (): MockEventSource => {
	const source = MockEventSource.instances.at(-1);
	if (!source) throw new Error("no EventSource was constructed");
	return source;
};

describe("@nkzw/fate patch pin — same-tick /fate/live subscribe coalescing (#2273)", () => {
	it("coalesces N same-tick subscribes into exactly ONE control POST carrying all N ops", async () => {
		const calls: ControlBody[] = [];
		const fetchMock = vi.fn<FetchLike>(async (_input, init) => {
			const body: ControlBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
			calls.push(body);
			return okResponse(body);
		});
		const {subscribeById} = makeTransport(fetchMock);

		// Five mounts subscribe in one synchronous tick, as a feed of cards does.
		const ids = ["a", "b", "c", "d", "e"];
		for (const id of ids) subscribeById("Post", id, ["id", "body"], undefined, {onData: vi.fn()});

		// No control POST until the stream opens.
		expect(fetchMock).not.toHaveBeenCalled();

		onlySource().emit("open", {});
		await settle();

		// The pin: ONE POST for all five subscribes, not five.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const posted = calls.at(0);
		expect(posted?.operations).toHaveLength(ids.length);
		expect(posted?.operations.every((op) => op.kind === "subscribe")).toBe(true);
		expect([...(posted?.operations ?? [])].map((op) => op.entityId).sort()).toEqual(
			[...ids].sort(),
		);
	});

	it("a rejected coalesced flush discards the WHOLE batch and reports the error", async () => {
		let rejectControl = false;
		const calls: ControlBody[] = [];
		const fetchMock = vi.fn<FetchLike>(async (_input, init) => {
			const body: ControlBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
			calls.push(body);
			if (rejectControl) throw new Error("boom: control flush rejected");
			return okResponse(body);
		});
		const {subscribeById} = makeTransport(fetchMock);

		// Tick 1: a survivor subscribes; its flush succeeds and it stays in `operations`.
		const survivor = {onData: vi.fn(), onError: vi.fn()};
		subscribeById("Post", "survivor", ["id"], undefined, survivor);
		onlySource().emit("open", {});
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Tick 2: two ops subscribe together while the control flush now rejects.
		rejectControl = true;
		const failedA = {onData: vi.fn(), onError: vi.fn()};
		const failedB = {onData: vi.fn(), onError: vi.fn()};
		subscribeById("Post", "failed-a", ["id"], undefined, failedA);
		subscribeById("Post", "failed-b", ["id"], undefined, failedB);
		await settle();

		// Coalesced even on the failing path: one POST for both ops, not two.
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(calls.at(1)?.operations).toHaveLength(2);

		// The error was reported to live subscriptions (reportError → onError).
		expect(survivor.onError).toHaveBeenCalledWith(expect.any(Error));

		// The whole batch was discarded from `operations`: a reconnect resubscribe carries
		// only the survivor, never the two failed ops.
		rejectControl = false;
		onlySource().emit("open", {});
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect([...(calls.at(2)?.operations ?? [])].map((op) => op.entityId)).toEqual(["survivor"]);
	});
});
