/**
 * `attemptDelivery`, against a `fetch` that is a spy and never a socket.
 *
 * Every case here asserts the *request* — the URL, the method, the headers, the body — because that
 * is the whole of what this module decides. The three targets are three request shapes and one
 * failure story, and a test that only checked `ok` would pass against a delivery to the wrong URL.
 */

import {describe, expect, it} from "vitest";
import {attemptDelivery, type Fetch, type Outgoing} from "./target.ts";

interface Call {
	readonly url: string;
	readonly method: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
}

/**
 * A `fetch` that records what it was asked and answers whatever the case wants. The `signal` is
 * recorded apart from the request, because every request carries one and a case about the body has
 * nothing to say about it — the two cases that *are* about it read `signals`.
 */
const spy = (answer: {ok: boolean; status: number} | Error) => {
	const calls: Call[] = [];
	const signals: AbortSignal[] = [];
	const fetch: Fetch = (url, init) => {
		calls.push({
			url,
			method: init.method,
			headers: init.headers,
			body: init.body,
		});
		signals.push(init.signal);
		return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
	};
	return {calls, signals, fetch};
};

/**
 * A `fetch` that never answers on its own and only ever settles because the signal aborted — a
 * receiver that takes the connection and then says nothing, which is the case `AbortSignal.timeout`
 * exists for. `fetch` itself has no timeout, so without the signal this promise is forever.
 */
const hangs: Fetch = (_url, init) =>
	new Promise((_resolve, reject) => {
		init.signal.addEventListener("abort", () => {
			reject(init.signal.reason);
		});
	});

const OK = {ok: true, status: 204} as const;

const lines: string[] = [];
const write = (line: string): void => {
	lines.push(line);
};

/** A `fetch` that fails the test by being called at all — what a stdout target is handed. */
const noFetch: Fetch = () => {
	throw new Error("stdout must not reach the network");
};

const message = (text: string, title?: string): Outgoing =>
	title === undefined ? {key: "k", text} : {key: "k", text, title};

const io = (fetch: Fetch) => ({fetch, write});

describe("a webhook target", () => {
	it("POSTs Discord's `{content}` as JSON by default", async () => {
		const {calls, fetch} = spy(OK);
		const attempt = await attemptDelivery(
			{kind: "webhook", url: "https://example.test/hook"},
			message("five lines"),
			io(fetch),
		);
		expect(attempt).toEqual({ok: true, status: 204});
		expect(calls).toEqual([
			{
				url: "https://example.test/hook",
				method: "POST",
				headers: {"content-type": "application/json"},
				body: JSON.stringify({content: "five lines"}),
			},
		]);
	});

	it("takes Slack's `{text}` as a one-line `body`, which is why it is a callback", async () => {
		const {calls, fetch} = spy(OK);
		await attemptDelivery(
			{
				kind: "webhook",
				url: "https://hooks.slack.test/services/T/B/X",
				body: (text) => ({text}),
			},
			message("five lines"),
			io(fetch),
		);
		expect(calls[0]?.body).toBe(JSON.stringify({text: "five lines"}));
	});

	it("merges the author's headers over the content type, and takes a stated method", async () => {
		const {calls, fetch} = spy(OK);
		await attemptDelivery(
			{
				kind: "webhook",
				url: "https://example.test/hook",
				method: "PUT",
				headers: {Authorization: "Bearer t", "content-type": "text/plain"},
			},
			message("hi"),
			io(fetch),
		);
		expect(calls[0]?.method).toBe("PUT");
		expect(calls[0]?.headers).toEqual({
			"content-type": "text/plain",
			Authorization: "Bearer t",
		});
	});
});

