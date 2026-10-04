import {describe, expect, it} from "vitest";
import {isUiSurface} from "../review/classes.ts";
import {noPreviewMode} from "../review-ui/no-preview.ts";
import {reviewUiKey} from "./keys/review-ui.ts";
import {uiSurfacesKey} from "./keys/ui-surfaces.ts";
import {loadConfig} from "./load.ts";
import {readFromLoad} from "./read-key.ts";
import {
	raisedPrefixes,
	SCREEN_CHECK_SKIPPED,
	screenReviewOf,
	strictestMode,
	TURN_ON_STEP,
	unmatchedMode,
} from "./screen-review.ts";

const ROW = {
	name: "web",
	prefix: "apps/shop/src/",
	mount: "/",
	command: "pnpm dev --port {{port}}",
};

/** Screen review as a `.fabrika.jsonc` with these keys resolves it. */
const resolved = (config: Record<string, unknown>) => {
	const load = loadConfig({_tag: "Text", text: JSON.stringify(config)});
	const reviewUi = readFromLoad(load, reviewUiKey);
	const surfaces = readFromLoad(load, uiSurfacesKey);
	if (reviewUi._tag === "Refused") throw new Error(reviewUi.reason);
	if (surfaces._tag === "Refused") throw new Error(surfaces.reason);
	return {review: screenReviewOf(reviewUi.value, surfaces.value), rules: reviewUi.value};
};

/**
 * What a pull request with no preview that changes `files` meets: `null` where no file raises the
 * ui class, else the mode `review-ui route --no-preview` resolves over the ones that do.
 */
const withNoPreview = (config: Record<string, unknown>, files: ReadonlyArray<string>) => {
	const {review, rules} = resolved(config);
	const ui = files.filter((file) => isUiSurface(file, raisedPrefixes(review)));
	return ui.length === 0
		? null
		: noPreviewMode(rules.whenNoPreview, ui, unmatchedMode(review.mode));
};

describe("screenReviewOf", () => {
	it("resolves skip for a repo that declares no mode, no row, no screens path and no rule", () => {
		for (const config of [{}, {uiSurfaces: []}, {reviewUi: {}}, {reviewUi: {whenNoPreview: []}}]) {
			const {review} = resolved(config);
			expect(review.mode).toBe("skip");
			expect(review.declared).toBe(false);
			expect(raisedPrefixes(review)).toEqual([]);
		}
	});

	it("keeps a repo with rows and no rules on a render when a pull request has no preview", () => {
		const config = {uiSurfaces: [ROW]};
		const {review} = resolved(config);
		expect(review).toMatchObject({mode: "preview", declared: false});
		expect(raisedPrefixes(review)).toEqual(["apps/shop/src/"]);
		expect(withNoPreview(config, ["apps/shop/src/page.tsx"])).toBe("require-render");
	});

	it("keeps a repo with a hand-check rule over declared rows on hand-check", () => {
		const config = {
			uiSurfaces: [ROW],
			reviewUi: {whenNoPreview: [{paths: ["**"], mode: "hand-check"}]},
		};
		expect(resolved(config).review).toMatchObject({mode: "preview", declared: false});
		expect(withNoPreview(config, ["apps/shop/src/page.tsx"])).toBe("hand-check");
	});

	it("resolves preview, never skip, for a repo that declared only rules", () => {
		const config = {reviewUi: {whenNoPreview: [{paths: ["**"], mode: "hand-check"}]}};
		expect(resolved(config).review.mode).toBe("preview");
		expect(withNoPreview(config, ["index.html"])).toBeNull();
	});

	it("takes a declared mode over anything derived", () => {
		expect(resolved({uiSurfaces: [ROW], reviewUi: {mode: "skip"}}).review).toMatchObject({
			mode: "skip",
			declared: true,
			screens: ["apps/shop/src/"],
		});
		expect(resolved({reviewUi: {mode: "preview"}}).review).toMatchObject({
			mode: "preview",
			declared: true,
		});
	});

	it("raises no ui class at skip, over rows and screens paths alike", () => {
		const config = {uiSurfaces: [ROW], reviewUi: {mode: "skip", screens: ["index.html"]}};
		const {review} = resolved(config);
		expect(review.screens).toEqual(["apps/shop/src/", "index.html"]);
		expect(raisedPrefixes(review)).toEqual([]);
		expect(withNoPreview(config, ["apps/shop/src/page.tsx", "index.html"])).toBeNull();
	});

	it("behaves at preview as require-render does: a screen file with no preview needs a render", () => {
		const config = {reviewUi: {mode: "preview", screens: ["index.html"]}};
		expect(withNoPreview(config, ["index.html"])).toBe("require-render");
	});

	it("stops a screens-only repo at hand-check, with no row and no start command", () => {
		const config = {reviewUi: {mode: "hand-check", screens: ["index.html", "src/"]}};
		expect(withNoPreview(config, ["src/app.js"])).toBe("hand-check");
		expect(withNoPreview(config, ["README.md"])).toBeNull();
	});

	it("lets a stricter rule win over the hand-check mode, path by path", () => {
		const config = {
			reviewUi: {
				mode: "hand-check",
				screens: ["src/"],
				whenNoPreview: [{paths: ["src/checkout/**"], mode: "require-render"}],
			},
		};
		expect(withNoPreview(config, ["src/home.tsx"])).toBe("hand-check");
		expect(withNoPreview(config, ["src/home.tsx", "src/checkout/pay.tsx"])).toBe("require-render");
	});
});

describe("strictestMode", () => {
	it("takes the stricter of a head's answer and its merge base's", () => {
		expect(strictestMode("skip", "preview")).toBe("preview");
		expect(strictestMode("hand-check", "skip")).toBe("hand-check");
		expect(strictestMode("skip", "skip")).toBe("skip");
		expect(strictestMode("skip")).toBe("skip");
	});
});

describe("unmatchedMode", () => {
	it("never answers looser than a render for a checkout at skip", () => {
		expect(unmatchedMode("preview")).toBe("require-render");
		expect(unmatchedMode("hand-check")).toBe("hand-check");
		expect(unmatchedMode("skip")).toBe("require-render");
	});
});

describe("the skip sentence", () => {
	it("says the check was skipped, why, and the one step that turns it on", () => {
		expect(SCREEN_CHECK_SKIPPED).toBe(
			"The screen check was skipped because screen review is not set up in this repo; to turn it on, run `fabrika status bootstrap hand-check-rule --screens <path>`, where <path> is the folder or file your screens live in.",
		);
		expect(SCREEN_CHECK_SKIPPED).toContain(TURN_ON_STEP);
	});
});
