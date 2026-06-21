/**
 * The `FlagGate` gating contract (#1111) — show the gated `children` iff the
 * resolved value is on, else the safe `fallback`. Before this, the gate was
 * touched only by one e2e; a `FlagGate` that stopped gating on the resolved value
 * (rendered `children` unconditionally) shipped green past everything but it.
 *
 * `flagGateChild` is the gate's decision factored DOM-free, asserted here with
 * sentinel `ReactNode`s — the pure-extraction idiom of `toProfileStatsState`
 * (`apps/web/src` has no jsdom/testing-library).
 */
import {describe, expect, it} from "vitest";
import {flagGateChild} from "./FlagGate";

describe("flagGateChild — the FlagGate render decision", () => {
	const children = "gated" as const;
	const fallback = "safe" as const;

	it("shows the gated children when the resolved value is on", () => {
		expect(flagGateChild(true, children, fallback)).toBe(children);
	});

	it("shows the fallback (the off/old/safe path) when the resolved value is off", () => {
		// The safe-default-false contract: loading / fetch-error / undeclared flag all
		// resolve to `false` upstream, so the gate shows the fallback in every one.
		expect(flagGateChild(false, children, fallback)).toBe(fallback);
	});

	it("renders nothing when off and no fallback is given (FlagGate's null default)", () => {
		expect(flagGateChild(false, children, null)).toBeNull();
	});
});
