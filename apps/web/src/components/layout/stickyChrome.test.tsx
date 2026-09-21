import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {render} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {type StickyChromeBar, useStickyChromeHeight} from "./stickyChrome";

// The relative path goes through a variable, matching `Subnav.test.tsx`: a literal
// `new URL("./x.css", import.meta.url)` is statically rewritten into an asset URL by Vite's
// asset transform, and `fileURLToPath` then refuses the `http:` scheme it produced.
const readSource = (rel: string): string =>
	readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const STICKY_CHROME_CSS = readSource("./stickyChrome.css");

/**
 * jsdom lays nothing out, so the bar's height is whatever this says — and the hook reads it
 * through `getBoundingClientRect`, which is the seam these tests drive. A ResizeObserver that
 * never fires (the client tier's inert shim) would make the re-measure assertion vacuous, so this
 * file installs one that does.
 */
let measuredHeight = 38;
let observed: Array<{owner: ResizeObserver; target: Element; fire: () => void}> = [];

class RecordingResizeObserver implements ResizeObserver {
	// A plain field, not a constructor parameter property: this tree compiles under
	// `erasableSyntaxOnly`, which rejects the shorthand.
	readonly callback: ResizeObserverCallback;
	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
	}
	observe(target: Element) {
		observed.push({owner: this, target, fire: () => this.callback([], this)});
	}
	unobserve(target: Element) {
		observed = observed.filter((o) => o.owner !== this || o.target !== target);
	}
	disconnect() {
		observed = observed.filter((o) => o.owner !== this);
	}
}

function Bar({bar}: {bar: StickyChromeBar}) {
	const ref = useStickyChromeHeight<HTMLDivElement>(bar);
	return <div ref={ref} data-testid="bar" />;
}

const publishedOffset = (property: string) =>
	document.documentElement.style.getPropertyValue(property);

describe("sticky chrome measured offsets (#7730)", () => {
	const realResizeObserver = globalThis.ResizeObserver;

	beforeEach(() => {
		measuredHeight = 38;
		observed = [];
		globalThis.ResizeObserver = RecordingResizeObserver;
		vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
			() => ({height: measuredHeight}) as DOMRect,
		);
	});

	afterEach(() => {
		globalThis.ResizeObserver = realResizeObserver;
		document.documentElement.removeAttribute("style");
		vi.restoreAllMocks();
	});

	it("publishes the bar's rendered height, not a token, on mount", () => {
		measuredHeight = 84;
		render(<Bar bar="topbar" />);
		expect(publishedOffset("--kp-topbar-measured-h")).toBe("84px");
	});

	it("each bar publishes to its own property", () => {
		measuredHeight = 61;
		render(<Bar bar="subnav" />);
		expect(publishedOffset("--kp-subnav-measured-h")).toBe("61px");
		expect(publishedOffset("--kp-topbar-measured-h")).toBe("");
	});

	it("re-measures whenever the bar's box changes, instead of reading it once at load", () => {
		// This is the whole point of the observer: the topbar wraps search onto a second row at
		// 640px and below, and it also grows on a text-zoom or root-font-size change. An offset
		// measured once at load is wrong after every one of those.
		render(<Bar bar="topbar" />);
		expect(publishedOffset("--kp-topbar-measured-h")).toBe("38px");

		measuredHeight = 76;
		for (const o of observed) o.fire();

		expect(publishedOffset("--kp-topbar-measured-h")).toBe("76px");
	});

	it("observes the bar element itself, the one the sticky rule targets", () => {
		const {getByTestId} = render(<Bar bar="topbar" />);
		expect(observed.map((o) => o.target)).toEqual([getByTestId("bar")]);
	});

	it("withdraws the offset when the bar unmounts", () => {
		// A page that renders no subnav owes no subnav offset; a stale last measurement would
		// push its scroll anchor down by the height of a bar that is not there.
		const {unmount} = render(<Bar bar="subnav" />);
		expect(publishedOffset("--kp-subnav-measured-h")).toBe("38px");
		unmount();
		expect(publishedOffset("--kp-subnav-measured-h")).toBe("");
	});
});

describe("sticky chrome stylesheet (#7730)", () => {
	it("declares what each offset resolves to before its first measurement", () => {
		// The refs have to resolve with JS not yet run and on a page with no subnav, and neither
		// default may be a guess at a wrapped bar's height: the topbar's own one-row token, and
		// nothing at all for an absent subnav.
		expect(STICKY_CHROME_CSS).toMatch(
			/:root\s*\{[^}]*--kp-topbar-measured-h:\s*var\(--topbar-h\)/s,
		);
		expect(STICKY_CHROME_CSS).toMatch(/:root\s*\{[^}]*--kp-subnav-measured-h:\s*0px/s);
	});

	it("moves the scroll anchor clear of both bars from the same measured offsets", () => {
		// WCAG 2.4.11: without this a tab stop or an in-page anchor target is scrolled to the top
		// of the viewport and comes to rest under the sticky chrome.
		expect(STICKY_CHROME_CSS).toMatch(
			/html\s*\{[^}]*scroll-padding-top:\s*calc\(\s*var\(--kp-topbar-measured-h\)\s*\+\s*var\(--kp-subnav-measured-h\)\s*\)/s,
		);
	});
});
