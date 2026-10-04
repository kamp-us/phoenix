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
