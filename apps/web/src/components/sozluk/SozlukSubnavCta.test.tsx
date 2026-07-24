/**
 * #3840 regression — the `+ yeni tanım` create dialog must survive an ancestor unmount.
 *
 * #3600 pinned the closer: with `open` in the CTA's local `useState`, an ancestor unmount
 * (the shape of `FateProvider`'s `key={userId}` re-key or `LayoutContent`'s `needsBootstrap`
 * Outlet swap) silently reset it to `false`, reproducing the CI artifact — dialog gone, no
 * backdrop, no dismiss reason, still on `/sozluk`. NO `onOpenChange` reason fires on that path
 * (React destroys the state, it is not dismissed), which is exactly how the closer is named:
 * absent reason ⇒ ancestor unmount, not `outside-press`/`escape`.
 *
 * The harness below is that unmount: a `key`-flipping boundary between the hoist provider and
 * the CTA forces a real unmount + remount of the CTA subtree. The two tests pin the artifact
 * (without the hoist) and its fix (with it).
 */
import {act, fireEvent, render, screen} from "@testing-library/react";
import * as React from "react";
import {MemoryRouter} from "react-router";
import {describe, expect, it} from "vitest";
import {SozlukCreateDialogProvider} from "./SozlukCreateDialogState";
import {SozlukSubnavCta} from "./SozlukSubnavCta";

/**
 * Renders the CTA under a `key`-flipping boundary. Calling the returned `remountSubtree`
 * flips the key, which React resolves as an unmount + remount of everything below it — the
 * ancestor-unmount #3600 pinned. `withHoist` wraps the boundary in the create-dialog provider
 * (mounted ABOVE the boundary, as `App.tsx` mounts it above `FateProvider`); without it the
 * CTA falls back to its own local state, reproducing the pre-fix fragility.
 */
function renderUnderUnmountingBoundary({withHoist}: {withHoist: boolean}) {
	let flip: () => void = () => {};
	function Harness() {
		const [key, setKey] = React.useState(0);
		flip = () => setKey((k) => k + 1);
		const boundary = (
			<div key={key}>
				<SozlukSubnavCta />
			</div>
		);
		return withHoist ? (
			<SozlukCreateDialogProvider>{boundary}</SozlukCreateDialogProvider>
		) : (
			boundary
		);
	}
	render(
		<MemoryRouter initialEntries={["/sozluk"]}>
			<Harness />
		</MemoryRouter>,
	);
	// Flush the key flip inside `act` so the unmount + remount commits before the assertion —
	// otherwise the state update is deferred and the DOM still shows the pre-flip dialog.
	return {remountSubtree: () => act(() => flip())};
}

describe("SozlukSubnavCta — #3840 open-state survives an ancestor unmount", () => {
	it("reproduces the #3600 artifact WITHOUT the hoist: an ancestor unmount vanishes the open dialog", () => {
		const {remountSubtree} = renderUnderUnmountingBoundary({withHoist: false});
		fireEvent.click(screen.getByRole("button", {name: /yeni tanım/i}));
		expect(screen.getByLabelText("Terim")).toBeTruthy();

		remountSubtree();

		// The local `useState` was destroyed with the unmounted subtree — the dialog is gone,
		// exactly the silent close #3600 pinned.
		expect(screen.queryByLabelText("Terim")).toBeNull();
	});

	it("survives the same ancestor unmount WITH the hoist — the dialog stays open", () => {
		const {remountSubtree} = renderUnderUnmountingBoundary({withHoist: true});
		fireEvent.click(screen.getByRole("button", {name: /yeni tanım/i}));
		expect(screen.getByLabelText("Terim")).toBeTruthy();

		remountSubtree();

		// `open` lives in the provider above the boundary, so the remounted CTA re-reads a
		// surviving `true` — the dialog re-appears instead of vanishing.
		expect(screen.getByLabelText("Terim")).toBeTruthy();
	});
});
