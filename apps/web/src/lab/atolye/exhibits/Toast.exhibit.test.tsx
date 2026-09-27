import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import type * as React from "react";
import {describe, expect, it} from "vitest";
import {getExhibit} from "../registry";

const exhibit = getExhibit("toast");
const message = "Değişiklikler kaydedildi.";

function raise(durationMs: number) {
	const Toast = exhibit!.component as React.ComponentType<{durationMs?: number}>;
	render(<Toast durationMs={durationMs} />);
	fireEvent.click(screen.getByRole("button", {name: "Bildirim göster"}));
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A dismissed toast leaves the DOM after zag's 200ms remove delay (`@zag-js/toast@1.43.0`
// `dist/toast.store.mjs:33`), driven by rAF timers that run slowly under jsdom.
const removalWindowMs = 2000;

// The knob is labelled `0=persistent`: a reviewer sets it to hold a toast up for inspection.
describe("Toast exhibit — the duration knob keeps its 0=persistent promise", () => {
	it("is registered under the toast slug", () => {
		expect(exhibit).toBeDefined();
	});

	it("keeps a toast raised at 0 in the DOM past the window a short toast is gone in", async () => {
		raise(0);
		await waitFor(() => expect(screen.getByText(message)).toBeTruthy());

		await pause(removalWindowMs);

		expect(screen.getByText(message)).toBeTruthy();
	});

	it("removes a toast raised at a small positive duration", async () => {
		raise(50);
		await waitFor(() => expect(screen.getByText(message)).toBeTruthy());

		await waitFor(() => expect(screen.queryByText(message)).toBeNull(), {timeout: removalWindowMs});
	});
});
