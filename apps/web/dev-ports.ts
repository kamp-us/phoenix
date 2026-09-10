/**
 * The two ports the local dev loop binds, read from one place so the Vite proxy and the worker it
 * proxies to can never name different numbers.
 *
 * Both default to their historical fixed values and both are overridable, because a fixed port is
 * not a per-worktree resource: `fabrika ui render` starts this app on ports it allocated itself, so
 * two lanes can render at once without either capturing the other's tree (#7992).
 */

const port = (name: string, fallback: number): number => {
	const declared = process.env[name];
	const parsed = declared === undefined ? Number.NaN : Number.parseInt(declared, 10);
	return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : fallback;
};

/** Where `alchemy dev` serves the worker, and therefore where the Vite proxy sends `/api` + `/fate`. */
export const workerDevPort = (): number => port("PHOENIX_WORKER_PORT", 1337);

/** Where `vite` serves the SPA. */
export const spaDevPort = (): number => port("PHOENIX_SPA_PORT", 3000);
