// Per-test DOM teardown for the `client` vitest tier (#1419). Testing Library's
// auto-cleanup only fires when Vitest globals are on; this project keeps explicit
// imports, so unmount-after-each is wired here instead, keeping each `*.test.tsx`
// isolated.
import {cleanup} from "@testing-library/react";
import {afterAll, afterEach} from "vitest";

// Manti's Zag/Floating UI layers use these browser APIs, which jsdom does not
// provide. These are behaviourally inert shims with the right interface, enough to
// let the client test tier mount those components.
if (typeof globalThis.PointerEvent === "undefined") {
	class PointerEventShim extends MouseEvent {
		readonly pointerType: string;

		constructor(type: string, init: PointerEventInit = {}) {
			super(type, init);
			this.pointerType = init.pointerType ?? "";
		}
	}
	globalThis.PointerEvent = PointerEventShim as typeof PointerEvent;
}

if (typeof globalThis.ResizeObserver === "undefined") {
	class ResizeObserverShim implements ResizeObserver {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	globalThis.ResizeObserver = ResizeObserverShim;
}

if (typeof Element.prototype.scrollIntoView === "undefined") {
	Element.prototype.scrollIntoView = () => undefined;
}

afterEach(cleanup);

// Zag schedules DOM work past the unmount that should have ended it, and nothing cancels it:
// `dialog.machine.mjs` `checkRenderedElements` discards the cancel handle `raf()` returns, and
// focus-trap's `deactivate()` restores focus on a `setTimeout(fn, 0)`. Either can still be pending
// when Vitest tears the jsdom environment down at the end of a file, and both resolve their root
// through `@zag-js/core` `createScope`, whose `props.getRootNode?.() ?? document` is a BARE global
// read — with the global gone that throws `ReferenceError` instead of yielding `undefined`, and
// Vitest collects it as an unhandled error that reds a fully-green run (#6166). Draining the queues
// here runs that work inside the environment's life. Two frames, because `raf.mjs` `nextTick`
// double-nests; then a macrotask for the focus-trap timer.
afterAll(async () => {
	await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
	await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
	await new Promise((resolve) => setTimeout(resolve, 0));
});
