import {describe, expect, it} from "vitest";
import {type ScrollIntent, type ScrollIntentInput, scrollIntent} from "./scrollRestoration";

/** A navigation somewhere inside a session — the cold load is the one case that says otherwise. */
function intent(input: Omit<ScrollIntentInput, "isFirstNavigation">): ScrollIntent {
	return scrollIntent({...input, isFirstNavigation: false});
}

describe("scrollIntent", () => {
	it("treats a saved 0 as a real offset, not as an absent one", () => {
		expect(intent({navigation: "pop", hash: "", saved: 0})).toEqual({
			kind: "restore",
			top: 0,
		});
	});

	it("leaves a cold deep link's fragment to the browser", () => {
		expect(
			scrollIntent({navigation: "pop", hash: "#main", saved: undefined, isFirstNavigation: true}),
		).toEqual({kind: "none"});
	});

	it("sends a POP to a never-scrolled fragment entry back to that fragment", () => {
		expect(intent({navigation: "pop", hash: "#main", saved: undefined})).toEqual({
			kind: "anchor",
			id: "main",
		});
	});

	it("keeps standing down on a POP back to a comment permalink the reader never scrolled", () => {
		expect(intent({navigation: "pop", hash: "#comment-abc123", saved: undefined})).toEqual({
			kind: "top",
		});
	});

	it("keeps claiming a fragment no page owns, even next to the comment family", () => {
		expect(intent({navigation: "push", hash: "#commentary", saved: undefined})).toEqual({
			kind: "anchor",
			id: "commentary",
		});
	});
});
