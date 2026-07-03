/**
 * Worker-side Sentry options (ADR 0118). The worker copy of the SPA's
 * `src/lib/sentry.ts` — same PII-scrub + options shape, but built on
 * `@sentry/cloudflare` (workerd/`nodejs_compat`) rather than `@sentry/react`.
 *
 * This module holds NO init: the client is created at the request seam in
 * `index.ts` via `@sentry/cloudflare`'s `wrapRequestHandler`, which is the only
 * workerd-safe init path for an Effect-`HttpRouter` worker (there is no
 * `ExportedHandler` in phoenix's source to wrap — ADR 0118 impl, issue #1502).
 * So "inert when no DSN" is structural: `index.ts` returns the base fetch effect
 * untouched, and nothing here ever runs.
 */
import type {CloudflareOptions, ErrorEvent} from "@sentry/cloudflare";

/**
 * Whether a usable DSN is present — the single gate the request seam checks, so
 * the worker integration is provably inert when unset (no client, no capture, no
 * network). Mirrors the SPA's `sentryEnabled`.
 */
export function sentryEnabled(dsn: string | undefined): dsn is string {
	return typeof dsn === "string" && dsn.trim().length > 0;
}

/**
 * Strip the query string + fragment from a URL, keeping origin + path. Query
 * strings are a PII vector (`?email=…`, reset tokens); a plain string cut avoids
 * the `URL` constructor (which throws on relative URLs) and never throws.
 */
function stripUrlQuery(url: string): string {
	const q = url.indexOf("?");
	const h = url.indexOf("#");
	return url.slice(0, Math.min(q === -1 ? url.length : q, h === -1 ? url.length : h));
}

/**
 * Strip query strings off the full request URL and any URL-bearing breadcrumb
 * (navigation + http crumbs). This is the one PII vector `dataCollection` can't
 * reach: the SDK gates cookies/headers/user/`query_string` via `dataCollection`
 * (see `workerOptions`), but the full request URL is ALWAYS sent regardless
 * (`@sentry/core` requestdata: `url: true`, "No dataCollection equivalent"), so
 * the query string on it must be cut here. Same scrub as the SPA copy. See ADR 0118.
 */
export function scrubUrls(event: ErrorEvent): ErrorEvent {
	if (event.request && typeof event.request.url === "string") {
		event.request = {...event.request, url: stripUrlQuery(event.request.url)};
	}
	for (const crumb of event.breadcrumbs ?? []) {
		const data = crumb.data;
		if (!data) continue;
		for (const key of ["url", "to", "from"] as const) {
			const value = data[key];
			if (typeof value === "string") data[key] = stripUrlQuery(value);
		}
	}
	return event;
}

/**
 * The decided client options (ADR 0118). `dataCollection` (SDK ≥10.57) is the
 * native, granular successor to `sendDefaultPii` (deprecated in 10.54, removed in
 * v11); it suppresses the cookies/headers/user/`query_string` PII we hand-scrubbed
 * before. Only the always-sent request URL escapes it, so `beforeSend` narrows to
 * `scrubUrls`.
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
		beforeSend: (event) => scrubUrls(event),
	};
}
