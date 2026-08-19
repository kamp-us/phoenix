/**
 * Pins both halves of `Screen`'s code-forwarding contract through its real React
 * interface (#1419).
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
