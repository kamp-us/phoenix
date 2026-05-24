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
 * `Authorization` header. The live SSE transport (tasks 11/12) opens its
 * `EventSource` with `withCredentials`, so the same cookie authenticates the
 * stream; `liveUrl` is wired now for that, though live views aren't published
 * yet (the generated transport has `live: false` until a server `live.*` lands).
 *
 * See `.patterns/fate-client-setup.md`.
 */
import {createFateClient} from "react-fate/client";

export const createClient = () =>
	createFateClient({
		url: "/fate",
		liveUrl: "/fate/live",
		// Cookie-session auth: better-auth's session cookie rides every request
		// (same-origin). This is also the posture the live EventSource inherits.
		fetch: (input, init) => fetch(input, {...init, credentials: "include"}),
		// Live errors are out-of-band (the live stream is best-effort); surface
		// them to the console so dev tools / future telemetry can pick them up.
		onLiveError: (error) => console.error("[fate] live", error),
	});

export type FateClientInstance = ReturnType<typeof createClient>;
