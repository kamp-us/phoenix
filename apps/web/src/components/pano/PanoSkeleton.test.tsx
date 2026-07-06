/**
 * Height-match regression for #2161: the feed skeleton must reserve one row per
 * post the first page carries, else the footer jumps (~941px, 6 rows under a
 * 20-post page) when content lands. The row count is single-sourced from
 * `PANO_FEED_PAGE_SIZE`, so this pins the skeleton to the same page size the feed
 * request uses — the two can't silently drift back apart.
 */
import {render, screen} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {PANO_FEED_PAGE_SIZE} from "../../lib/panoNav";
import {PanoFeedSkeleton} from "./PanoSkeleton";

describe("PanoFeedSkeleton", () => {
	it("reserves one row per first-page post (height-matched to PANO_FEED_PAGE_SIZE)", () => {
		render(<PanoFeedSkeleton />);
		const list = screen.getByTestId("pano-feed-skeleton");
		expect(list.querySelectorAll("article.kp-pano-post")).toHaveLength(PANO_FEED_PAGE_SIZE);
	});

	it("does not under-reserve at the pre-fix 6 rows", () => {
		render(<PanoFeedSkeleton />);
		const list = screen.getByTestId("pano-feed-skeleton");
		expect(list.querySelectorAll("article.kp-pano-post").length).toBeGreaterThan(6);
	});

	it("marks the placeholder as a busy status region for assistive tech", () => {
		render(<PanoFeedSkeleton />);
		const list = screen.getByTestId("pano-feed-skeleton");
		expect(list.getAttribute("role")).toBe("status");
		expect(list.getAttribute("aria-busy")).toBe("true");
	});
});
