// Client-test DOM setup shared by the design package's component and a11y tiers.
import {cleanup} from "@testing-library/react";
import {afterAll, afterEach} from "vitest";

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

afterAll(async () => {
	await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
	await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
	await new Promise((resolve) => setTimeout(resolve, 0));
});
