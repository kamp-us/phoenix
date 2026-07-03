/**
 * SPA-side Sentry wiring (ADR 0118). The browser tier is the decisive gap CF-native
 * Workers Observability (#1222) structurally cannot see — SPA crashes that today
 * `console.error` and vanish at the `Screen.tsx` boundary. This captures them, but
 * stays INERT until a DSN is provisioned: an absent/empty DSN skips `init` entirely,
 * so nothing is sent and nothing throws. The maintainer provisions the Sentry account
 * + DSN later (the same parked-on-external-provisioning pattern ADR 0118 names).
 *
 * A Sentry DSN is a public, client-side value, so the SPA reads it from a build-time
 * Vite env var (`VITE_SENTRY_DSN`) baked into the bundle — distinct from the worker's
 * `SENTRY_DSN` secret_text binding. The EU data region is realized by the ingest host
 * the provisioned DSN points at; the decided defaults (EU region, PII scrub) are ADR
 * 0118's and adjustable there.
 */
import * as Sentry from "@sentry/react";

/**
 * Whether a usable DSN is present — the single gate every Sentry path checks, so the
 * integration is provably inert when unset (no init, no capture, no network, no throw).
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
 * (see `browserOptions`), but the full request URL is ALWAYS sent regardless
 * (`@sentry/core` requestdata: `url: true`, "No dataCollection equivalent"), so
 * the query string on it must be cut here. See ADR 0118.
 */
export function scrubUrls(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
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
export function browserOptions(dsn: string): Sentry.BrowserOptions {
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

const dsn = import.meta.env.VITE_SENTRY_DSN;

/** Initialize Sentry for the SPA — a no-op when no DSN is provisioned (inert). */
export function initSentry(): void {
	if (!sentryEnabled(dsn)) {
		return;
	}
	Sentry.init(browserOptions(dsn));
}

/**
 * Forward an error-boundary catch to Sentry. No-ops when inert, so the boundary's own
 * `console.error` stays the only effect until a DSN is set.
 */
export function captureBoundaryError(error: unknown, componentStack?: string | null): void {
	if (!sentryEnabled(dsn)) {
		return;
	}
	Sentry.captureException(
		error,
		componentStack ? {contexts: {react: {componentStack}}} : undefined,
	);
}
