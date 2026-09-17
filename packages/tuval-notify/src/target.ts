/**
 * Where a message goes, and the one function that puts it there.
 *
 * **The target is a union, not a bag of optional fields.** `url` belongs to a webhook and `topic`
 * belongs to ntfy, and a record carrying both — or neither — is not a thing this package can be
 * handed: `NotifyTarget` is discriminated on `kind`, so the checker refuses the half-filled shape
 * before a desk ever boots. The three members are the three ways a message leaves a laptop that are
 * worth writing down: an incoming webhook (Slack, Discord, anything that takes JSON on a URL),
 * [ntfy](https://ntfy.sh) (the shortest path to a phone), and stdout (a test, or a dev loop).
 *
 * **Nothing here is ever written down.** A webhook URL *is* the credential — anyone holding it can
 * post as you — and so is an `Authorization` header. Both live in the closure this module's
 * `attemptDelivery` is called from — `./deliver.ts`'s live `Transport` layer, and nothing else — and
 * neither ever reaches `./state.ts`, which is the record Tuval checkpoints to disk and hands to a
 * window, nor `./deliver.ts`'s `Deliver`, which is a record the loop dispatches. `notify.ts`'s
 * header says the same thing from the other side; this comment is here so the rule is visible at
 * the place a URL is actually held.
 *
 * **`fetch` comes in as an argument.** Not because the global is wrong — it is what a desk uses —
 * but because a test that asserts "this is the URL, this is the method, this is the body" must be
 * able to do so without a network, and a package that reads `globalThis.fetch` at call time cannot
 * be tested that way without monkey-patching the global out from under the whole suite.
 */

/** The `fetch` this package calls. The global's own type, so a desk hands over the global itself. */
export type Fetch = (
	input: string,
	init: {
		readonly method: string;
		readonly headers: Readonly<Record<string, string>>;
		readonly body: string;
		/**
		 * When to give up. Always set — see `TIMEOUT` — because a receiver that accepts the connection
		 * and then says nothing would otherwise hold the request open for as long as the runtime is
		 * willing to wait, and the actor awaits this program's handler inline
		 * (kamp-us/phoenix [#9297](https://github.com/kamp-us/phoenix/issues/9297)).
		 */
		readonly signal: AbortSignal;
	},
) => Promise<{readonly ok: boolean; readonly status: number}>;

/** Where a line of text is written when the target is `stdout`. `console.log` on a real desk. */
export type Write = (line: string) => void;

/**
 * An incoming webhook: a URL that takes JSON and posts as you.
 *
 * The default body is `{content: text}`, which is what a **Discord** incoming webhook reads. A
 * **Slack** one reads `{text}` instead, so a Slack target says so:
 * `body: (text) => ({text})`. Anything else — a Teams card, a Mattermost payload — is the same
 * one-line function, which is why this is a callback and not an enum of vendors.
 */
export interface WebhookTarget {
	readonly kind: "webhook";
	/** The full URL. This is the credential; it is never checkpointed and never logged. */
	readonly url: string;
	/** Defaults to `POST`, which is what every incoming webhook takes. */
	readonly method?: "POST" | "PUT" | "PATCH";
	/** Merged over `content-type: application/json`. Also a credential, also never written down. */
	readonly headers?: Readonly<Record<string, string>>;
	/** What to send. Defaults to Discord's `{content: text}`; Slack is `(text) => ({text})`. */
	readonly body?: (text: string) => unknown;
	/** How long one attempt waits before it is given up on, in ms. Defaults to `TIMEOUT`. */
	readonly timeoutMs?: number;
}

/**
 * [ntfy](https://ntfy.sh): POST the text to `<server>/<topic>` and it arrives on the phone
 * subscribed to that topic. No account, no key, no SDK — which is why it is the easiest "reach me"
 * path there is, and also why a topic name is a secret in the only sense that matters: anyone who
 * knows it can both read and write it. Pick an unguessable one.
 */
export interface NtfyTarget {
	readonly kind: "ntfy";
	readonly topic: string;
	/** Defaults to `https://ntfy.sh`. A self-hosted server is the same protocol. */
	readonly server?: string;
	/** The notification's title, when a message does not carry one of its own. */
	readonly title?: string;
	/** ntfy's 1 (min) — 5 (max). Omitted means the server's default, which is 3. */
	readonly priority?: 1 | 2 | 3 | 4 | 5;
	/** How long one attempt waits before it is given up on, in ms. Defaults to `TIMEOUT`. */
	readonly timeoutMs?: number;
}

/** A line on stdout. For a test, a dev loop, and for seeing what a config would have sent. */
export interface StdoutTarget {
	readonly kind: "stdout";
}

export type NotifyTarget = WebhookTarget | NtfyTarget | StdoutTarget;

