// #3840 regression — the create dialog must survive an ancestor unmount; see
// `SozlukCreateDialogState` for the why.
import {act, fireEvent, render, screen} from "@testing-library/react";
import * as React from "react";
import {MemoryRouter} from "react-router";
import {describe, expect, it} from "vitest";
import {SozlukCreateDialogProvider} from "./SozlukCreateDialogState";
import {SozlukSubnavCta} from "./SozlukSubnavCta";

/**
 * Renders the CTA under a `key`-flipping boundary. Calling the returned `remountSubtree`
 * flips the key, which React resolves as an unmount + remount of everything below it — the
 * ancestor-unmount #3600 pinned. The create-dialog provider sits ABOVE the boundary, as
 * `App.tsx` mounts it above `FateProvider`.
 */
function renderUnderUnmountingBoundary() {
	let flip: () => void = () => {};
	function Harness() {
		const [key, setKey] = React.useState(0);
		flip = () => setKey((k) => k + 1);
		return (
			<SozlukCreateDialogProvider>
				<div key={key}>
					<SozlukSubnavCta />
				</div>
			</SozlukCreateDialogProvider>
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
	it("survives the same ancestor unmount WITH the hoist — the dialog stays open", async () => {
		const {remountSubtree} = renderUnderUnmountingBoundary();
		fireEvent.click(screen.getByRole("button", {name: /yeni tanım/i}));
		expect(await screen.findByLabelText(/Terim/)).toBeTruthy();

		remountSubtree();

		expect(await screen.findByLabelText(/Terim/)).toBeTruthy();
	});
});
