/**
 * The fate client: one normalized cache + the HTTP transport against `/fate`,
 * authenticated by the better-auth session cookie (`credentials: "include"`).
 *
 * Live SSE needs the transport to expose `subscribeById`/`subscribeConnection`,
 * which fate only builds under `live: true` — but phoenix keeps `roots: {}`
 * (TS2883), so the generated transport is `live: false`. So we graft a separate
 * `live: true` transport's methods on, or **no-op** methods for an anonymous
 * client (whose `EventSource` would 401-loop). See `.patterns/fate-client-setup.md`,
 * `.patterns/fate-live-views.md`.
 */
import {createHTTPTransport} from "react-fate";
import {createFateClient} from "react-fate/client";
import {isTransientLiveError} from "./liveRetry.ts";

const LIVE_URL = "/fate/live";

const cookieFetch: typeof fetch = (input, init) => fetch(input, {...init, credentials: "include"});

interface LiveCapableTransport {
	subscribeById?: unknown;
	subscribeConnection?: unknown;
}

// fate stores its transport as a `private readonly` field (not on the public
// type), so there is no typed accessor — reach it through `Reflect.get`
// (already `unknown`) to graft the live methods on.
const liveTransportOf = (client: object): LiveCapableTransport =>
	Reflect.get(client, "transport") as LiveCapableTransport;

const noopLive = {
	subscribeById: () => () => undefined,
	subscribeConnection: () => () => undefined,
};

export const createClient = ({
	authenticated,
	onTransientLiveError,
}: {
	authenticated: boolean;
	onTransientLiveError?: (error: unknown) => void;
}) => {
	const client = createFateClient({
		url: "/fate",
		liveUrl: LIVE_URL,
		fetch: cookieFetch,
		// A cold-start 503 is a transient back-off signal, not a fatal drop (ADR 0095):
		// route it to the pin's retry. Every other live error is out-of-band.
		onLiveError: (error) =>
			isTransientLiveError(error)
				? onTransientLiveError?.(error)
				: console.error("[fate] live", error),
	});

	const transport = liveTransportOf(client);
	if (authenticated) {
		const liveTransport = createHTTPTransport({
			url: "/fate",
			liveUrl: LIVE_URL,
			live: true,
			fetch: cookieFetch,
		});
		transport.subscribeById = liveTransport.subscribeById;
		transport.subscribeConnection = liveTransport.subscribeConnection;
	} else {
		transport.subscribeById = noopLive.subscribeById;
		transport.subscribeConnection = noopLive.subscribeConnection;
	}

	return client;
};

export type FateClientInstance = ReturnType<typeof createClient>;
