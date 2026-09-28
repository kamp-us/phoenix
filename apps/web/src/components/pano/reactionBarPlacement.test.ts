/**
 * Pins the founder ruling on #2212: reactions on the post detail, never the feed row.
 *
 * Deliberately a static source assertion, not a render — no client test mounts the post-detail
 * header. The feed half is asserted on a render in `PanoPostCard.routing.test.tsx`.
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const detailHeader = read("./PanoPostHeader.tsx");

describe("reaction-bar placement — detail surface, not the feed (#2212)", () => {
	it("the post-detail header renders the reaction bar (mirroring sözlük's definition detail)", () => {
		expect(detailHeader).toContain("ReactionBarSlot");
		expect(detailHeader).toContain("PostReactionBar");
	});
});
