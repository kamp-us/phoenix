/**
 * Worker-side Sentry options + the flag-attribution tagger (ADR 0118), on
 * `@sentry/cloudflare` rather than the SPA's `@sentry/react`.
 *
 * This module holds NO init: the client is created at the request seam in `index.ts`
 * via `wrapRequestHandler`, the only workerd-safe init path for an Effect-`HttpRouter`
 * worker (#1502). So "inert when no DSN" is structural — `wrapRequestHandler` never
 * runs, so no client is ever active, which is what `tagFlag` gates on.
 */
import type {CloudflareOptions} from "@sentry/cloudflare";
import * as Sentry from "@sentry/cloudflare";
import {flagTag} from "../features/flagship/flag-tag.ts";

/**
 * The single gate the request seam checks, so the worker integration is provably
 * inert when the DSN is unset: no client, no capture, no network.
 */
export function sentryEnabled(dsn: string | undefined): dsn is string {
	return typeof dsn === "string" && dsn.trim().length > 0;
}

/**
 * The decided client options (ADR 0118): native `dataCollection` (SDK ≥10.57, the
 * granular successor to the removed `sendDefaultPii`), no `beforeSend`. Query strings
 * carry no GDPR-PII here — only short-lived auth tokens, which Sentry's server-side
 * scrubbing catches by field name — so no client-side URL scrub is needed.
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

/**
 * Stamp a resolved flag onto the request's Sentry scope as a queryable
 * `flag.<key>`:`on`/`off` tag (#1821), over the shared `flagTag` naming contract so the
 * worker and SPA tiers read uniformly. Called from `Flags.getBoolean`, which runs
 * inside the request's `wrapRequestHandler` scope, so the tag lands on every error
 * captured for that request. Flag keys/values are non-PII, so this re-enables none of
 * the ADR 0118 `dataCollection` scrub.
 */
export function tagFlag(key: string, value: boolean): void {
	if (!Sentry.isEnabled()) {
		return;
	}
	const {tagKey, tagValue} = flagTag(key, value);
	Sentry.setTag(tagKey, tagValue);
}
