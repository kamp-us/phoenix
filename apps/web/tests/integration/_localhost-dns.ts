/**
 * Localhost DNS shim for the integration harness.
 *
 * `fetch("http://phoenix.localhost:<port>/…")` does not work out of the box on
 * macOS — only the bare `localhost` is in `/etc/hosts`, and `*.localhost`
 * subdomains fall through to the system resolver and fail. The alchemy dev
 * sidecar serves stack workers on `<name>.localhost:<port>`, so the integration
 * suite needs those subdomains to resolve to `127.0.0.1`.
 *
 * This used to live in `alchemy/Util/LocalhostDns`; alchemy@2.0.0-beta.45
 * dropped it, so we keep a tiny local copy. `installLocalhostDns()` is a
 * one-shot, idempotent monkey-patch over `node:dns`:
 *   - flips the default result order to `ipv4first` (so anything that *does*
 *     hit the resolver prefers IPv4),
 *   - short-circuits any `*.localhost` (or `localhost`) lookup — both the
 *     callback form on `dns.lookup` and the promise form on
 *     `dns.promises.lookup` — to `127.0.0.1` / family 4.
 *
 * Anything that does NOT end in `.localhost` is delegated to the original
 * resolver untouched.
 */

import type {LookupAddress, LookupOneOptions, LookupOptions} from "node:dns";
import dns from "node:dns";

let installed = false;

/** Idempotent: a second call is a no-op. */
export function installLocalhostDns(): void {
	if (installed) return;
	installed = true;

	dns.setDefaultResultOrder("ipv4first");

	const isLocalhost = (hostname: string): boolean =>
		hostname === "localhost" || hostname.endsWith(".localhost");

	// Callback form — node's overloads are messy, so we type the wrapper as a
	// permissive function and delegate to the original for non-localhost names.
	const originalLookup = dns.lookup;
	const patchedLookup = ((
		hostname: string,
		optionsOrCallback: unknown,
		maybeCallback?: unknown,
	) => {
		if (isLocalhost(hostname)) {
			const callback = (
				typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback
			) as (err: NodeJS.ErrnoException | null, address?: string, family?: number) => void;
			const options = (
				typeof optionsOrCallback === "object" && optionsOrCallback !== null
					? optionsOrCallback
					: undefined
			) as LookupOptions | undefined;
			if (options?.all) {
				const all: LookupAddress[] = [{address: "127.0.0.1", family: 4}];
				(callback as unknown as (err: null, all: LookupAddress[]) => void)(null, all);
			} else {
				callback(null, "127.0.0.1", 4);
			}
			return;
		}
		return (originalLookup as any)(hostname, optionsOrCallback, maybeCallback);
	}) as any;
	dns.lookup = patchedLookup;

	// Promise form.
	const originalPromisesLookup = dns.promises.lookup;
	const patchedPromisesLookup = ((hostname: string, options?: LookupOneOptions | LookupOptions) => {
		if (isLocalhost(hostname)) {
			if (typeof options === "object" && options !== null && options.all) {
				return Promise.resolve([{address: "127.0.0.1", family: 4}] satisfies LookupAddress[]);
			}
			return Promise.resolve({address: "127.0.0.1", family: 4} satisfies LookupAddress);
		}
		return (originalPromisesLookup as any)(hostname, options);
	}) as any;
	dns.promises.lookup = patchedPromisesLookup;
}
