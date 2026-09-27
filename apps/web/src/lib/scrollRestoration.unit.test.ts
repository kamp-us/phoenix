import {describe, expect, it} from "vitest";
import {type ScrollIntent, type ScrollIntentInput, scrollIntent} from "./scrollRestoration";

/** A navigation somewhere inside a session — the cold load is the one case that says otherwise. */
function intent(input: Omit<ScrollIntentInput, "isFirstNavigation">): ScrollIntent {
	return scrollIntent({...input, isFirstNavigation: false});
}

describe("scrollIntent", () => {
	it("restores the saved offset on a back/forward navigation", () => {
		expect(intent({navigation: "pop", hash: "", saved: 820})).toEqual({
			kind: "restore",
			top: 820,
		});
	});

	it("treats a saved 0 as a real offset, not as an absent one", () => {
		expect(intent({navigation: "pop", hash: "", saved: 0})).toEqual({
			kind: "restore",
			top: 0,
		});
	});

	it("leaves the viewport alone on the session's first navigation — the cold load of a tab", () => {
		expect(
			scrollIntent({navigation: "pop", hash: "", saved: undefined, isFirstNavigation: true}),
		).toEqual({kind: "none"});
	});

	it("leaves a cold deep link's fragment to the browser", () => {
		expect(
			scrollIntent({navigation: "pop", hash: "#main", saved: undefined, isFirstNavigation: true}),
		).toEqual({kind: "none"});
	});

	it("lands a POP to an entry this session never scrolled at the top, not on the offset the reader is leaving", () => {
		// The feed opened at 0 and was left without a scroll, so it has no saved row. Answering
		// "none" here would leave the viewport wherever the post the reader is coming back from
		// sat (#9268).
		expect(intent({navigation: "pop", hash: "", saved: undefined})).toEqual({kind: "top"});
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

	it("lands a forward navigation at the top", () => {
		expect(intent({navigation: "push", hash: "", saved: 900})).toEqual({kind: "top"});
	});

	it("sends a forward navigation to the fragment it names", () => {
		expect(intent({navigation: "push", hash: "#comments", saved: undefined})).toEqual({
			kind: "anchor",
			id: "comments",
		});
	});

	it("lands a comment permalink at the top, because the post page scrolls that node itself", () => {
		// `PanoPostDetail`'s `useCommentAnchor` owns `#comment-<id>`. Claiming it here too would
		// put two scroll calls on one element with no ordering between them.
		expect(intent({navigation: "push", hash: "#comment-abc123", saved: 640})).toEqual({
			kind: "top",
		});
	});

	it("keeps claiming a fragment no page owns, even next to the comment family", () => {
		expect(intent({navigation: "push", hash: "#commentary", saved: undefined})).toEqual({
			kind: "anchor",
			id: "commentary",
		});
	});

	it("leaves a replace alone — it corrects the entry the reader is already on", () => {
		expect(intent({navigation: "replace", hash: "", saved: undefined})).toEqual({
			kind: "none",
		});
	});
});
