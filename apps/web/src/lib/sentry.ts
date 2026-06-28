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
 * Drop user-identifying PII before any event leaves the browser (ADR 0118 decided
 * default; adjustable). Strips the `user` block and the request cookies/headers that
 * carry session identifiers.
 */
export function scrubPii(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
	if (event.user) {
		event.user = {};
	}
	if (event.request) {
		event.request = {...event.request, cookies: undefined, headers: undefined};
	}
	return event;
}

/** The decided client options (ADR 0118): PII off, scrubbed `beforeSend`. */
export function browserOptions(dsn: string): Sentry.BrowserOptions {
	return {
		dsn,
		sendDefaultPii: false,
		beforeSend: (event) => scrubPii(event),
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
