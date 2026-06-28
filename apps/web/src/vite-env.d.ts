/// <reference types="vite/client" />

/**
 * Build-time client env (Vite exposes only `VITE_`-prefixed vars to the bundle).
 * `VITE_SENTRY_DSN` is the SPA's Sentry DSN (ADR 0118) — a public, client-side value,
 * absent by default so Sentry ships inert until the maintainer provisions it.
 */
interface ImportMetaEnv {
	readonly VITE_SENTRY_DSN?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
