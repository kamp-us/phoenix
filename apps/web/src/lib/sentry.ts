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
 * The decided client options (ADR 0118): pure native `dataCollection` (SDK ≥10.57,
 * the granular successor to the removed `sendDefaultPii`), no `beforeSend`. It
 * suppresses the cookies/headers/user/`query_string` PII. Query strings carry no
 * GDPR-PII in this app (only short-lived auth/OAuth tokens, caught by Sentry's
 * server-side default data-scrubbing by field name), so no client-side URL scrub is
 * needed — server-side Advanced Data Scrubbing is the backstop.
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

/**
 * Feature-flag attribution on captured errors (#1821). A flag the session resolves becomes the
 * Sentry tag `flag.<key>` with value `"on"`/`"off"`, so a single flag's on-path error rate is
 * isolable for the dark→release→burn-in→graduate gate the flag lifecycle depends on (#1822
 * consumes this). The graduation query is `flag.<key>:on` — e.g. `flag.phoenix-bildirim:on`
 * counts errors captured while `phoenix-bildirim` was on for the session, and `flag.<key>:off`
 * the comparison off-path. Keys are the `flags/keys.ts` constants (non-PII), so tagging is
 * orthogonal to the ADR 0118 `dataCollection` PII scrub and touches none of it.
 */
export const FLAG_TAG_PREFIX = "flag.";

/**
 * The `(tagKey, tagValue)` a resolved flag maps to — pure, so the tag-naming contract is
 * unit-testable without Sentry (the pure-core idiom of `browserOptions`).
 */
export function flagTag(key: string, value: boolean): {tagKey: string; tagValue: "on" | "off"} {
	return {tagKey: `${FLAG_TAG_PREFIX}${key}`, tagValue: value ? "on" : "off"};
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

/**
 * Record a resolved flag on the global Sentry scope so subsequently-captured errors carry its
 * state as a queryable `flag.<key>` tag (#1821). No-ops when inert (no DSN) — no scope mutation,
 * no network, mirroring init/capture — so tagging adds nothing while Sentry is off.
 */
export function tagFlag(key: string, value: boolean): void {
	if (!sentryEnabled(dsn)) {
		return;
	}
	const {tagKey, tagValue} = flagTag(key, value);
	Sentry.setTag(tagKey, tagValue);
}
