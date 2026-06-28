/**
 * `useImperativeView` — the shared imperative `request` + `readView` read for the
 * hooks that run ABOVE the `<Screen>` Suspense boundary (the `Layout`/header
 * shell), so they must drive fate rather than suspend. It collapses the
 * gate → loading → request → readView → cast → discriminated-state body the three
 * above-Suspense read hooks (`useMe`, `useProfileStats`, `useAuthorshipStanding`)
 * each copied (#1420).
 *
 * Two things this centralizes:
 *   - The `ok` payload is typed by DERIVING it from the view — the same
 *     `ViewData<ViewEntity<V> & {__typename}, ViewSelection<V>>` technique
 *     react-fate's own `useView`/`useLiveView` return — so the codegen'd server
 *     Entity stays the single source of truth (ADR 0022). No hand-written
 *     interface restates the wire shape.
 *   - The `as` cast lives here and ONLY here. `readView`'s static return narrows
 *     only the normalization key (`id`/`userId`); the selected scalars are
 *     present at runtime but absent from the static type, so the read crosses the
 *     gap with one derived cast — covered by a test — instead of three copies
 *     (the #448 swallow site).
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

/**
 * The masked data a resolved `view` ref carries, derived from the view itself —
 * the codegen'd Entity (`ViewEntity<V>`) projected through the view's selection
 * (`ViewSelection<V>`), with the `__typename` literal re-attached. Identical to
 * what `useView(view, ref)` returns; this is the imperative counterpart.
 */
export type ImperativeViewData<V extends View<any, any>> = ViewData<
	ViewEntity<V> & {__typename: ViewEntityName<V>},
	ViewSelection<V>
>;

export type ImperativeViewState<V extends View<any, any>> =
	| {status: "idle"}
	| {status: "loading"}
	| {status: "ok"; data: ImperativeViewData<V> | null}
	| {status: "error"};

/** The two `FateClient` methods the imperative read needs — the seam the unit test stubs. */
export type ImperativeViewClient = Pick<FateClient<any, any>, "request" | "readView">;

/**
 * The pure read: `request` the root → resolve its ref → `readView` it → the ONE
 * cast. Extracted from the hook so the cast + null-ref handling are unit-testable
 * without a DOM/React runtime (#1420). `readView` statically narrows only the
 * normalization key; the selected scalars are present at runtime, so the read
 * crosses that gap with the single derived cast (ADR 0022) — the lone home of the
 * cast the three migrated hooks each used to carry (the #448 swallow site). A
 * `null` root ref resolves to `null` data (a successful empty), never throws.
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
	/** Gate: while `false` the hook never touches the wire and reports `idle` — the fail-closed off path. */
	readonly enabled: boolean;
	/** Extra refetch triggers beyond `enabled`/`args` — e.g. the session identity, so `useMe` re-reads after a session update even while still signed in. */
	readonly deps?: ReadonlyArray<unknown>;
}

/**
 * Drives one imperative fate root read and reports a discriminated
 * `idle | loading | ok | error` state. Disabled ⇒ `idle`, never on the wire. A
 * `null` ref (root resolved to nothing) is a successful `ok` with `data: null`,
 * NOT an error — the caller decides what a null result means (#448). Any thrown
 * read ⇒ `error`.
 */
export function useImperativeView<V extends View<any, any>>(
	root: string,
	view: V,
	{args, enabled, deps = []}: UseImperativeViewOptions,
): {readonly state: ImperativeViewState<V>; readonly refetch: () => Promise<void>} {
	const fate = useFateClient();
	const [state, setState] = useState<ImperativeViewState<V>>({status: "idle"});

	const refetch = useCallback(async () => {
		if (!enabled) {
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
