// @patch-pin: react-fate@1.3.1
/**
 * Behavior pin for `patches/react-fate@1.3.1.patch` (ADR 0038) — `useView`'s
 * pending-thenable dedup. Counting `source.then` invocations is the proxy for "the
 * same pending thenable is deduped across renders"; the loop symptom itself is
 * pinned in `useViewPendingSnapshot.test.tsx` (#1686).
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

		expect(screen.queryByTestId("crashed")).toBeNull();
		expect(screen.getByTestId("pending")).not.toBeNull();

		// `Promise.resolve(source)` adopts the source thenable on a microtask, so
		// flush before counting.
		await act(async () => {
			await Promise.resolve();
		});

		// Exactly 1: the dedup cache hands back the same wrapper thenable on the repeat
		// getSnapshot calls. Unpatched, each call re-adopts the source (≥ 2) or spins
		// into React #185 first.
		expect(source.then).toHaveBeenCalledTimes(1);
	});
});
