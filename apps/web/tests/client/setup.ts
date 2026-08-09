// Per-test DOM teardown for the `client` vitest tier (#1419). Testing Library's
// auto-cleanup only fires when Vitest globals are on; this project keeps explicit
// imports, so unmount-after-each is wired here instead, keeping each `*.test.tsx`
// isolated.
import {cleanup} from "@testing-library/react";
import {afterEach} from "vitest";

// Manti's Zag/Floating UI layers use these two browser APIs, which jsdom does not
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

afterEach(cleanup);
