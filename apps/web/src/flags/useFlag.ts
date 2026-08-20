/**
 * `useFlag(key, default)` — the SPA's server-evaluated flag surface (#488). Two resolution paths,
 * one hook: a shell-key-manifest member resolves synchronously from `window.__BOOT__`, everything
 * else POSTs `/api/flags/evaluate`. See ADR 0179.
 *
 * Two invariants hold across both paths. **Safe-default, never throws**: the value stays at
 * `defaultValue` unless a genuine boolean resolves, so a Flagship outage degrades the gated UI to
 * its off path instead of breaking the screen. **Imperative, not a suspending fate read**: a gate
 * can sit above a Suspense boundary, so it must resolve to a default rather than suspend.
 */
import {useEffect, useState} from "react";
import {
	type FlagEvaluateRequest,
	resolveFlag,
} from "../../worker/features/flagship/evaluate-contract";
import {tagFlag} from "../lib/sentry";
import {
	assertShellBootKeysSingleSourced,
	BOOT_MEMBER_KEYS,
	type BootMemberKey,
} from "./shell-keys.ts";

export interface FlagState {
	/** The server-evaluated value, or `defaultValue` until/unless the server says otherwise. */
	readonly value: boolean;
	readonly loading: boolean;
}

/**
 * Mirrors the worker's injected payload (`worker/features/flagship/shell-boot.ts`); both sides
 * derive their key set from the one manifest ({@link BOOT_MEMBER_KEYS}), so the shapes can't drift.
 */
export type BootPayload = Partial<Record<BootMemberKey, boolean>>;

/**
 * Single-sourced from the one manifest ({@link BOOT_MEMBER_KEYS}), never re-listed here; the
 * consume-side drift guard runs once at module load (ADR 0179 §3). A STATIC self-check only — it
 * must never re-assert against live `__BOOT__` data, which would break the never-throw contract.
 */
const BOOT_MEMBER_KEY_SET: ReadonlySet<string> = ((): ReadonlySet<string> => {
	const consumed = [...BOOT_MEMBER_KEYS];
	assertShellBootKeysSingleSourced(consumed, consumed);
	return new Set(consumed);
})();

/** Read `window.__BOOT__` defensively — absent/non-object ⇒ `undefined` ⇒ the fetch fallback. */
function readBoot(): BootPayload | undefined {
	if (typeof window === "undefined") return undefined;
	const boot = (window as {__BOOT__?: unknown}).__BOOT__;
	return typeof boot === "object" && boot !== null ? (boot as BootPayload) : undefined;
}

/**
 * Pure (the payload is passed in) so the member-sync / absent-fallback contract is testable
 * without a DOM. `undefined` is the signal `useFlag` reads to fall back to the fetch path.
 */
export function resolveBootFlag(boot: BootPayload | undefined, key: string): boolean | undefined {
	if (!BOOT_MEMBER_KEY_SET.has(key)) return undefined;
	if (boot === undefined) return undefined;
	const value = (boot as Record<string, unknown>)[key];
	return typeof value === "boolean" ? value : undefined;
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
 * Factored out so the safe-default contract is testable without a `fetch`/DOM: a non-2xx response
 * holds the default, a 2xx one routes untrusted JSON through {@link resolveFlag}'s structural guard.
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

export function useFlag(key: string, defaultValue: boolean): FlagState {
	// Member keys resolve synchronously from __BOOT__ in the initializer so the very first
	// render carries {value, loading:false} — no effect, no post-boot repaint. `undefined`
	// (non-member, or __BOOT__ absent) starts the fetch path at the loading default.
	const [state, setState] = useState<FlagState>(() => {
		const booted = resolveBootFlag(readBoot(), key);
		return booted === undefined
			? {value: defaultValue, loading: true}
			: {value: booted, loading: false};
	});

	useEffect(() => {
		const booted = resolveBootFlag(readBoot(), key);
		if (booted !== undefined) {
			// Member key: the value came synchronously from __BOOT__. Re-sync only on a key
			// change (the initializer runs once); returning `prev` when unchanged makes React
			// bail out of the re-render, so a member never repaints and never fetches.
			setState((prev) =>
				prev.value === booted && !prev.loading ? prev : {value: booted, loading: false},
			);
			return;
		}
		let active = true;
		// Reset to the loading default before each read so a key change can't briefly show
		// the previous key's value.
		setState({value: defaultValue, loading: true});
		fetchFlag(key, defaultValue)
			.then((resolved) => {
				if (!active) return;
				setState({value: resolved, loading: false});
				// Tag captured errors with this flag's resolved state (#1821). Only on a genuine server
				// resolution — the catch below holds the default, so nothing is attributed there.
				tagFlag(key, resolved);
			})
			.catch(() => {
				// Any failure stays at the default — the off/old/safe path (#488).
				if (!active) return;
				setState({value: defaultValue, loading: false});
			});
		return () => {
			active = false;
		};
	}, [key, defaultValue]);

	return state;
}
