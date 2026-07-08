/**
 * Base + overlay composition on the card (#2323, leg B). Pins the two client-composition
 * ACs at the component level: (1) with compose on, the base row paints while the viewer
 * scalars stay neutral until the overlay lands under the confirmed identity, then patch in
 * place; (2) a signed-in viewer never sees another/stale identity's overlay during the
 * compose window. The leaf vote/save widgets are stubbed to surface the scalars the card
 * feeds them — the pure identity guard is covered separately in `panoFeedOverlay.test.ts`.
 */
import {render} from "@testing-library/react";
import {MemoryRouter} from "react-router";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {useSession as useSessionType} from "../../auth/client";
import {PanoPostCard} from "./PanoPostCard";

type SessionResult = ReturnType<typeof useSessionType>;

// The row `useLiveView` resolves for the post ref, and the session state, both swappable
// per test through these holders (a live `Post` carrying identity A's own scalars).
let rowData: Record<string, unknown>;
let sessionState: SessionResult;

vi.mock("react-fate", () => ({
	useLiveView: () => rowData,
	view: () => () => ({}),
}));

vi.mock("../../auth/client", () => ({
	useSession: () => sessionState,
}));

// Stub the mutation-bearing leaf widgets to render the exact scalar the card feeds them,
// so the assertion reads what the card composed — not the widget's own behavior.
vi.mock("./PanoPost", () => ({
	PostVoteWidget: ({myVote}: {myVote: boolean | null}) => (
		<span data-testid="vote">{String(myVote)}</span>
	),
	PostSaveButton: ({isSaved}: {isSaved: boolean | null}) => (
		<span data-testid="save">{String(isSaved)}</span>
	),
}));

const POST_ID = "p1";

function makeRow(myVote: boolean | null, isSaved: boolean | null): Record<string, unknown> {
	return {
		id: POST_ID,
		title: "başlık",
		url: "https://example.com",
		host: "example.com",
		score: 7,
		myVote,
		isSaved,
		commentCount: 2,
		createdAt: new Date("2026-07-01T00:00:00Z"),
		author: "yazar",
		authorId: "author-x",
		authorUsername: "yazar",
		authorDisplayName: "Yazar",
		slug: "baslik",
		tags: [],
	};
}

const pending: SessionResult = {data: null, isPending: true} as SessionResult;
const signedIn = (id: string): SessionResult =>
	({data: {user: {id}}, isPending: false}) as SessionResult;
const anon: SessionResult = {data: null, isPending: false} as SessionResult;

const ref = {id: POST_ID} as never;

function scalars(container: HTMLElement) {
	return {
		vote: container.querySelector('[data-testid="vote"]')?.textContent,
		save: container.querySelector('[data-testid="save"]')?.textContent,
	};
}

afterEach(() => vi.clearAllMocks());

describe("PanoPostCard — base + overlay composition (compose on)", () => {
	it("paints base with NEUTRAL scalars while the session is still resolving (overlay pending)", () => {
		rowData = makeRow(true, true);
		sessionState = pending;
		const {container} = render(
			<MemoryRouter>
				<PanoPostCard post={ref} compose />
			</MemoryRouter>,
		);
		// The base row is on screen (title), but the viewer scalars are held neutral.
		expect(container.textContent).toContain("başlık");
		expect(scalars(container)).toEqual({vote: "null", save: "null"});
	});

	it("lands the viewer's own scalars once the session resolves under the matching identity", () => {
		rowData = makeRow(true, true);
		sessionState = signedIn("user-a");
		const {container} = render(
			<MemoryRouter>
				<PanoPostCard post={ref} compose />
			</MemoryRouter>,
		);
		expect(scalars(container)).toEqual({vote: "true", save: "true"});
	});

	it("renders the anon viewer's own null scalars (no vote/save)", () => {
		rowData = makeRow(null, null);
		sessionState = anon;
		const {container} = render(
			<MemoryRouter>
				<PanoPostCard post={ref} compose />
			</MemoryRouter>,
		);
		expect(scalars(container)).toEqual({vote: "null", save: "null"});
	});
});

describe("PanoPostCard — compose off is byte-identical (reads scalars straight off the post)", () => {
	it("feeds the post's own scalars to the controls regardless of session pending", () => {
		rowData = makeRow(true, false);
		sessionState = pending;
		const {container} = render(
			<MemoryRouter>
				<PanoPostCard post={ref} />
			</MemoryRouter>,
		);
		expect(scalars(container)).toEqual({vote: "true", save: "false"});
	});
});
