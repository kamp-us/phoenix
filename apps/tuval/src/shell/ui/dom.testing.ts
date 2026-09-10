/**
 * What jsdom does not ship and this slice's component tests need. A colocated `*.testing.ts` is
 * where the two tiers put a platform fake (`.patterns/effect-testing.md`), and it is outside the
 * `*.unit.test.*` glob, so nothing here runs as a test.
 *
 * The three gaps are jsdom's, not React's. There is no `ResizeObserver` and no `PointerEvent`, and
 * every element measures 0×0 — and `react-resizable-panels` needs all three: it sizes a group from
 * a `ResizeObserver` callback and refuses to resize a group it has never measured ("Previous layout
 * not found for panel index 0"). So the observer here *fires* from `observe()`, with the box below;
 * a stub that only records the callback leaves the library permanently unmeasured. A test that needs
 * a row to *grow* after that — a streaming message — names the new height through
 * `growObservedElement`.
 *
 * A separator is the one element that does not report that box. The library hit-tests every pointer
 * event against each separator's measured rect, so a separator measuring the whole viewport claims
 * every press anywhere on the desk — it flips itself to `data-separator="active"` and takes DOM
 * focus, which is a lie about a 4px divider and would have hidden the pointer-focus path under a
 * geometry artifact (#7848). It gets a band instead, away from the origin synthetic pointer events
 * report; a test that means to press one still targets the element directly.
 *
 * The `afterEach(cleanup)` is here rather than in a runner setup file because this project keeps
 * Vitest globals off, which is what Testing Library's auto-cleanup needs to fire on its own.
 */

import {cleanup} from "@testing-library/react";
import {afterEach} from "vitest";

/** The one box every element reports. Square, so a row and a column both have room to split. */
export const TEST_VIEWPORT = {width: 1000, height: 1000} as const;

const rectAt = (left: number, right: number): DOMRect =>
	({
		x: left,
		y: 0,
		top: 0,
		left,
		right,
		bottom: TEST_VIEWPORT.height,
		width: right - left,
		height: TEST_VIEWPORT.height,
		toJSON: () => ({}),
	}) as DOMRect;

const box = (): DOMRect => rectAt(0, TEST_VIEWPORT.width);

/** The separator's band: the painted 4px hairline, mid-viewport. */
const SEPARATOR_BAND = {left: 500, right: 504} as const;

const measure = (element: Element): DOMRect =>
	element.getAttribute("role") === "separator"
		? rectAt(SEPARATOR_BAND.left, SEPARATOR_BAND.right)
		: box();

const entryAt = (target: Element, blockSize: number): ResizeObserverEntry => {
	const size: ResizeObserverSize = {blockSize, inlineSize: TEST_VIEWPORT.width};
	return {
		target,
		contentRect: rectAt(0, TEST_VIEWPORT.width),
		borderBoxSize: [size],
		contentBoxSize: [size],
		devicePixelContentBoxSize: [size],
	};
};

/** Live observers, so `growObservedElement` can reach the ones already watching an element. */
const observers = new Set<MeasuringResizeObserver>();

class MeasuringResizeObserver implements ResizeObserver {
	// A field and an assignment rather than a parameter property: `erasableSyntaxOnly` is on
	// repo-wide (`.patterns/erasable-typescript-syntax.md`).
	readonly callback: ResizeObserverCallback;
	readonly observed = new Set<Element>();

	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
		observers.add(this);
	}

	observe(target: Element): void {
		// Re-add: a real `ResizeObserver` may be disconnected and observed again, and only the
		// constructor put this one in the registry — without this, an observer that went through that
		// cycle is unreachable from `growObservedElement`, which would then silently notify nobody.
		observers.add(this);
		this.observed.add(target);
		this.callback([entryAt(target, TEST_VIEWPORT.height)], this);
	}

	unobserve(target: Element): void {
		this.observed.delete(target);
	}

	disconnect(): void {
		this.observed.clear();
		observers.delete(this);
	}
}

/**
 * Grow an already-observed element to `height` and notify: the streaming case, where a row keeps the
 * key it had and gets taller. Both halves are needed — a consumer that re-measures synchronously
 * reads `getBoundingClientRect` rather than the entry (`@tanstack/virtual-core@3.17.8`,
 * `measureElement`), which would undo the growth on the next render. The rect is overridden on the
 * element itself so the box every other element reports stays the one flat answer above.
 *
 * Growing an element nobody observes throws rather than returning quietly: a test that asserts "the
 * window did not scroll" would otherwise stay green after a refactor stopped the row from being
 * measured at all, which is the assertion passing for the wrong reason.
 */
export const growObservedElement = (element: Element, height: number): void => {
	const watching = [...observers].filter((observer) => observer.observed.has(element));
	if (watching.length === 0) {
		throw new Error("growObservedElement: no ResizeObserver is watching this element");
	}
	const grown = {...rectAt(0, TEST_VIEWPORT.width), bottom: height, height, toJSON: () => ({})};
	Object.defineProperty(element, "getBoundingClientRect", {
		configurable: true,
		value: (): DOMRect => grown as DOMRect,
	});
	for (const observer of watching) observer.callback([entryAt(element, height)], observer);
};

/**
 * A do-nothing `IntersectionObserver`, which jsdom also lacks.
 *
 * `@floating-ui/dom`'s `autoUpdate` builds one to watch a popup's anchor
 * (`floating-ui.dom.mjs`, `observeMove`), and `@zag-js/popper` calls `autoUpdate` from inside a
 * `raf` — so a portaled Manti primitive that was opened and then unmounted schedules the
 * construction *after* the test that opened it, and the `ReferenceError` lands as an unhandled
 * rejection Vitest collects against a green run (`.patterns/zag-machine-interaction-tests.md`, the
 * mirror-image section). Nothing here needs the callback to fire: no test asserts a popup's
 * position, and jsdom has no layout to observe a change in.
 */
class NoopIntersectionObserver implements IntersectionObserver {
	readonly root = null;
	readonly rootMargin = "";
	readonly scrollMargin = "";
	readonly thresholds: ReadonlyArray<number> = [];

	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
	takeRecords(): Array<IntersectionObserverEntry> {
		return [];
	}
}

/** Call once at the top of a component test file, before `render`. */
export const installDomShims = (): void => {
	const scope = globalThis as Record<string, unknown>;
	scope.ResizeObserver = MeasuringResizeObserver;
	scope.IntersectionObserver ??= NoopIntersectionObserver;
	scope.PointerEvent ??= globalThis.MouseEvent;
	Element.prototype.getBoundingClientRect = function measured(this: Element): DOMRect {
		return measure(this);
	};
	Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};
	// jsdom 26 constructs a `CSSStyleSheet` but implements neither `replaceSync` nor
	// `adoptedStyleSheets`, and a custom element that adopts its own sheet in its constructor
	// (`@pierre/diffs`, behind the design `Diff`) throws there. Same shim as the design package's
	// own `test-setup.ts`.
	CSSStyleSheet.prototype.replaceSync ??= function replaceSync(): void {};
	Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
		configurable: true,
		get: () => TEST_VIEWPORT.width,
	});
	Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
		configurable: true,
		get: () => TEST_VIEWPORT.height,
	});
	afterEach(() => {
		cleanup();
		// An observer whose owner never disconnected still holds its targets, and the registry is
		// module-level: without this one test's detached rows outlive it.
		observers.clear();
	});
};
