/**
 * The çaylak marker on the pano feed row (#6427, epic #4306) — the one surface that had no
 * sandbox badge at all before this, so its render is worth pinning live rather than by source
 * scan. Mocks match `PanoPostCard.compose.test.tsx`: the row and session are holders, the
 * mutation-bearing leaf widgets are stubbed out.
 */
import {render} from "@testing-library/react";
import {MemoryRouter} from "react-router";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {useSession as useSessionType} from "../../auth/client";
import {PanoPostCard} from "./PanoPostCard";

type SessionResult = ReturnType<typeof useSessionType>;

let rowData: Record<string, unknown>;
let sessionState: SessionResult;

vi.mock("react-fate", () => ({
	useLiveView: () => rowData,
	view: () => () => ({}),
}));

vi.mock("../../auth/client", () => ({
	useSession: () => sessionState,
}));

vi.mock("./PanoPost", () => ({
	PostVoteWidget: () => null,
	PostSaveButton: () => null,
}));

const AUTHOR_ID = "caylak-1";
const READER_ID = "yazar-1";

function makeRow(sandboxedInPlace: boolean | undefined): Record<string, unknown> {
	return {
		id: "p1",
		title: "başlık",
		url: null,
		host: null,
		score: 3,
		myVote: null,
		isSaved: null,
		commentCount: 0,
		createdAt: new Date("2026-08-01T00:00:00Z"),
		author: "caylak",
		authorId: AUTHOR_ID,
		authorUsername: "caylak",
		authorDisplayName: "Çaylak",
		slug: "baslik",
		tags: [],
		sandboxedInPlace,
	};
}

const signedIn = (id: string): SessionResult =>
	({data: {user: {id}}, isPending: false}) as SessionResult;

const ref = {id: "p1"} as never;

const renderCard = () =>
	render(
		<MemoryRouter>
			<PanoPostCard post={ref} />
		</MemoryRouter>,
	);

afterEach(() => vi.clearAllMocks());

describe("PanoPostCard — the çaylak marker (#6427)", () => {
	it("marks a çaylak's row for the opted-in reader", () => {
		rowData = makeRow(true);
		sessionState = signedIn(READER_ID);
		const {container} = renderCard();
		expect(container.querySelector('[data-testid="caylak-badge"]')?.textContent).toBe(
			"çaylak katkısı, hazırlık aşamasında",
		);
	});

	it("never marks the reader's own row", () => {
		rowData = makeRow(true);
		sessionState = signedIn(AUTHOR_ID);
		const {container} = renderCard();
		expect(container.querySelector('[data-testid="caylak-badge"]')).toBeNull();
	});

	// Flag off ⇒ the field is false for every viewer (or absent on a read that never stamps it).
	it("renders no marker for the flag-off wire shape", () => {
		rowData = makeRow(false);
		sessionState = signedIn(READER_ID);
		expect(renderCard().container.querySelector('[data-testid="caylak-badge"]')).toBeNull();

		rowData = makeRow(undefined);
		sessionState = signedIn(READER_ID);
		expect(renderCard().container.querySelector('[data-testid="caylak-badge"]')).toBeNull();
	});
});