describe("an ntfy target", () => {
	it("POSTs the text itself to `<server>/<topic>`, with ntfy.sh as the default server", async () => {
		const {calls, fetch} = spy(OK);
		await attemptDelivery({kind: "ntfy", topic: "can-tuval"}, message("five lines"), io(fetch));
		expect(calls).toEqual([
			{
				url: "https://ntfy.sh/can-tuval",
				method: "POST",
				headers: {"content-type": "text/plain; charset=utf-8"},
				// The body is the message, not JSON around it. That is ntfy's whole protocol.
				body: "five lines",
			},
		]);
	});

	it("takes a self-hosted server, trailing slash and all", async () => {
		const {calls, fetch} = spy(OK);
		await attemptDelivery(
			{kind: "ntfy", topic: "t", server: "https://ntfy.home.test/"},
			message("hi"),
			io(fetch),
		);
		expect(calls[0]?.url).toBe("https://ntfy.home.test/t");
	});

	it("carries the title and priority as headers, flattened to one line", async () => {
		const {calls, fetch} = spy(OK);
		await attemptDelivery(
			{kind: "ntfy", topic: "t", title: "Desk", priority: 5},
			message("hi"),
			io(fetch),
		);
		expect(calls[0]?.headers).toEqual({
			"content-type": "text/plain; charset=utf-8",
			Title: "Desk",
			Priority: "5",
		});
	});

	it("lets the message's own title win over the target's default", async () => {
		const {calls, fetch} = spy(OK);
		await attemptDelivery(
			{kind: "ntfy", topic: "t", title: "Desk"},
			message("hi", "Morning brief\nsecond line"),
			io(fetch),
		);
		// A header value has to be one line or the request is refused before it leaves.
		expect(calls[0]?.headers.Title).toBe("Morning brief second line");
	});
});

describe("a stdout target", () => {
	it("writes the line and reaches no network at all", async () => {
		lines.length = 0;
		const attempt = await attemptDelivery({kind: "stdout"}, message("five lines"), io(noFetch));
		expect(attempt).toEqual({ok: true});
		expect(lines).toEqual(["five lines"]);
	});

	it("puts a title in front of the text, because stdout has no header to carry one", async () => {
		lines.length = 0;
		await attemptDelivery({kind: "stdout"}, message("five lines", "Morning brief"), io(noFetch));
		expect(lines).toEqual(["Morning brief: five lines"]);
	});
});

describe("a delivery that does not land", () => {
	it("records the receiver's bad day as a fact rather than throwing", async () => {
		const {fetch} = spy({ok: false, status: 500});
		await expect(
			attemptDelivery({kind: "webhook", url: "https://example.test/h"}, message("x"), io(fetch)),
		).resolves.toEqual({ok: false, status: 500});
	});

	it("answers `ok: false` with no status when the request never got an answer", async () => {
		// And it says nothing else: the cause carries the URL, and the URL is the credential.
		const {fetch} = spy(new Error("getaddrinfo ENOTFOUND https://secret.test/hook"));
		const attempt = await attemptDelivery(
			{kind: "webhook", url: "https://secret.test/hook"},
			message("x"),
			io(fetch),
		);
		expect(attempt).toEqual({ok: false});
		expect(JSON.stringify(attempt)).not.toContain("secret.test");
	});
});

/**
 * **Every request gives up eventually.** `fetch` has no timeout of its own, so a receiver that
 * accepts the connection and then says nothing holds the request for minutes — and until
 * kamp-us/phoenix [#9297](https://github.com/kamp-us/phoenix/issues/9297) is ruled on, the actor
 * awaits this program's handler inline, so that request holds the whole inbox with it.
 */
describe("a delivery that is never answered at all", () => {
	it("gives up and reads as a failure with no status", async () => {
		const attempt = await attemptDelivery(
			{kind: "ntfy", topic: "t", timeoutMs: 5},
			message("x"),
			io(hangs),
		);
		// The same `ok: false` a refused socket answers, deliberately: to a notifier "it timed out" and
		// "it never connected" are one fact — the message did not land — and neither carries a status.
		expect(attempt).toEqual({ok: false});
	});

	it("carries a signal on every request, and states the target's own wait", async () => {
		const {signals, fetch} = spy(OK);
		await attemptDelivery(
			{kind: "webhook", url: "https://example.test/h"},
			message("x"),
			io(fetch),
		);
		expect(signals[0]).toBeInstanceOf(AbortSignal);
		expect(signals[0]?.aborted).toBe(false);

		// A target that states its own wait gets it — and a wait that short aborts before the answer.
		const slow = await attemptDelivery(
			{kind: "webhook", url: "https://example.test/h", timeoutMs: 1},
			message("x"),
			io(hangs),
		);
		expect(slow).toEqual({ok: false});
	});

	it("leaves a stdout target alone, which reaches no socket to give up on", async () => {
		await expect(
			attemptDelivery({kind: "stdout"}, message("no network"), io(noFetch)),
		).resolves.toEqual({ok: true});
	});
});
