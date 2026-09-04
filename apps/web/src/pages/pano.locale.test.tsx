/**
 * pano's English render (#7530) — one case per surface the ticket names: the feed row, the
 * post-detail comment node, and the submit form. The locale is seeded in storage rather than
 * clicked through the UserMenu, because the `dil` row's own gate is already pinned by
 * `UserMenu.locale.test.tsx`; what is under test here is the pano copy behind it.
 */

import {ToastProvider} from "@kampus/design";
import {render, screen, waitFor} from "@testing-library/react";
import {MemoryRouter} from "react-router";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {useSession as useSessionType} from "../auth/client";
import {CommentTreeNode} from "../components/pano/CommentTreeNode";
import {PanoPostCard} from "../components/pano/PanoPostCard";
import {LocaleProvider} from "../i18n";
import {LOCALE_STORAGE_KEY} from "../lib/localeStorage";
import {PanoSubmitPage} from "./PanoSubmitPage";

type SessionResult = ReturnType<typeof useSessionType>;

let rowData: Record<string, unknown>;

vi.mock("react-fate", () => ({
	useLiveView: () => rowData,
	useFateClient: () => ({mutations: {}}),
	view: () => () => ({}),
}));

vi.mock("../auth/client", () => ({
	useSession: (): SessionResult =>
		({data: {user: {id: "u1", name: "Elif"}}, isPending: false}) as SessionResult,
}));

vi.mock("../components/authorship/FirstContributionOnramp", () => ({
	FirstContributionOnramp: () => null,
}));

vi.mock("../lib/useLinkMetadata", () => ({
	useLinkMetadata: () => ({fetchMetadata: async () => ({title: null, description: null})}),
	prefillIfEmpty: () => {},
}));

vi.mock("../components/reaction/CommentReactionBar", () => ({
	CommentReactionBar: () => null,
}));

const ref = {id: "x"} as never;

function mount(node: React.ReactNode) {
	return render(
		<MemoryRouter>
			<ToastProvider>
				<LocaleProvider>{node}</LocaleProvider>
			</ToastProvider>
		</MemoryRouter>,
	);
}

beforeEach(() => {
	window.localStorage.clear();
	window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
});

afterEach(() => vi.clearAllMocks());

describe("the pano feed reads English", () => {
	it("renders the row's meta, the save action and the plural comment count in English", async () => {
		rowData = {
			id: "p1",
			title: "a title",
			url: null,
			host: null,
			score: 3,
			myVote: null,
			isSaved: false,
			commentCount: 2,
			createdAt: new Date("2026-07-01T00:00:00Z"),
			author: "yazar",
			authorId: "a1",
			authorUsername: "yazar",
			authorDisplayName: "Yazar",
			slug: "a-title",
			tags: [],
		};
		mount(<PanoPostCard post={ref} onHide={() => {}} />);

		await waitFor(() => expect(screen.getByText("2 comments")).toBeTruthy());
		expect(screen.getByRole("button", {name: "hide"})).toBeTruthy();
		expect(screen.getByTestId("post-save-p1").textContent).toBe("save");
		// Turkish takes no plural agreement after a numeral, so both `tr` arms carry the same
		// string and the singular arm only bites in English.
		expect(screen.getByText("text")).toBeTruthy();
	});
});

describe("the post detail reads English", () => {
	it("renders the comment node's tombstone and collapse label in English", async () => {
		rowData = {
			id: "c1",
			parentId: null,
			body: "gövde",
			score: 1,
			myVote: null,
			createdAt: new Date("2026-07-01T00:00:00Z"),
			updatedAt: new Date("2026-07-01T00:00:00Z"),
			deletedAt: new Date("2026-07-02T00:00:00Z"),
			author: "yazar",
			authorId: "a1",
			authorUsername: "yazar",
			authorDisplayName: "Yazar",
			reactions: {counts: {}, myReaction: null},
		};
		mount(
			<CommentTreeNode
				comment={ref}
				postPath="/pano/a-title"
				children={[]}
				childrenForId={() => []}
				currentUserId="u1"
				composerFor={() => ({})}
			/>,
		);

		await waitFor(() => expect(screen.getByText("[deleted]")).toBeTruthy());
		expect(screen.getByRole("button", {name: "Collapse"})).toBeTruthy();
	});
});

describe("the submit page reads English", () => {
	it("renders the heading, the tag legend and the share button in English", async () => {
		mount(<PanoSubmitPage />);

		await waitFor(() => expect(screen.getByText("share something")).toBeTruthy());
		expect(screen.getByText("tags · at least 1, at most 3")).toBeTruthy();
		expect(screen.getByRole("button", {name: "share"})).toBeTruthy();
		expect(screen.getByTestId("pano-submit-tags-required").textContent).toBe(
			"pick at least one tag",
		);
		expect(screen.getByTestId("pano-submit-draft").textContent).toBe("draft");
	});
});
