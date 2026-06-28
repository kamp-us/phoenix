/**
 * First component/DOM smoke test of the SPA seam (#1419): render the `Screen`
 * error boundary through its real React interface and pin both halves of its
 * code-forwarding contract — the boundary forwards a fate error's `.code`
 * verbatim, and falls a non-fate throw back to `INTERNAL_SERVER_ERROR`. Asserted
 * only by comments before this tier existed (see `Screen.tsx`).
 */
import {render, screen} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {Screen} from "./Screen";

// Throw on render so the error reaches the boundary's `getDerivedStateFromError`.
function Boom({error}: {error: unknown}): never {
	throw error;
}

describe("Screen — error boundary forwards the thrown wire code", () => {
	// React logs caught render errors to console.error; silence it so the smoke
	// test's output stays clean (and restore so other tiers are unaffected).
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("forwards a fate error's `.code` verbatim", () => {
		render(
			<Screen fallback={<div>loading</div>} error={({code}) => <div>{`code: ${code}`}</div>}>
				<Boom error={{code: "POST_NOT_FOUND"}} />
			</Screen>,
		);
		expect(screen.getByText("code: POST_NOT_FOUND")).toBeTruthy();
	});

	it("falls a non-fate throw back to INTERNAL_SERVER_ERROR", () => {
		render(
			<Screen fallback={<div>loading</div>} error={({code}) => <div>{`code: ${code}`}</div>}>
				<Boom error={new Error("kaboom")} />
			</Screen>,
		);
		expect(screen.getByText("code: INTERNAL_SERVER_ERROR")).toBeTruthy();
	});
});
