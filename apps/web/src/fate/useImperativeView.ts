/**
 * The shared imperative `request` + `readView` read for the hooks that run ABOVE the
 * `<Screen>` Suspense boundary (the `Layout`/header shell), so they must drive fate
 * rather than suspend.
 *
 * `useDivanAccess` is deliberately NOT migrated onto this: it is a request-only
 * grant/deny probe that discards the data and returns `boolean`, so folding it in
 * would distort the data-returning shape (#1420).
 */
import type {
	FateClient,
	View,
	ViewData,
	ViewEntity,
	ViewEntityName,
	ViewRef,
	ViewSelection,
} from "@nkzw/fate";
import {useCallback, useEffect, useState} from "react";
import {useFateClient} from "react-fate";

export type ImperativeViewData<V extends View<any, any>> = ViewData<
	ViewEntity<V> & {__typename: ViewEntityName<V>},
	ViewSelection<V>
>;

export type ImperativeViewState<V extends View<any, any>> =
	| {status: "idle"}
	| {status: "loading"}
	| {status: "ok"; data: ImperativeViewData<V> | null}
	| {status: "error"};

export type ImperativeViewClient = Pick<FateClient<any, any>, "request" | "readView">;

/**
 * `readView` statically narrows only the normalization key; the selected scalars are
 * present at runtime but absent from the static type, so the read crosses that gap
 * with one derived cast (ADR 0022) — and this is its only home. A `null` root ref
 * resolves to `null` data (a successful empty), never throws.
 */
export async function readImperativeView<V extends View<any, any>>(
	fate: ImperativeViewClient,
	root: string,
	view: V,
	args?: Record<string, unknown>,
): Promise<ImperativeViewData<V> | null> {
	const result = await fate.request({[root]: args ? {view, args} : {view}});
	const ref = (result as Record<string, ViewRef<ViewEntityName<V>> | null>)[root] ?? null;
	const snapshot = ref ? await fate.readView(view, ref) : null;
	return (snapshot?.data ?? null) as ImperativeViewData<V> | null;
}

export interface UseImperativeViewOptions {
	/** Root args forwarded to `fate.request` (e.g. `{username}`). Memoize a non-empty value at the call site so it's a stable refetch dependency. */
	readonly args?: Record<string, unknown>;
	readonly enabled: boolean;
	readonly deps?: ReadonlyArray<unknown>;
}

/**
 * A disabled read needs no client, so a missing provider is only fatal when enabled
 * (#6760): the shell mounts enabled-off imperative hooks above any FateProvider, and
 * demanding a context there would break every fate-free first-paint render. The hook
 * call itself stays unconditional — the catch demotes the throw, not the read.
 */
function useFateClientWhenEnabled(enabled: boolean): ImperativeViewClient | null {
	try {
		return useFateClient();
	} catch (err) {
		if (enabled) throw err;
		return null;
	}
}

/**
 * A `null` ref (root resolved to nothing) is a successful `ok` with `data: null`, NOT
 * an error — the caller decides what a null result means (#448).
 */
export function useImperativeView<V extends View<any, any>>(
	root: string,
	view: V,
	{args, enabled, deps = []}: UseImperativeViewOptions,
): {readonly state: ImperativeViewState<V>; readonly refetch: () => Promise<void>} {
	const fate = useFateClientWhenEnabled(enabled);
	const [state, setState] = useState<ImperativeViewState<V>>({status: "idle"});

	const refetch = useCallback(async () => {
		if (!enabled || fate == null) {
			setState({status: "idle"});
			return;
		}
		setState({status: "loading"});
		try {
			const data = await readImperativeView(fate, root, view, args);
			setState({status: "ok", data});
		} catch (err) {
			console.error(`[useImperativeView:${root}]`, err);
			setState({status: "error"});
		}
	}, [fate, root, view, args, enabled, ...deps]);

	useEffect(() => {
		void refetch();
	}, [refetch]);

	return {state, refetch};
}
