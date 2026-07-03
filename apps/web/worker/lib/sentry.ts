/**
 * Worker-side Sentry options (ADR 0118). The worker copy of the SPA's
 * `src/lib/sentry.ts` — same options shape, but built on `@sentry/cloudflare`
 * (workerd/`nodejs_compat`) rather than `@sentry/react`.
 *
 * This module holds NO init: the client is created at the request seam in
 * `index.ts` via `@sentry/cloudflare`'s `wrapRequestHandler`, which is the only
 * workerd-safe init path for an Effect-`HttpRouter` worker (there is no
 * `ExportedHandler` in phoenix's source to wrap — ADR 0118 impl, issue #1502).
 * So "inert when no DSN" is structural: `index.ts` returns the base fetch effect
 * untouched, and nothing here ever runs.
 */
import type {CloudflareOptions} from "@sentry/cloudflare";

/**
 * Whether a usable DSN is present — the single gate the request seam checks, so
 * the worker integration is provably inert when unset (no client, no capture, no
 * network). Mirrors the SPA's `sentryEnabled`.
 */
export function sentryEnabled(dsn: string | undefined): dsn is string {
	return typeof dsn === "string" && dsn.trim().length > 0;
}

/**
 * The decided client options (ADR 0118): pure native `dataCollection` (SDK ≥10.57,
 * the granular successor to the removed `sendDefaultPii`), no `beforeSend`. It
 * suppresses the cookies/headers/user/`query_string` PII. Query strings carry no
 * GDPR-PII in this app (only short-lived auth/OAuth tokens, caught by Sentry's
 * server-side default data-scrubbing by field name), so no client-side URL scrub is
 * needed — server-side Advanced Data Scrubbing is the backstop.
 */
export function workerOptions(dsn: string): CloudflareOptions {
	return {
		dsn,
		dataCollection: {
			userInfo: false,
			cookies: false,
			httpHeaders: {request: false, response: false},
			queryParams: false,
		},
	};
}