export type TargetKind = NotifyTarget["kind"];

/** One message on its way out: the text, an optional title, and the key its delivery is named by. */
export interface Outgoing {
	readonly key: string;
	readonly text: string;
	readonly title?: string;
}

/** What one attempt came back with. `status` is absent when the request never got an answer. */
export interface Attempt {
	readonly ok: boolean;
	readonly status?: number;
}

const DISCORD_BODY = (text: string): unknown => ({content: text});

/**
 * How long one attempt waits before it is given up on, in milliseconds. Every request carries one;
 * a target may state its own with `timeoutMs`.
 *
 * **`fetch` has no timeout of its own.** A receiver that accepts the connection and then says
 * nothing holds the request open for as long as the runtime is willing to wait, which is minutes.
 * That is expensive here twice over: the message is stale long before then, the next one is waiting
 * behind it in the outbox, and — until kamp-us/phoenix
 * [#9297](https://github.com/kamp-us/phoenix/issues/9297) is ruled on — the actor awaits this
 * program's handler inline, so a hung webhook holds the whole inbox with it.
 *
 * Ten seconds, because a notification is worth ten seconds and not a minute. A timeout comes back
 * as `ok: false` with no status, which is already what "it never got an answer" means here — so
 * nothing downstream had to learn a new outcome, and the message is refused loudly rather than lost.
 */
export const TIMEOUT = 10_000;

const NTFY_DEFAULT_SERVER = "https://ntfy.sh";

/** `https://ntfy.sh/my-topic`, with a trailing slash on the server tolerated. */
export const ntfyUrl = (target: NtfyTarget): string =>
	`${(target.server ?? NTFY_DEFAULT_SERVER).replace(/\/+$/, "")}/${target.topic}`;

/**
 * ntfy carries a title and a priority as **headers**, not in the body — the body is the message
 * itself, in plain text. A header value has to be a single line of Latin-1 or the request is
 * refused by the runtime before it leaves, so the title is flattened and trimmed here rather than
 * left to fail at the socket. The message's own title wins over the target's default.
 */
const ntfyHeaders = (target: NtfyTarget, out: Outgoing): Readonly<Record<string, string>> => {
	const title = out.title ?? target.title;
	return {
		"content-type": "text/plain; charset=utf-8",
		...(title === undefined ? {} : {Title: title.replace(/[\r\n]+/g, " ").trim()}),
		...(target.priority === undefined ? {} : {Priority: String(target.priority)}),
	};
};

/**
 * Deliver one message, once, and answer what happened. Never throws: a refused DNS lookup, a
 * dropped socket and a 500 are all the same thing to a notifier — the message did not land — and
 * the difference between them is a `status` that is there or is not.
 *
 * A non-2xx is **not** an error here either. `ok: false, status: 500` is a fact about a delivery,
 * recorded and announced like any other, because a notifier that threw on the receiver's bad day
 * would take the desk down with it.
 *
 * **It always gives up eventually.** Every request carries `AbortSignal.timeout` — `TIMEOUT`, or
 * the target's own `timeoutMs` — because `fetch` waits for minutes on a receiver that accepts the
 * connection and then says nothing, and a hung notification is worth nothing to anybody. An abort
 * lands in the same `catch` as a refused socket and reads the same way: `ok: false`, no status.
 */
export const attemptDelivery = async (
	target: NotifyTarget,
	out: Outgoing,
	io: {readonly fetch: Fetch; readonly write: Write},
): Promise<Attempt> => {
	if (target.kind === "stdout") {
		io.write(out.title === undefined ? out.text : `${out.title}: ${out.text}`);
		return {ok: true};
	}
	const request =
		target.kind === "ntfy"
			? {
					url: ntfyUrl(target),
					method: "POST",
					headers: ntfyHeaders(target, out),
					body: out.text,
				}
			: {
					url: target.url,
					method: target.method ?? "POST",
					headers: {
						"content-type": "application/json",
						...(target.headers ?? {}),
					},
					body: JSON.stringify((target.body ?? DISCORD_BODY)(out.text)),
				};
	try {
		const response = await io.fetch(request.url, {
			method: request.method,
			headers: request.headers,
			body: request.body,
			signal: AbortSignal.timeout(target.timeoutMs ?? TIMEOUT),
		});
		return {ok: response.ok, status: response.status};
	} catch {
		// Deliberately swallowed and deliberately un-detailed: the cause carries the URL (fetch puts it
		// in the message) and the URL is the credential. What the desk gets is `ok: false` with no
		// status, which is the honest and secret-free reading of "it never got an answer" — and an
		// abort is exactly that, so a request given up on needs no outcome of its own.
		return {ok: false};
	}
};
