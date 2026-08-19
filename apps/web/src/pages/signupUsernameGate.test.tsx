import {act, renderHook} from "@testing-library/react";
import {afterEach, describe, expect, it} from "vitest";
import {
	beginUsernameResolution,
	endUsernameResolution,
	useUsernameResolutionPending,
} from "./signupUsernameGate";

afterEach(() => {
	// Leave the module-level latch clear so tests don't bleed into each other.
	endUsernameResolution();
});

describe("signupUsernameGate — the redirect hold latch", () => {
	it("starts clear so a plain signed-in visit to /auth redirects", () => {
		const {result} = renderHook(() => useUsernameResolutionPending());
		expect(result.current).toBe(false);
	});

	it("latches on begin (redirect holds) and clears on end (redirect proceeds)", () => {
		const {result} = renderHook(() => useUsernameResolutionPending());
		act(() => beginUsernameResolution());
		expect(result.current).toBe(true);
		act(() => endUsernameResolution());
		expect(result.current).toBe(false);
	});

	it("is idempotent: a second begin/end is a no-op, not a toggle", () => {
		const {result} = renderHook(() => useUsernameResolutionPending());
		act(() => {
			beginUsernameResolution();
			beginUsernameResolution();
		});
		expect(result.current).toBe(true);
		act(() => {
			endUsernameResolution();
			endUsernameResolution();
		});
		expect(result.current).toBe(false);
	});
});
