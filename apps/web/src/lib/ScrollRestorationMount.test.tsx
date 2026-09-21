import {act, fireEvent, render, screen} from "@testing-library/react";
import {StrictMode} from "react";
import {MemoryRouter, useNavigate} from "react-router";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {ScrollRestorationMount} from "./ScrollRestorationMount";

// `window.scrollY` is read-only in the DOM lib — a real browser moves it by scrolling, which
// jsdom does not do. Redefining the property is what lets this file stand in for a viewport.
function setScrollY(top: number): void {
	Object.defineProperty(window, "scrollY", {value: top, writable: true, configurable: true});
}

/**
 * A viewport whose scrollable height is a knob. jsdom performs no layout, so the clamp a real
 * browser applies to a scroll past the document's end is modelled here — it is the whole
 * subject of the settle test below.
 */
function installViewport(): {
	calls: ScrollToOptions[];
	setMaxScroll: (max: number) => void;
	readerScrollsTo: (top: number) => void;
} {
	const calls: ScrollToOptions[] = [];
	let maxScroll = 10_000;
	const land = (top: number) => {
		setScrollY(Math.max(0, Math.min(top, maxScroll)));
		window.dispatchEvent(new Event("scroll"));
	};
	vi.stubGlobal("scrollTo", (options: ScrollToOptions) => {
		calls.push(options);
		land(options.top ?? 0);
	});
	return {
		calls,
		setMaxScroll: (max) => {
			maxScroll = max;
		},
		readerScrollsTo: land,
	};
}

function Harness() {
	const navigate = useNavigate();
	return (
		<>
			<button type="button" onClick={() => navigate("/pano/1")}>
				push
			</button>
			<button type="button" onClick={() => navigate("/pano/1#comments")}>
				push-anchor
			</button>
			<button type="button" onClick={() => navigate("/pano/1#not-here")}>
				push-missing-anchor
			</button>
			<button type="button" onClick={() => navigate("/pano?sort=top", {replace: true})}>
				replace
			</button>
			<button type="button" onClick={() => navigate(-1)}>
				back
			</button>
			<button type="button" onClick={() => navigate("/pano/1#comment-42")}>
				push-comment-permalink
			</button>
			<div id="comments">yorumlar</div>
			{/* The one fragment family that already has a live handler behind it: the comment node
			    `PanoPostDetail`'s `useCommentAnchor` centres. */}
			<div id="comment-42">bir yorum</div>
		</>
	);
}

function renderApp(strict = false) {
	const tree = (
		<MemoryRouter initialEntries={["/pano"]}>
			<ScrollRestorationMount />
			<Harness />
		</MemoryRouter>
	);
	return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

async function nextFrame(): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
	});
}

function click(name: string): void {
	fireEvent.click(screen.getByRole("button", {name}));
}

