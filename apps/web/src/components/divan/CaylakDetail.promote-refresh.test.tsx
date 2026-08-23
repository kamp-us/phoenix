/**
 * Regression pin for #7036: a settled `user.promote` from the divan reviewer actions
 * must re-pull BOTH review roots (`divan.roster` + the open author's `divan.backlog`)
 * network-only, so the promoted çaylak and their pending items leave the screen
 * without a reload. Denials and transport errors must not touch either read.
 *
 * The fate hooks are stubbed at react-fate's boundary (the CaylakVisibilityToggle
 * idiom): the REAL request builders from `./divanReads` flow through the component,
 * so what the mount reads is asserted to be byte-identical to what the refresh
 * re-pulls — the property that makes the refresh land on the rendered lists.
 */
import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {CaylakDetail} from "./CaylakDetail";

const h = vi.hoisted(() => {
	const state = {
		// Overridable per test: the fake `mutations.user.promote` result/throw.
		promote: (() => ({
			result: {promoted: true, vouchRecorded: false},
			error: null,
		})) as () => unknown,
	};
	const mountedRequests: Array<Record<string, unknown>> = [];
	const clientRequests: Array<{request: unknown; options: unknown}> = [];
	return {state, mountedRequests, clientRequests};
});

vi.mock("react-fate", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react-fate")>();
	return {
		...actual,
		useRequest: (request: Record<string, unknown>) => {
			h.mountedRequests.push(request);
			return Object.fromEntries(Object.keys(request).map((root) => [root, Symbol("connection")]));
		},
		useListView: () => [
			[
				{
					cursor: "definition:d-1",
					node: {id: "definition:d-1", kind: "definition", preview: "bir tanım"},
				},
			],
			null,
		],
		useView: (_view: unknown, ref: unknown) =>
			ref && typeof ref === "object" && "__typename" in (ref as object)
				? // CaylakIdentityById's Profile ref.
					{
						userId: "u-1",
						displayName: "Çaylak Kişi",
						username: "caylak",
						image: null,
						totalKarma: 7,
						definitionCount: 1,
						postCount: 0,
						commentCount: 0,
					}
				: ref,
		useFateClient: () =>
			({
				mutations: {
					user: {promote: () => h.state.promote()},
					divan: {
						vote: () => Promise.resolve({result: null, error: null}),
						vouch: () => Promise.resolve({result: null, error: null}),
					},
					report: {submit: () => Promise.resolve({result: null, error: null})},
				},
				request: (request: unknown, options?: unknown) => {
					h.clientRequests.push({request, options});
					return Promise.resolve({});
				},
				ref: (_type: string, id: string) => ({__typename: "Profile", id}),
			}) as never,
	};
});

const clickPromote = () => fireEvent.click(screen.getByTestId("promote-button"));

beforeEach(() => {
	h.mountedRequests.length = 0;
	h.clientRequests.length = 0;
	h.state.promote = () => ({result: {promoted: true, vouchRecorded: false}, error: null});
});

afterEach(() => {
	vi.clearAllMocks();
});

function renderDetail() {
	return render(<CaylakDetail authorId="u-1" viewerTier={undefined} viewerIsModerator={true} />);
}

describe("CaylakDetail promote refresh (#7036)", () => {
	it("mounts exactly the shared builder's backlog shape", () => {
		renderDetail();
		expect(h.mountedRequests).toEqual([
			{"divan.backlog": {list: expect.anything(), args: {authorId: "u-1", first: 50}}},
		]);
	});

	it("a successful promote fires ONE network-only refresh naming both roots", async () => {
		renderDetail();
		clickPromote();
		await waitFor(() =>
			expect(screen.getByTestId("promote-status").textContent).toContain("yazar oldu"),
		);
		expect(h.clientRequests).toEqual([
			{
				request: {
					"divan.roster": {list: expect.anything(), args: {first: 50}},
					"divan.backlog": {list: expect.anything(), args: {authorId: "u-1", first: 50}},
				},
				options: {mode: "network-only"},
			},
		]);
	});

	it("an already-yazar answer ALSO refreshes — the double press repairs the stale screen", async () => {
		h.state.promote = () => ({result: {promoted: false, vouchRecorded: false}, error: null});
		renderDetail();
		clickPromote();
		await waitFor(() =>
			expect(screen.getByTestId("promote-status").textContent).toContain("zaten yazar"),
		);
		expect(h.clientRequests).toHaveLength(1);
		expect(h.clientRequests[0]?.options).toEqual({mode: "network-only"});
	});

	it("an UNAUTHORIZED denial changes nothing: no refresh, backlog still rendered", async () => {
		h.state.promote = () => ({result: null, error: {code: "UNAUTHORIZED", message: "x"}});
		renderDetail();
		clickPromote();
		await waitFor(() =>
			expect(screen.getByTestId("promote-status").textContent).toContain("yetkin yok"),
		);
		expect(h.clientRequests).toHaveLength(0);
		expect(screen.getByTestId("divan-item-definition:d-1")).toBeTruthy();
	});

	it("a thrown transport error likewise leaves both reads untouched", async () => {
		h.state.promote = () => {
			throw new Error("boundary-class refusal");
		};
		renderDetail();
		clickPromote();
		await waitFor(() =>
			expect(screen.getByTestId("promote-status").textContent).toContain("işlem başarısız oldu"),
		);
		expect(h.clientRequests).toHaveLength(0);
		expect(screen.getByTestId("divan-item-definition:d-1")).toBeTruthy();
	});
});
