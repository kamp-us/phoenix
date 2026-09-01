/**
 * One `myAuthorshipStanding` request per çaylak, however many surfaces want it (#7045).
 *
 * `useImperativeView` has no dedupe — each instance fires its own `fate.request` in an effect —
 * so with the ambient meter on, a çaylak opening their own profile used to issue the view twice:
 * once for the chrome's chip, once for this block. The channel is what removes the second.
 */
import {render, screen} from "@testing-library/react";
import {beforeEach, describe, expect, it, vi} from "vitest";
import {AuthorshipStandingContext, CaylakStatusBlock} from "./CaylakStatusBlock";

const {reads, STANDING} = vi.hoisted(() => ({
	reads: [] as boolean[],
	STANDING: {karma: 9, bar: 15, vouchExists: true, inReviewCount: 0},
}));

vi.mock("../../auth/useMe", () => ({
	useMe: () => ({
		me: {id: "u-1", tier: "çaylak"},
		status: "ok",
		loading: false,
		refetch: vi.fn(),
	}),
}));

vi.mock("../../fate/useImperativeView", () => ({
	useImperativeView: (_root: string, _view: unknown, {enabled}: {enabled: boolean}) => {
		reads.push(enabled);
		return {
			state: enabled ? {status: "ok", data: STANDING} : {status: "idle"},
			refetch: vi.fn(),
		};
	},
}));

const issued = () => reads.filter(Boolean).length;

describe("CaylakStatusBlock standing channel (#7045)", () => {
	beforeEach(() => {
		reads.length = 0;
	});

	it("with no upstream read, the block issues its own — today's flag-off path, unchanged", () => {
		render(<CaylakStatusBlock profileUserId="u-1" />);
		expect(issued()).toBe(1);
		expect(screen.getByTestId("caylak-status-block")).toBeTruthy();
	});

	// The criterion: own profile + meter on ⇒ exactly one request in total. The chrome's read is
	// the one; this block issues none and renders off the published value.
	it("under the chrome's live read, the block issues none and renders off it", () => {
		render(
			<AuthorshipStandingContext.Provider value={{standing: STANDING}}>
				<CaylakStatusBlock profileUserId="u-1" />
			</AuthorshipStandingContext.Provider>,
		);
		expect(issued()).toBe(0);
		expect(screen.getByTestId("caylak-status-karma").textContent).toContain("9");
	});

	// The channel is published from the first frame, before the chrome's read settles. A block
	// that read `standing === null` as "nobody is reading" would issue the duplicate right there.
	it("issues none while the chrome's read is still settling", () => {
		render(
			<AuthorshipStandingContext.Provider value={{standing: null}}>
				<CaylakStatusBlock profileUserId="u-1" />
			</AuthorshipStandingContext.Provider>,
		);
		expect(issued()).toBe(0);
		expect(screen.queryByTestId("caylak-status-block")).toBeNull();
	});
});
