/**
 * `useFlag(key, default)` — the SPA's flag surface (epic #488, #510). Exposes a
 * single boolean flag's **server-evaluated** value to a React 19 component, so a
 * screen can render a gated UI path without re-implementing evaluation.
 *
 * Two resolution paths, one hook (the unified flag surface, ADR 0179, epic #2926):
 *
 * - **Shell-key-manifest member** ({@link BOOT_MEMBER_KEYS}): resolved SYNCHRONOUSLY from
 *   `window.__BOOT__` on the **first render** — `{value, loading: false}`, no `useEffect`
 *   fetch and no post-boot repaint. The worker resolved it at the edge under the full
 *   session context and injected it, so the shell paints its final geometry immediately.
 *   If `__BOOT__` is absent (flag off / the never-hang outage fallback serves an
 *   untransformed asset), the member falls back to the fetch path unchanged — the
 *   optional-`__BOOT__` contract.
 * - **Non-member key**: the fetch path below, exactly as before — the value POSTs the flag
 *   key + its default to `/api/flags/evaluate`, the Worker evaluates it under the
 *   session-derived targeting context, and the hook consumes the resolved boolean.
 *
 * The targeting context (user identity) is never sent from the browser — the request
 * carries only `{key, default}`, and no Flagship binding or flag config ships to the client.
 *
 * Safe-default, always. The returned `value` starts at `defaultValue` and stays
 * there unless a genuine boolean resolves for the key — from `__BOOT__` or the server;
 * any fetch error, non-2xx response, missing key, or absent `__BOOT__` leaves it at the
 * default ({@link resolveFlag}). The hook never throws — a Flagship outage or a missing
 * `__BOOT__` degrades the gated UI to its off/old path rather than breaking the screen.
 *
 * Imperative (`fetch` in an effect), not a suspending fate read: a flag gate can
 * sit anywhere in the tree, including above a `<Screen>` Suspense boundary, so it
 * must resolve to a safe default rather than suspend — the same reasoning as
 * `useMe` / `useProfileStats`.
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

/** A flag read: its current value plus whether the server result is in yet. */
export interface FlagState {
	/** The server-evaluated value, or `defaultValue` until/unless the server says otherwise. */
	readonly value: boolean;
	/** `true` while the evaluate request is in flight (the value is still the default). */
	readonly loading: boolean;
}

/**
 * The client view of `window.__BOOT__`: each manifest member key → boolean, every key
 * optional so a partial or absent payload cleanly falls back to fetch. Mirrors the worker's
 * injected payload (`worker/features/flagship/shell-boot.ts`); both sides derive their key
 * set from the one manifest ({@link BOOT_MEMBER_KEYS}), so the shapes can't drift.
 */
export type BootPayload = Partial<Record<BootMemberKey, boolean>>;

/**
 * The `__BOOT__`-member key set `useFlag` resolves synchronously — the shell flag keys —
 * single-sourced from the one manifest ({@link BOOT_MEMBER_KEYS}), never re-listed here. (The
 * signed-in identity is the typed `__BOOT__.user` object, read by `boot.ts`, not a member key —
 * ADR 0185.) The consume-side drift guard (ADR 0179 §3) runs once at module load:
 * it proves the key set the client reads derives from the manifest, the same fail-closed
 * check the worker runs at injection. A static self-check only — the never-throw runtime
 * paths below read this set, they never re-assert against live `__BOOT__` data (a drift throw
 * on untrusted per-request data would violate the never-throw contract).
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
 * The synchronous `__BOOT__` resolution for a member key, factored out pure (takes the
 * payload explicitly) so the member-sync / absent-fallback contract is unit-testable without
 * a DOM. Returns the boot value only when the key is a manifest member AND `boot` carries a
 * boolean for it; `undefined` otherwise (non-member key, absent `__BOOT__`, or a
 * missing/malformed value) — the signal `useFlag` reads to fall back to the fetch path.
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
				// Attribute captured errors to this flag's resolved state (#1821): once the
				// server resolves the flag it becomes a queryable Sentry `flag.<key>` tag on the
				// scope, so a graduation query can isolate its on-path error rate. Inert when
				// Sentry has no DSN. Only on a genuine server resolution — the catch below holds
				// the default without a server answer, so nothing is attributed there.
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
