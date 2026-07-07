/// <reference types="vite/client" />

/**
 * Build-time client env (Vite exposes only `VITE_`-prefixed vars to the bundle).
 * `VITE_SENTRY_DSN` is the SPA's Sentry DSN (ADR 0118) — a public, client-side value,
 * absent by default so Sentry ships inert until the maintainer provisions it.
 */
interface ImportMetaEnv {
	readonly VITE_SENTRY_DSN?: string;
	/**
	 * Feed-snapshot containment flag (epic #2316, leg A). `"on"` enables the
	 * boot-time persist+hydrate of the public fate cache; absent/anything else keeps
	 * it dark (default-off). A build-time flag, not the server-evaluated Flagship
	 * flag, because boot hydration resolves synchronously before any `/api/flags`
	 * round-trip — see `src/fate/snapshot.ts`. #2326 flips it on measured evidence.
	 */
	readonly VITE_FEED_SNAPSHOT?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
