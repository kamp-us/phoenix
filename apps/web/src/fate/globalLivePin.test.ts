/**
 * Proves the #711 invariant at the transport seam (ADR 0094): with the pin held,
 * `operations.size` can't reach 0, so fate's `source.close()` teardown branch can't
 * fire on mutation churn. The first case is the falsification baseline.
 *
 * Transport-level, no React: the refcount lives in the native live client, which is
 * exactly what phoenix grafts onto its client (`client.ts`).
 */
import {createHTTPTransport} from "react-fate";
import {describe, expect, it} from "vitest";

type EventListener = (event: Event) => void;

// Matches fate's `EventSourceConstructor` structural shape; records close() and
// lets the test resolve the native client's `open` promise by emitting "open".
class FakeEventSource {
	static instances: FakeEventSource[] = [];
	closed = false;
	readonly url: string;
	readonly #listeners = new Map<string, Set<EventListener>>();

	constructor(url: string) {
		this.url = url;
		FakeEventSource.instances.push(this);
	}

	addEventListener(type: string, listener: EventListener): void {
		const set = this.#listeners.get(type) ?? new Set<EventListener>();
		set.add(listener);
		this.#listeners.set(type, set);
	}

	removeEventListener(type: string, listener: EventListener): void {
		this.#listeners.get(type)?.delete(listener);
	}

	close(): void {
		this.closed = true;
	}
}

const okFetch: typeof fetch = async () =>
	new Response(JSON.stringify({results: [], version: 1}), {
		headers: {"content-type": "application/json"},
		status: 200,
	});

const makeTransport = () => {
	FakeEventSource.instances = [];
	return createHTTPTransport({
		url: "/fate",
		liveUrl: "/fate/live",
		live: true,
		fetch: okFetch,
		eventSource: FakeEventSource,
	});
};

type LiveTransport = ReturnType<typeof makeTransport>;

const onlySource = (): FakeEventSource => {
	expect(FakeEventSource.instances).toHaveLength(1);
	const source = FakeEventSource.instances[0];
	if (!source) throw new Error("no EventSource was constructed");
	return source;
};

const subscribeView = (transport: LiveTransport): (() => void) => {
	if (!transport.subscribeConnection) throw new Error("no subscribeConnection");
	return transport.subscribeConnection("posts", "Post", undefined, ["id"], undefined, {
		onEvent() {},
	});
};

const subscribePin = (transport: LiveTransport): (() => void) => {
	if (!transport.subscribeById) throw new Error("no subscribeById");
	return transport.subscribeById("User", "u1", ["id"], undefined, {onData() {}});
};

describe("global live pin keeps the SSE stream alive across mutation churn (#711)", () => {
	it("WITHOUT the pin: the lone view's unsubscribe tears the EventSource down (falsification baseline)", () => {
		const transport = makeTransport();
		const unsubscribeView = subscribeView(transport);
		const source = onlySource();

		unsubscribeView();

		expect(source.closed).toBe(true);
	});

	it("WITH the pin: the same churn never closes the EventSource — refcount stays >= 1", () => {
		const transport = makeTransport();
		const releasePin = subscribePin(transport);
		const unsubscribeView = subscribeView(transport);
		const source = onlySource();

		unsubscribeView();
		expect(source.closed).toBe(false);
		const unsubscribeView2 = subscribeView(transport);

		expect(onlySource()).toBe(source);
		expect(source.closed).toBe(false);

		unsubscribeView2();
		expect(source.closed).toBe(false);
		releasePin();
		expect(source.closed).toBe(true);
	});
});
