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

/** Drop query strings from URL-bearing breadcrumb data (navigation + http crumbs). */
function scrubBreadcrumbUrls(breadcrumbs: ErrorEvent["breadcrumbs"]): void {
	if (!breadcrumbs) return;
	for (const crumb of breadcrumbs) {
		const data = crumb.data;
		if (!data) continue;
		for (const key of ["url", "to", "from"] as const) {
			const value = data[key];
			if (typeof value === "string") data[key] = stripUrlQuery(value);
		}
	}
}

/**
 * Drop user-identifying PII before any event leaves the worker (ADR 0118 decided
 * default; adjustable). Strips the `user` block, the request cookies/headers +
 * `query_string`, and the query string off the request URL and any URL-bearing
 * breadcrumb — the incidental PII vectors that survive `sendDefaultPii: false`.
 * Same scrub as the SPA copy.
 */
export function scrubPii(event: ErrorEvent): ErrorEvent {
	if (event.user) {
		event.user = {};
	}
	if (event.request) {
		// Omit rather than set `undefined`: under `exactOptionalPropertyTypes` these
		// fields are `Record<...>`, not `... | undefined`, so dropping the keys is the
		// only way to strip them.
		const {cookies: _cookies, headers: _headers, query_string: _query, ...rest} = event.request;
		event.request = typeof rest.url === "string" ? {...rest, url: stripUrlQuery(rest.url)} : rest;
	}
	scrubBreadcrumbUrls(event.breadcrumbs);
	return event;
}

/** The decided client options (ADR 0118): PII off, scrubbed `beforeSend`. */
export function workerOptions(dsn: string): CloudflareOptions {
	return {
		dsn,
		sendDefaultPii: false,
		beforeSend: (event) => scrubPii(event),
	};
}