describe("ScrollRestorationMount", () => {
	let viewport: ReturnType<typeof installViewport>;

	beforeEach(() => {
		window.history.scrollRestoration = "auto";
		setScrollY(0);
		viewport = installViewport();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		setScrollY(0);
	});

	it("takes scroll restoration off the browser while it is mounted, and hands it back", () => {
		const {unmount} = renderApp();
		expect(window.history.scrollRestoration).toBe("manual");
		unmount();
		expect(window.history.scrollRestoration).toBe("auto");
	});

	it("lands a forward navigation at the top", () => {
		renderApp();
		viewport.readerScrollsTo(640);
		click("push");
		expect(viewport.calls.at(-1)).toEqual({top: 0, left: 0, behavior: "instant"});
		expect(window.scrollY).toBe(0);
	});

	it("puts the offset back when the reader comes back", () => {
		renderApp();
		viewport.readerScrollsTo(640);
		click("push");
		expect(window.scrollY).toBe(0);
		click("back");
		expect(window.scrollY).toBe(640);
	});

	it("lands the reader at the top coming back to an entry they never scrolled", () => {
		// The feed opens at 0 and the reader clicks the first post without scrolling, so the feed's
		// entry has no saved row. Before this arm existed the hook read that absence as "leave the
		// viewport alone" and the feed came back carrying the post's offset (#9268).
		renderApp();
		click("push");
		viewport.readerScrollsTo(1200);
		click("back");
		expect(window.scrollY).toBe(0);
	});

	it("never scrolls on the cold load, including under StrictMode's double mount", () => {
		// The cold load is a POP with nothing saved too, and there the entry is the browser's:
		// a deep link's own fragment handling has to survive. StrictMode runs the effect twice for
		// that one navigation, and the second run must not read as an arrival.
		renderApp(true);
		expect(viewport.calls).toEqual([]);
	});

	it("keeps re-applying the offset while the feed gets its height back", async () => {
		renderApp();
		viewport.readerScrollsTo(640);
		click("push");
		// The feed paints 0 rows on the frame it remounts, so the restore clamps to the top.
		viewport.setMaxScroll(0);
		click("back");
		expect(window.scrollY).toBe(0);

		viewport.setMaxScroll(10_000);
		await nextFrame();
		expect(window.scrollY).toBe(640);
	});

	it("leaves the viewport alone on a replace — it is not an arrival", () => {
		renderApp();
		viewport.readerScrollsTo(640);
		const before = viewport.calls.length;
		click("replace");
		expect(viewport.calls.length).toBe(before);
		expect(window.scrollY).toBe(640);
	});

	it("sends a hash link to its fragment instead of the offset the reader left", () => {
		const scrollIntoView = vi
			.spyOn(Element.prototype, "scrollIntoView")
			.mockImplementation(() => undefined);
		renderApp();
		viewport.readerScrollsTo(640);
		click("push-anchor");
		expect(scrollIntoView).toHaveBeenCalledWith({behavior: "instant", block: "start"});
		scrollIntoView.mockRestore();
	});

	it("never touches a comment permalink's node — that page scrolls it itself", async () => {
		// `PanoPostDetail` runs `useCommentAnchor` on `#comment-<id>` and centres the node when it
		// mounts. If this hook also scrolled it, the resting position would be whichever of the two
		// landed last. It lands the arrival at the top and leaves the element alone (#9268).
		const scrollIntoView = vi
			.spyOn(Element.prototype, "scrollIntoView")
			.mockImplementation(() => undefined);
		renderApp();
		viewport.readerScrollsTo(640);
		click("push-comment-permalink");
		expect(window.scrollY).toBe(0);
		// A settle would keep re-applying across frames, so the next frame is where a second
		// authority would show up.
		await nextFrame();
		expect(scrollIntoView).not.toHaveBeenCalled();
		expect(window.scrollY).toBe(0);
		scrollIntoView.mockRestore();
	});

	it("still starts a hash link's page at the top while its fragment has yet to mount", () => {
		renderApp();
		viewport.readerScrollsTo(640);
		click("push-missing-anchor");
		expect(window.scrollY).toBe(0);
	});

	it("never animates the scroll, so there is no motion to suppress under reduced motion", () => {
		renderApp();
		viewport.readerScrollsTo(640);
		click("push");
		click("back");
		expect(viewport.calls.length).toBeGreaterThan(0);
		for (const call of viewport.calls) expect(call.behavior).toBe("instant");
	});

	it("survives StrictMode's double mount — the app runs under it", () => {
		renderApp(true);
		expect(window.history.scrollRestoration).toBe("manual");
		viewport.readerScrollsTo(640);
		click("push");
		expect(window.scrollY).toBe(0);
		click("back");
		expect(window.scrollY).toBe(640);
	});

	it("moves the window without taking focus off what the reader is on", () => {
		renderApp();
		const back = screen.getByRole("button", {name: "back"});
		viewport.readerScrollsTo(640);
		click("push");
		back.focus();
		click("back");
		expect(window.scrollY).toBe(640);
		expect(document.activeElement).toBe(back);
	});
});
