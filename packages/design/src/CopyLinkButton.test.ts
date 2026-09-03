import {describe, expect, it} from "vitest";
import {shareFeedbackLabel, shouldUseNativeShare} from "./CopyLinkButton";

// The scroll-race fix (#649) lives in a DOM effect (`useCommentAnchor`) the repo's
// node-only unit tier can't exercise without jsdom — its proof is the MutationObserver
// logic + e2e. The clipboard-error surfacing reduces to this pure state→copy mapping,
// which is the swallowed-failure path that #649 made visible.
describe("shareFeedbackLabel", () => {
	it("flashes success copy on a completed clipboard write", () => {
		expect(shareFeedbackLabel("copied", "paylaş")).toBe("kopyalandı");
	});

	it("surfaces a visible error instead of silently resting on a denied write (#649)", () => {
		expect(shareFeedbackLabel("error", "paylaş")).toBe("kopyalanamadı");
	});

	it("rests on the caller's label when idle", () => {
		expect(shareFeedbackLabel(null, "paylaş")).toBe("paylaş");
	});
});

// The share-vs-copy branch is gated on a coarse-pointer surface, not bare Web Share API
// presence — Safari macOS *desktop* implements the API but must copy like every other
// desktop browser (#1635). The DOM read (matchMedia + navigator) lives in `shareOrCopy`;
// this pure predicate is the branch selection, unit-tested here without a DOM.
describe("shouldUseNativeShare", () => {
	it("uses the native sheet only on a coarse-pointer surface with a usable Web Share API", () => {
		expect(shouldUseNativeShare({hasShare: true, canShareUrl: true, coarsePointer: true})).toBe(
			true,
		);
	});

	it("copies (no native sheet) on a fine-pointer desktop even when the Web Share API is present (Safari macOS, #1635)", () => {
		expect(shouldUseNativeShare({hasShare: true, canShareUrl: true, coarsePointer: false})).toBe(
			false,
		);
	});

	it("copies when the Web Share API is absent regardless of pointer", () => {
		expect(shouldUseNativeShare({hasShare: false, canShareUrl: false, coarsePointer: true})).toBe(
			false,
		);
	});

	it("copies when `canShare` rejects the URL even on a coarse-pointer surface", () => {
		expect(shouldUseNativeShare({hasShare: true, canShareUrl: false, coarsePointer: true})).toBe(
			false,
		);
	});
});
