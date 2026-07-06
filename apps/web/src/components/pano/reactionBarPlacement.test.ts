/**
 * Pins the reaction-bar placement decision (#2212, founder ruled option (b)
 * keep-but-relocate): pano reactions live on the post DETAIL surface, not the
 * feed row — mirroring how sözlük scopes reactions to the definition detail
 * (`DefinitionCard`), never the term list. The upvote (△) stays the feed-level
 * signal, so `PostVoteWidget` must remain on the card.
 *
 * A static source assertion (like `styles/focus-layer.test.ts`) rather than a
 * render: the contract is *which surface wires the bar*, which the imports +
 * JSX tag encode directly and stably — no fate client/session harness, and it
 * won't churn when unrelated card work lands.
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const feedCard = read("./PanoPostCard.tsx");
const detailHeader = read("./PanoPostHeader.tsx");

describe("reaction-bar placement — detail surface, not the feed (#2212)", () => {
	it("the feed card does NOT render the reaction bar", () => {
		expect(feedCard).not.toContain("PostReactionBar");
		expect(feedCard).not.toContain("ReactionBarSlot");
	});

	it("the feed card keeps the upvote signal", () => {
		expect(feedCard).toContain("PostVoteWidget");
	});

	it("the post-detail header renders the reaction bar (mirroring sözlük's definition detail)", () => {
		expect(detailHeader).toContain("ReactionBarSlot");
		expect(detailHeader).toContain("PostReactionBar");
	});
});
