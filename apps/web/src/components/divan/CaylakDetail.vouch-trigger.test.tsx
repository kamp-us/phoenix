/**
 * Regression pin for #7373: the divan trigger must report whether the viewer is
 * ALREADY this çaylak's kefil, both durably (off the roster row's viewer-scoped
 * `viewerVouched`) and immediately after a confirm, and it must never offer a
 * withdraw action in the done state.
 *
 * react-fate is stubbed at its boundary (the `CaylakDetail.promote-refresh` idiom), so
 * the REAL `VouchSheet` + gating flow through the component.
 */
import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {CaylakDetail} from "./CaylakDetail";

const h = vi.hoisted(() => {
	const state = {
		vouch: (() => ({
			result: {userId: "u-1", promoted: false, vouchRecorded: true},
			error: null,
		})) as () => unknown,
	};
	const clientRequests: Array<{request: unknown; options: unknown}> = [];
	return {state, clientRequests};
});

vi.mock("react-fate", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react-fate")>();
	return {
		...actual,
		useRequest: (request: Record<string, unknown>) =>
			Object.fromEntries(Object.keys(request).map((root) => [root, Symbol("connection")])),
		useListView: () => [[], null],
		useView: (_view: unknown, ref: unknown) =>
			ref && typeof ref === "object" && "__typename" in (ref as object)
				? {userId: "u-1", displayName: "Çaylak Kişi", username: "caylak", totalKarma: 7}
				: ref,
		useFateClient: () =>
			({
				mutations: {
					user: {
						vouch: () => h.state.vouch(),
						promote: () => Promise.resolve({result: null, error: null}),
					},
					divan: {vote: () => Promise.resolve({result: null, error: null})},
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

beforeEach(() => {
	h.clientRequests.length = 0;
	h.state.vouch = () => ({
		result: {userId: "u-1", promoted: false, vouchRecorded: true},
		error: null,
	});
});

afterEach(() => {
	vi.clearAllMocks();
});

const renderDetail = (opts: {tier?: string; vouched?: boolean} = {}) =>
	render(
		<CaylakDetail
			authorId="u-1"
			viewerTier={(opts.tier ?? "yazar") as never}
			viewerIsModerator={false}
			viewerVouched={opts.vouched ?? false}
		/>,
	);

const trigger = () => screen.getByTestId("vouch-button") as HTMLButtonElement;

describe("CaylakDetail vouch trigger — the already-vouched state (#7373)", () => {
	it("a yazar who has not vouched is offered the enabled action", () => {
		renderDetail();
		expect(trigger().textContent).toContain("kefil ol");
		expect(trigger().disabled).toBe(false);
	});

	it("a yazar already holding this çaylak's vouch sees the disabled past tense", () => {
		renderDetail({vouched: true});
		expect(trigger().textContent).toContain("kefil oldun");
		expect(trigger().disabled).toBe(true);
	});

	it("the done state offers no withdraw affordance — one trigger, no second action", () => {
		renderDetail({vouched: true});
		expect(screen.queryAllByTestId("vouch-button")).toHaveLength(1);
		expect(screen.queryByText(/geri çek/i)).toBeNull();
	});

	it("a non-yazar sees no trigger at all", () => {
		renderDetail({tier: "çaylak"});
		expect(screen.queryByTestId("vouch-button")).toBeNull();
	});

	it("a landed confirm flips the trigger without a reload, and re-pulls the roster", async () => {
		renderDetail();
		fireEvent.click(trigger());
		fireEvent.click(await screen.findByTestId("vouch-confirm-button"));
		await waitFor(() => expect(trigger().textContent).toContain("kefil oldun"));
		expect(trigger().disabled).toBe(true);
		expect(h.clientRequests).toHaveLength(1);
		expect(h.clientRequests[0]?.options).toEqual({mode: "network-only"});
	});

	it("a cap denial leaves the trigger offering the action, and re-pulls nothing", async () => {
		h.state.vouch = () => ({
			result: null,
			error: {code: "VOUCH_LIMIT_REACHED", message: "x"},
		});
		renderDetail();
		fireEvent.click(trigger());
		fireEvent.click(await screen.findByTestId("vouch-confirm-button"));
		await waitFor(() =>
			expect(screen.getByTestId("vouch-status").textContent).toContain("üç kişiye"),
		);
		expect(trigger().textContent).toContain("kefil ol");
		expect(trigger().disabled).toBe(false);
		expect(h.clientRequests).toHaveLength(0);
	});
});
