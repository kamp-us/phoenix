/**
 * What jsdom does not ship and this slice's component tests need. A colocated `*.testing.ts` is
 * where the two tiers put a platform fake (`.patterns/effect-testing.md`), and it is outside the
 * `*.unit.test.*` glob, so nothing here runs as a test.
 *
 * The three gaps are jsdom's, not React's. There is no `ResizeObserver` and no `PointerEvent`, and
 * every element measures 0×0 — and `react-resizable-panels` needs all three: it sizes a group from
 * a `ResizeObserver` callback and refuses to resize a group it has never measured ("Previous layout
 * not found for panel index 0"). So the observer here *fires*, once, with the box below; a stub
 * that only records the callback leaves the library permanently unmeasured.
 *
 * The `afterEach(cleanup)` is here rather than in a runner setup file because this project keeps
 * Vitest globals off, which is what Testing Library's auto-cleanup needs to fire on its own.
 */

import {cleanup} from "@testing-library/react";
import {afterEach} from "vitest";

/** The one box every element reports. Square, so a row and a column both have room to split. */
export const TEST_VIEWPORT = {width: 1000, height: 1000} as const;

const box = (): DOMRect =>
	({
		x: 0,
		y: 0,
		top: 0,
		left: 0,
		right: TEST_VIEWPORT.width,
		bottom: TEST_VIEWPORT.height,
		width: TEST_VIEWPORT.width,
		height: TEST_VIEWPORT.height,
		toJSON: () => ({}),
	}) as DOMRect;

class MeasuringResizeObserver implements ResizeObserver {
	// A field and an assignment rather than a parameter property: `erasableSyntaxOnly` is on
	// repo-wide (`.patterns/erasable-typescript-syntax.md`).
	readonly callback: ResizeObserverCallback;

	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
	}

	observe(target: Element): void {
		const size: ResizeObserverSize = {
			blockSize: TEST_VIEWPORT.height,
			inlineSize: TEST_VIEWPORT.width,
		};
		const entry: ResizeObserverEntry = {
			target,
			contentRect: box(),
			borderBoxSize: [size],
			contentBoxSize: [size],
			devicePixelContentBoxSize: [size],
		};
		this.callback([entry], this);
	}

	unobserve(): void {}
	disconnect(): void {}
}

/** Call once at the top of a component test file, before `render`. */
export const installDomShims = (): void => {
	const scope = globalThis as Record<string, unknown>;
	scope.ResizeObserver = MeasuringResizeObserver;
	scope.PointerEvent ??= globalThis.MouseEvent;
	Element.prototype.getBoundingClientRect = box;
	Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};
	Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
		configurable: true,
		get: () => TEST_VIEWPORT.width,
	});
	Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
		configurable: true,
		get: () => TEST_VIEWPORT.height,
	});
	afterEach(cleanup);
};
