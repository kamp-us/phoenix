/**
 * Proves the #711 invariant at the transport seam: while a second always-on
 * operation is held (the app-lifetime global live pin — `useGlobalLivePin`), the
 * shared native SSE `EventSource` is NEVER closed when the only churning view
 * unsubscribes+resubscribes during a write-mutation refetch. With the pin held
 * `operations.size` can't reach 0, so fate's `if (operations.size === 0) {
 * source.close() }` teardown branch can't fire and the `connectionId` stays
 * stable. The first case is the falsification baseline: WITHOUT the pin, the same
 * churn tears the EventSource down (the lost-publish bug). See ADR 0094.
 *
 * Transport-level, no React: the native live client (`createHTTPTransport({live:
 * true})` with no `liveConnector`) is exactly what phoenix grafts onto its client
 * (`client.ts`), and the refcount lives there.
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

// The native client POSTs subscribe/unsubscribe control messages; answer them OK.
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

// The churning list view: a connection subscription that unsubscribes during a
// write mutation's refetch. `subscribeConnection` is optional on `Transport`.
const subscribeView = (transport: LiveTransport): (() => void) => {
	if (!transport.subscribeConnection) throw new Error("no subscribeConnection");
	return transport.subscribeConnection("posts", "Post", undefined, ["id"], undefined, {
		onEvent() {},
	});
};

// The app-lifetime pin: one always-on entity subscription on the viewer's User.
const subscribePin = (transport: LiveTransport): (() => void) => {
	if (!transport.subscribeById) throw new Error("no subscribeById");
	return transport.subscribeById("User", "u1", ["id"], undefined, {onData() {}});
};

describe("global live pin keeps the SSE stream alive across mutation churn (#711)", () => {
	it("WITHOUT the pin: the lone view's unsubscribe tears the EventSource down (falsification baseline)", () => {
		const transport = makeTransport();
		const unsubscribeView = subscribeView(transport);
		const source = onlySource();

		// The transient unsubscribe a write mutation's refetch causes.
		unsubscribeView();

		// refcount hit 0 → fate closed the shared stream and dropped its connectionId.
		expect(source.closed).toBe(true);
	});

	it("WITH the pin: the same churn never closes the EventSource — refcount stays >= 1", () => {
		const transport = makeTransport();
		// The app-lifetime pin: one always-on operation for the session.
		const releasePin = subscribePin(transport);
		const unsubscribeView = subscribeView(transport);
		const source = onlySource();

		// The churning view unsubscribes (mutation refetch) and resubscribes.
		unsubscribeView();
		expect(source.closed).toBe(false);
		const unsubscribeView2 = subscribeView(transport);

		// No new EventSource was built — the connectionId is stable across the churn.
		expect(onlySource()).toBe(source);
		expect(source.closed).toBe(false);

		// Teardown: only when BOTH the view and the pin release does the stream close.
		unsubscribeView2();
		expect(source.closed).toBe(false);
		releasePin();
		expect(source.closed).toBe(true);
	});
});
