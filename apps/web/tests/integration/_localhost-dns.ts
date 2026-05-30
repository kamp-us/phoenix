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

	// Callback form. The DNS callback's success arity depends on `options.all`:
	// with `all` it's `(err, LookupAddress[])`, otherwise `(err, address,
	// family)`. We model that union directly so the localhost short-circuit calls
	// it without a cast, and delegate non-localhost names to the original
	// `dns.lookup` (the wrapper is re-typed as `typeof dns.lookup`, not `any`).
	type LookupCallback = (
		err: NodeJS.ErrnoException | null,
		addressOrAll?: string | LookupAddress[],
		family?: number,
	) => void;
	const originalLookup = dns.lookup;
	const patchedLookup = ((
		hostname: string,
		optionsOrCallback: LookupOptions | LookupCallback,
		maybeCallback?: LookupCallback,
	) => {
		if (isLocalhost(hostname)) {
			const callback: LookupCallback =
				typeof optionsOrCallback === "function"
					? optionsOrCallback
					: (maybeCallback as LookupCallback);
			const options = typeof optionsOrCallback === "object" ? optionsOrCallback : undefined;
			if (options?.all) {
				callback(null, [{address: "127.0.0.1", family: 4}]);
			} else {
				callback(null, "127.0.0.1", 4);
			}
			return;
		}
		return originalLookup(hostname, optionsOrCallback as LookupOptions, maybeCallback as never);
	}) as typeof dns.lookup;
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
		return originalPromisesLookup(hostname, options as LookupOptions);
	}) as typeof dns.promises.lookup;
	dns.promises.lookup = patchedPromisesLookup;
}
