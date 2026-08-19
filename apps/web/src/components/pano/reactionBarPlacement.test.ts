/**
 * Pins the founder ruling on #2212: reactions on the post detail, never the feed row.
 *
 * Deliberately a static source assertion, not a render — the contract is *which
 * surface wires the bar*, which the imports encode directly and stably.
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
