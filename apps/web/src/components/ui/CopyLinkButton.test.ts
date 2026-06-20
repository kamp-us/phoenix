import {describe, expect, it} from "vitest";
import {shareFeedbackLabel} from "./CopyLinkButton";

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
