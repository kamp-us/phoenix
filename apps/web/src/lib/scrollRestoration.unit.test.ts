import {describe, expect, it} from "vitest";
import {scrollIntent} from "./scrollRestoration";

describe("scrollIntent", () => {
	it("restores the saved offset on a back/forward navigation", () => {
		expect(scrollIntent({navigation: "pop", hash: "", saved: 820})).toEqual({
			kind: "restore",
			top: 820,
		});
	});

	it("treats a saved 0 as a real offset, not as an absent one", () => {
		expect(scrollIntent({navigation: "pop", hash: "", saved: 0})).toEqual({
			kind: "restore",
			top: 0,
		});
	});

	it("leaves the viewport alone on a POP with nothing saved — the first load of a tab", () => {
		expect(scrollIntent({navigation: "pop", hash: "", saved: undefined})).toEqual({kind: "none"});
	});

	it("leaves a POP to a fragment alone when that entry was never scrolled", () => {
		expect(scrollIntent({navigation: "pop", hash: "#main", saved: undefined})).toEqual({
			kind: "none",
		});
	});

	it("lands a forward navigation at the top", () => {
		expect(scrollIntent({navigation: "push", hash: "", saved: 900})).toEqual({kind: "top"});
	});

	it("sends a forward navigation to the fragment it names", () => {
		expect(scrollIntent({navigation: "push", hash: "#comments", saved: undefined})).toEqual({
			kind: "anchor",
			id: "comments",
		});
	});

	it("leaves a replace alone — it corrects the entry the reader is already on", () => {
		expect(scrollIntent({navigation: "replace", hash: "", saved: undefined})).toEqual({
			kind: "none",
		});
	});
});
