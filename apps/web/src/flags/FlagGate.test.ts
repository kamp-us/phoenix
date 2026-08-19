/**
 * The `FlagGate` gating contract (#1111), asserted through the DOM-free `flagGateChild` with
 * sentinel `ReactNode`s — `apps/web/src` has no jsdom/testing-library.
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
		expect(flagGateChild(false, children, fallback)).toBe(fallback);
	});

	it("renders nothing when off and no fallback is given (FlagGate's null default)", () => {
		expect(flagGateChild(false, children, null)).toBeNull();
	});
});
