// @patch-pin: react-fate@1.3.1
/**
 * Behavior pin for `patches/react-fate@1.3.1.patch` (ADR 0038) — `useView`'s
 * pending-thenable dedup. When a view snapshot is non-fulfilled, the patch caches
 * the wrapper thenable in `pendingViewRef` keyed by `(viewRef, source, cacheKey)`
 * and returns that SAME object on every `getSnapshot` call, instead of the
 * unpatched branch's fresh `Promise.resolve(snapshot).then(…)` per call.
 *
 * The observable contract asserted here: for one stable pending source snapshot,
 * `useSyncExternalStore` calls `getSnapshot` multiple times per render (the read +
 * the tearing/consistency re-read), yet the patched hook adopts the source thenable
 * exactly ONCE — `Promise.resolve(source)` (which invokes `source.then`) runs a
 * single time because the second call short-circuits to the cached thenable. Drop
 * the patch and each `getSnapshot` rebuilds the wrapper, adopting the source again
 * (≥ 2 calls) and feeding `useSyncExternalStore` a new snapshot per check → the
 * React #185 re-render loop. Counting `source.then` invocations is the direct proxy
 * for "the same pending thenable is deduped across renders", complementing the
 * loop-symptom pin in `useViewPendingSnapshot.test.tsx` (#1686).
 */

import {act, render, screen} from "@testing-library/react";
import * as React from "react";
import {FateClient, useView, view} from "react-fate";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

type TestEntity = {__typename: "TestEntity"; id: string; name: string};
const TestView = view<TestEntity>()({id: true, name: true});

const REF = {__typename: "TestEntity", id: "1"} as const;

// A stable, never-settling thenable standing in for an in-flight (non-fulfilled)
// view snapshot. `.then` is a spy: `Promise.resolve(source)` inside
// `readViewSnapshot` adopts it by calling `.then`, so the call count == how many
// times the hook (re)built the wrapper thenable rather than reusing the cache.
function makePendingSource() {
	const then = vi.fn(
		(_onfulfilled?: (v: never) => unknown, _onrejected?: (e: unknown) => unknown) => {
			// Never resolve: the snapshot stays pending, so the hook suspends.
		},
	);
	// A `then`-bearing object is exactly fate's non-fulfilled-snapshot shape, read
	// by React `use()`; the spy count is the dedup probe.
	return {then} as {then: typeof then};
}

// `useView` on a non-fulfilled snapshot only touches `client.readView` (returns the
// pending source) and `client.store.subscribe` (a no-op while `snapshotRef` is null).
function makeClient(source: unknown) {
	return {
		readView: () => source,
		store: {
			subscribe: () => () => {},
		},
	};
}

function Probe() {
	const data = useView(TestView, REF as never);
	return <output data-testid="name">{data ? (data as TestEntity).name : "yok"}</output>;
}

class Boundary extends React.Component<{children: React.ReactNode}, {error: Error | null}> {
	override state = {error: null};
	static getDerivedStateFromError(error: Error) {
		return {error};
	}
	override render() {
		return this.state.error ? (
			<div data-testid="crashed">{String(this.state.error)}</div>
		) : (
			this.props.children
		);
	}
}

describe("useView pending-thenable dedup (patches/react-fate@1.3.1.patch, ADR 0038)", () => {
	beforeEach(() => {
		// Unpatched, React logs the "getSnapshot should be cached" warning + the
		// boundary-caught error via console.error; keep the run output clean.
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("adopts one stable pending thenable across getSnapshot calls instead of rebuilding per call", async () => {
		const source = makePendingSource();
		const client = makeClient(source);

		render(
			<Boundary>
				<FateClient client={client as never}>
					<React.Suspense fallback={<div data-testid="pending">yükleniyor</div>}>
						<Probe />
					</React.Suspense>
				</FateClient>
			</Boundary>,
		);

		// It actually took the pending path (suspended to the fallback) and did not
		// loop into the error boundary.
		expect(screen.queryByTestId("crashed")).toBeNull();
		expect(screen.getByTestId("pending")).not.toBeNull();

		// `Promise.resolve(source)` adopts the source thenable on a microtask, so
		// flush before counting.
		await act(async () => {
			await Promise.resolve();
		});

		// The pin: the dedup cache returns the SAME wrapper thenable on the repeat
		// getSnapshot calls, so the source is adopted exactly once. Unpatched, every
		// getSnapshot rebuilds the wrapper and re-adopts the source (≥ 2), or spins
		// into React #185 before it can settle — either way this is not 1.
		expect(source.then).toHaveBeenCalledTimes(1);
	});
});
