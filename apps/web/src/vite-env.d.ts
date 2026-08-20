/// <reference types="vite/client" />

// Build-time client env. `VITE_SENTRY_DSN` is absent by default so Sentry ships inert
// until the maintainer provisions it — see ADR 0118.
interface ImportMetaEnv {
	readonly VITE_SENTRY_DSN?: string;
	/**
	 * `"on"` enables the boot-time persist+hydrate of the public fate cache (`src/fate/snapshot.ts`).
	 * Build-time rather than a server-evaluated Flagship flag because boot hydration resolves
	 * synchronously, before any `/api/flags` round-trip.
	 */
	readonly VITE_FEED_SNAPSHOT?: string;
	/**
	 * `"on"` emits the User Timing marks/measures of `src/lib/feedPerf.ts`; also on in dev.
	 * Build-time, like `VITE_FEED_SNAPSHOT`.
	 */
	readonly VITE_FEED_PERF?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
