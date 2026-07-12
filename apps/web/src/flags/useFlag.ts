/**
 * `useFlag(key, default)` — the SPA's flag surface (epic #488, #510). Exposes a
 * single boolean flag's **server-evaluated** value to a React 19 component, so a
 * screen can render a gated UI path without re-implementing evaluation.
 *
 * Evaluation is server-side, by design. The hook POSTs the flag key + its
 * default to `/api/flags/evaluate`; the Worker evaluates it through the `Flags`
 * service under the **session-derived** targeting context and returns the
 * resolved boolean. The targeting context (user identity) is never sent from the
 * browser — the request carries only `{key, default}`, and no Flagship binding or
 * flag config ships to the client. The hook consumes a resolved value, nothing
 * more.
 *
 * Safe-default, always. The returned `value` starts at `defaultValue` and stays
 * there unless the server returns a genuine boolean for the key; any fetch error,
 * non-2xx response, or missing key leaves it at the default ({@link resolveFlag}).
 * The hook never throws — a Flagship outage degrades the gated UI to its off/old
 * path rather than breaking the screen.
 *
 * Imperative (`fetch` in an effect), not a suspending fate read: a flag gate can
 * sit anywhere in the tree, including above a `<Screen>` Suspense boundary, so it
 * must resolve to a safe default rather than suspend — the same reasoning as
 * `useMe` / `useProfileStats`.
 *
 * Opt-in `persist` seeds first paint from the last-resolved value (#2828). A
 * gated nav slot whose flag defaults `false` pops in *after* the ungated links on
 * every load (the mecmua topnav CLS) — the false→true flip is the shift. With
 * `persist` the first render seeds from the cached last-known value instead of the
 * raw default, so a returning visitor's gated slot paints stable; the server
 * evaluate stays authoritative and rewrites the cache, so gating never changes and
 * a killed flag self-corrects on the next response. Off by default — every other
 * caller is byte-identical to before.
 */
import {useEffect, useState} from "react";
import {
	type FlagEvaluateRequest,
	resolveFlag,
} from "../../worker/features/flagship/evaluate-contract";
import {readCachedFlag, writeCachedFlag} from "./flagCache";

/** A flag read: its current value plus whether the server result is in yet. */
export interface FlagState {
	/** The server-evaluated value, or `defaultValue` until/unless the server says otherwise. */
	readonly value: boolean;
	/** `true` while the evaluate request is in flight (the value is still the default). */
	readonly loading: boolean;
}

async function fetchFlag(key: string, defaultValue: boolean): Promise<boolean> {
	const requestBody: FlagEvaluateRequest = {keys: [{key, default: defaultValue}]};
	// Cookie session auth rides the request (same-origin), exactly like the fate
	// client — the server derives the targeting identity from it, not from the body.
	const res = await fetch("/api/flags/evaluate", {
		method: "POST",
		credentials: "include",
		headers: {"content-type": "application/json"},
		body: JSON.stringify(requestBody),
	});
	return resolveFlagResponse(res.ok, res.ok ? await res.json() : null, key, defaultValue);
}

/**
 * The hook's response → value wiring, factored out so the safe-default contract
 * is unit-testable without a `fetch`/DOM (the pure-core idiom of
 * `toProfileStatsState`). A non-2xx response is the fetch-error path → the
 * default holds; a 2xx response routes the untrusted JSON through
 * {@link resolveFlag}, whose structural guard enforces the safe default on a
 * missing key / non-boolean. A gate that forgot to call `resolveFlag` or
 * dropped the non-2xx guard would fail exactly this function.
 */
export function resolveFlagResponse(
	ok: boolean,
	body: unknown,
	key: string,
	defaultValue: boolean,
): boolean {
	if (!ok) return defaultValue;
	return resolveFlag(body, key, defaultValue);
}

/** Extra behavior a call-site can opt into. */
export interface UseFlagOptions {
	/**
	 * Seed first paint from (and write back) the last-resolved value in
	 * `localStorage`, so a gated slot paints stable across loads instead of
	 * flipping default→resolved on every render (#2828). Off by default.
	 */
	readonly persist?: boolean;
}

function flagStorage(): Storage | undefined {
	return typeof window === "undefined" ? undefined : window.localStorage;
}

export function useFlag(key: string, defaultValue: boolean, options?: UseFlagOptions): FlagState {
	const persist = options?.persist ?? false;
	// With persist on, the first render's seed is the cached last-known value (falling
	// back to the default when absent/garbage/unavailable); otherwise the raw default,
	// exactly as before. The server evaluate below still overwrites it, so this only
	// changes the *pre-response* paint — never the resolved gating.
	const [value, setValue] = useState(() =>
		persist ? readCachedFlag(flagStorage(), key, defaultValue) : defaultValue,
	);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let active = true;
		setLoading(true);
		// Reset before each read so a key change can't briefly show the previous key's
		// value — to the cached seed under persist (so no key change reintroduces the
		// flip), else the raw default.
		setValue(persist ? readCachedFlag(flagStorage(), key, defaultValue) : defaultValue);
		fetchFlag(key, defaultValue)
			.then((resolved) => {
				if (persist) writeCachedFlag(flagStorage(), key, resolved);
				if (!active) return;
				setValue(resolved);
				setLoading(false);
			})
			.catch(() => {
				// Any failure stays at the default — the off/old/safe path (#488).
				if (!active) return;
				setValue(defaultValue);
				setLoading(false);
			});
		return () => {
			active = false;
		};
	}, [key, defaultValue, persist]);

	return {value, loading};
}
