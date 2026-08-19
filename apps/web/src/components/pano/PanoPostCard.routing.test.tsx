/** Pins the founder ruling on #2437: the title never routes off-site. */
import {render} from "@testing-library/react";
import {MemoryRouter} from "react-router";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {useSession as useSessionType} from "../../auth/client";
import {PanoPostCard} from "./PanoPostCard";

type SessionResult = ReturnType<typeof useSessionType>;

let rowData: Record<string, unknown>;

vi.mock("react-fate", () => ({
	useLiveView: () => rowData,
	view: () => () => ({}),
}));

vi.mock("../../auth/client", () => ({
	useSession: () => ({data: null, isPending: false}) as SessionResult,
}));

vi.mock("./PanoPost", () => ({
	PostVoteWidget: () => <span data-testid="vote" />,
	PostSaveButton: () => <span data-testid="save" />,
}));

const ref = {id: "p1"} as never;

function linkRow(): Record<string, unknown> {
	return {
		id: "p1",
		title: "bir bağlantı",
		url: "https://example.com/article",
		host: "example.com",
		score: 7,
		commentCount: 2,
		createdAt: new Date("2026-07-01T00:00:00Z"),
		author: "yazar",
		authorId: "author-x",
		slug: "bir-baglanti",
		tags: [],
	};
}

function textRow(): Record<string, unknown> {
	return {...linkRow(), title: "bir yazı", url: null, host: null, slug: "bir-yazi"};
}

function renderCard() {
	return render(
		<MemoryRouter>
			<PanoPostCard post={ref} />
		</MemoryRouter>,
	);
}

afterEach(() => vi.clearAllMocks());

describe("PanoPostCard — link-post routing (#2437)", () => {
	it("routes the title to the post detail (/pano/:slug), NOT the external URL", () => {
		rowData = linkRow();
		const title = renderCard().container.querySelector(".kp-pano-post__title");
		expect(title?.getAttribute("href")).toBe("/pano/bir-baglanti");
	});

	it("puts the external URL on the domain label, opening in a new tab", () => {
		rowData = linkRow();
		const site = renderCard().container.querySelector("a.kp-pano-post__site");
		expect(site?.getAttribute("href")).toBe("https://example.com/article");
		expect(site?.getAttribute("target")).toBe("_blank");
		expect(site?.getAttribute("rel")).toContain("noopener");
		expect(site?.textContent).toContain("example.com");
	});

	it("a text post (no url) keeps its title internal and renders no external link", () => {
		rowData = textRow();
		const {container} = renderCard();
		expect(container.querySelector(".kp-pano-post__title")?.getAttribute("href")).toBe(
			"/pano/bir-yazi",
		);
		expect(container.querySelector("a.kp-pano-post__site")).toBeNull();
		expect(container.querySelector("span.kp-pano-post__site")?.textContent).toBe("yazı");
	});
});
