/**
 * The fate client.
 *
 * `createFateClient` comes from `react-fate/client` — the module the fate Vite
 * plugin generates at build time from the server's `Entity<>` types and
 * `fateServer` manifest (see `vite.config.ts`; the generated source lives in
 * `.fate/`, gitignored). It configures one normalized cache and the HTTP
 * transport pointed at the worker's `/fate` route.
 *
 * Auth is the better-auth **session cookie**. The SPA and the API are the same
 * origin (one Worker), so `credentials: "include"` on the fetch transport sends
 * the cookie with every `/fate` request — no token in the URL, no
 * `Authorization` header. The live SSE transport opens its `EventSource` with
 * `withCredentials`, so the same cookie authenticates the stream.
 *
 * ## Enabling live (the `roots: {}` constraint)
 *
 * `useLiveView`/`useLiveListView` require the client's transport to expose
 * `subscribeById`/`subscribeConnection`. fate's native HTTP transport only
 * builds those when constructed with `live: true` (it then opens an
 * `EventSource` against `liveUrl` with `withCredentials` and POSTs fate's native
 * `subscribe`/`subscribeConnection`/`unsubscribe` control protocol — exactly what
 * phoenix's `/fate/live` route + `ConnectionDO`/`TopicDO` serve).
 *
 * The fate Vite plugin only emits `live: true` in the generated client when the
 * server's `fateServer.manifest.live` is non-empty — and that manifest is
 * populated by *walking `roots`* (fate registers a source type only when it's
 * reached from a root). phoenix deliberately keeps `roots: {}` (every read is a
 * custom `queries`/`lists` resolver, which keeps the `fateServer` export type
 * nameable — TS2883, see `worker/features/fate/server.ts`), so `manifest.live` is empty
 * and the generated transport is built with `live: false`.
 *
 * Rather than add roots purely to flip a codegen flag (and re-break the export
 * type), phoenix enables live the same way fate's own tRPC client template does:
 * build a separate `live: true` HTTP transport and graft its
 * `subscribeById`/`subscribeConnection` onto the client's transport. The native
 * live client is lazy (the `EventSource` opens on the first subscription), so
 * grafting these methods costs nothing until a `useLiveView` mounts.
 *
 * ## Anonymous viewers — no-op live, not a 401 retry loop
 *
 * `/fate/live` requires a session (the cookie auth gate). An anonymous viewer
 * who lands on a live screen would otherwise open an `EventSource` that 401s and
 * retries forever, flooding `onLiveError`. But `useLiveView`/`useLiveListView`
 * subscribe unconditionally and `assertLive*Support()` *throws* if the transport
 * lacks the live methods — so we can't just drop them. Instead, for an anonymous
 * client we graft **no-op** live methods: the property exists (the assert
 * passes, the tree never throws) but no SSE ever opens. The provider re-keys the
 * client on the user id, so signing in rebuilds it with the real live transport.
 *
 * See `.patterns/fate-client-setup.md`, `.patterns/fate-live-views.md`.
 */
import {createHTTPTransport} from "react-fate";
import {createFateClient} from "react-fate/client";

const LIVE_URL = "/fate/live";

/** Cookie-session fetch: better-auth's session cookie rides every request (same-origin). */
const cookieFetch: typeof fetch = (input, init) => fetch(input, {...init, credentials: "include"});

/**
 * The subset of the fate transport the live hooks need. The client stores its
 * transport as a `private readonly` field, so we reach it through this minimal
 * shape to graft the live methods (matching fate's own runtime pattern of
 * mutating the transport before/after `createClient`).
 */
interface LiveCapableTransport {
	subscribeById?: unknown;
	subscribeConnection?: unknown;
}

/**
 * Reach the fate client's transport so we can graft the live methods onto it.
 *
 * fate's `FateClient` stores its transport as a `private readonly` field (it is
 * deliberately not on the public type), so there is no typed accessor to reach
 * it — this is fate's own runtime pattern of mutating the transport around
 * `createClient`. We read it through `Reflect.get` (which yields `unknown`) and
 * narrow to the minimal {@link LiveCapableTransport} shape we mutate. No
 * `as unknown as` double-cast: `Reflect.get` already hands back `unknown`.
 */
const liveTransportOf = (client: object): LiveCapableTransport =>
	Reflect.get(client, "transport") as LiveCapableTransport;

/** A live-method pair that never opens a stream — for anonymous clients. */
const noopLive = {
	subscribeById: () => () => undefined,
	subscribeConnection: () => () => undefined,
};

/**
 * Build the fate client.
 *
 * @param authenticated whether a better-auth session is present. When false, the
 *   live transport is a no-op (the `assert*Support` gate still passes, but no SSE
 *   opens — `/fate/live` would 401 for an anonymous viewer).
 */
export const createClient = ({authenticated}: {authenticated: boolean}) => {
	const client = createFateClient({
		url: "/fate",
		liveUrl: LIVE_URL,
		// Cookie-session auth: better-auth's session cookie rides every request
		// (same-origin). This is also the posture the live EventSource inherits.
		fetch: cookieFetch,
		// Live errors are out-of-band (the live stream is best-effort); surface
		// them to the console so dev tools / future telemetry can pick them up.
		onLiveError: (error) => console.error("[fate] live", error),
	});

	const transport = liveTransportOf(client);
	if (authenticated) {
		// Graft real live support (see the module comment). A `live: true` HTTP
		// transport builds the native SSE `subscribeById`/`subscribeConnection`
		// against `/fate/live` with `withCredentials`; we copy those onto the
		// client's transport so `useLiveView`/`useLiveListView` find them.
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
