/**
 * Regression for #1686: react-fate `useView`'s `getSnapshot` must return a STABLE
 * thenable while a view snapshot is non-fulfilled. Unpatched 1.3.1 built a fresh
 * `Promise.resolve(snapshot).then(…)` on every call in that branch, so
 * `useSyncExternalStore` saw a new snapshot per check → infinite re-render
 * (React #185, "getSnapshot should be cached") → the fate `Screen` boundary swapped
 * the whole term page for its error branch whenever an entity-delete live frame
 * landed while a `DefinitionCard` was still mounted. Fixed by
 * `patches/react-fate@1.3.1.patch` (ADR 0038), which mirrors the deferred branch's
 * `pendingRef` caching. This drives the hook through a mounted component whose
 * record goes non-fulfilled mid-flight and asserts it suspends instead of looping.
 */

import {act, render, screen, waitFor} from "@testing-library/react";
import * as React from "react";
import {FateClient, useView, view} from "react-fate";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

type TestEntity = {__typename: "TestEntity"; id: string; name: string};
const TestView = view<TestEntity>()({id: true, name: true});

const REF = {__typename: "TestEntity", id: "1"} as const;

type Snapshot = {data: TestEntity | null; coverage: ReadonlyArray<readonly [string, unknown]>};

function fulfilled(value: Snapshot) {
	return {
		status: "fulfilled" as const,
		// biome-ignore lint/suspicious/noThenProperty: intentionally a thenable — fate's fulfilled-snapshot shape, read by React `use()`
		then: (onfulfilled?: (v: Snapshot) => unknown, onrejected?: (e: unknown) => unknown) =>
			Promise.resolve(value).then(onfulfilled, onrejected),
		value,
	};
}

function snapshotOf(name: string): Snapshot {
	return {
		data: {__typename: "TestEntity", id: "1", name},
		coverage: [["TestEntity:1", ["name"]]],
	};
}

// `useView` only touches `client.readView` + `client.store.subscribe`; a hand-rolled
// stub whose snapshot we swap per-step is the whole harness. The store-change
// listeners stand in for the live frames (entity delete → non-fulfilled refetch).
function makeClient(initial: unknown) {
	const listeners = new Set<() => void>();
	let snapshot = initial;
	return {
		client: {
			readView: () => snapshot,
			store: {
				subscribe: (_entityId: string, _paths: unknown, onChange: () => void) => {
					listeners.add(onChange);
					return () => listeners.delete(onChange);
				},
			},
		},
		setSnapshot(next: unknown) {
			snapshot = next;
			for (const notify of [...listeners]) notify();
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

describe("useView on a record whose snapshot goes non-fulfilled while mounted (#1686)", () => {
	beforeEach(() => {
		// React logs the boundary-caught error (and, unpatched, the getSnapshot
		// caching warning) via console.error; keep the run output clean.
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("suspends on a stable thenable instead of looping into React #185", async () => {
		const {client, setSnapshot} = makeClient(fulfilled(snapshotOf("neo")));
		render(
			<Boundary>
				<FateClient client={client as never}>
					<React.Suspense fallback={<div data-testid="pending">yükleniyor</div>}>
						<Probe />
					</React.Suspense>
				</FateClient>
			</Boundary>,
		);
		expect(screen.getByTestId("name").textContent).toBe("neo");

		// The entity-delete frame: the record vanishes and the refetch is in flight,
		// so `client.readView` now returns the SAME pending promise on every call —
		// exactly the fate client's stable `pending`-map behavior.
		const inFlight = new Promise<never>(() => {});
		act(() => setSnapshot(inFlight));

		// Unpatched, the fresh-Promise-per-getSnapshot loop throws "Maximum update
		// depth exceeded" synchronously and the boundary catches it.
		expect(screen.queryByTestId("crashed")).toBeNull();

		// Recovery: a later fulfilled snapshot (the live-update path) still renders —
		// the pending-thenable cache must not stick once the source snapshot changes.
		act(() => setSnapshot(fulfilled(snapshotOf("trinity"))));
		await waitFor(() => expect(screen.getByTestId("name").textContent).toBe("trinity"));
		expect(screen.queryByTestId("crashed")).toBeNull();
	});
});
