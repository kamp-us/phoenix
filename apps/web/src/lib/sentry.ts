/**
 * SPA-side Sentry wiring — see ADR 0118 for the why and the decided defaults.
 *
 * Ships INERT: with no DSN provisioned, nothing inits, nothing sends, nothing throws.
 * The DSN is a public value read from the build-time `VITE_SENTRY_DSN`, deliberately
 * NOT the worker's `SENTRY_DSN` secret binding.
 */
import * as Sentry from "@sentry/react";
import {flagTag} from "../../worker/features/flagship/flag-tag";

// Re-exported from the SDK-free module the worker tagger also uses, so both tiers stamp an
// identical `flag.<key>` shape and one graduation query reads across them (#1821).
export {FLAG_TAG_PREFIX, flagTag} from "../../worker/features/flagship/flag-tag";

/** The single gate every Sentry path checks, so the integration is provably inert when unset. */
export function sentryEnabled(dsn: string | undefined): dsn is string {
	return typeof dsn === "string" && dsn.trim().length > 0;
}

/**
 * The decided options (ADR 0118): native `dataCollection`, no `beforeSend`. The missing
 * client-side URL scrub is deliberate — query strings here carry no GDPR-PII, and
 * server-side Advanced Data Scrubbing is the backstop.
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
	};
}

const dsn = import.meta.env.VITE_SENTRY_DSN;

export function initSentry(): void {
	if (!sentryEnabled(dsn)) {
		return;
	}
	Sentry.init(browserOptions(dsn));
}

export function captureBoundaryError(error: unknown, componentStack?: string | null): void {
	if (!sentryEnabled(dsn)) {
		return;
	}
	Sentry.captureException(
		error,
		componentStack ? {contexts: {react: {componentStack}}} : undefined,
	);
}

/** Puts a resolved flag on the global scope so later captures carry it as `flag.<key>` (#1821). */
export function tagFlag(key: string, value: boolean): void {
	if (!sentryEnabled(dsn)) {
		return;
	}
	const {tagKey, tagValue} = flagTag(key, value);
	Sentry.setTag(tagKey, tagValue);
}
