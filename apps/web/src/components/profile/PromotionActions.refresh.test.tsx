/**
 * Regression pin for #7036's profile leg: the profile-page promote handler mirrors the
 * divan one — a settled tier answer (flip OR already-yazar) invokes the page-supplied
 * post-success refresh; a denial or thrown transport error must not.
 */
import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, describe, expect, it, vi} from "vitest";
import {PromotionActions} from "./PromotionActions";

const h = vi.hoisted(() => {
	const state = {
		promote: (() => ({
			result: {promoted: true, vouchRecorded: false},
			error: null,
		})) as () => unknown,
	};
	return {state};
});

vi.mock("react-fate", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react-fate")>();
	return {
		...actual,
		useFateClient: () =>
			({
				mutations: {
					user: {promote: () => h.state.promote()},
				},
			}) as never,
	};
});

const clickPromote = () => fireEvent.click(screen.getByTestId("promote-button"));

afterEach(() => {
	h.state.promote = () => ({result: {promoted: true, vouchRecorded: false}, error: null});
});

describe("PromotionActions post-success refresh (#7036)", () => {
	it("a flip triggers the page refresh exactly once", async () => {
		const onSuccessRefresh = vi.fn();
		render(<PromotionActions userId="u-1" onSuccessRefresh={onSuccessRefresh} />);
		clickPromote();
		await waitFor(() =>
			expect(screen.getByTestId("promotion-status").textContent).toContain("yazar oldu"),
		);
		expect(onSuccessRefresh).toHaveBeenCalledTimes(1);
	});

	it("an already-yazar answer triggers it too — the stale page re-pulls", async () => {
		h.state.promote = () => ({result: {promoted: false, vouchRecorded: false}, error: null});
		const onSuccessRefresh = vi.fn();
		render(<PromotionActions userId="u-1" onSuccessRefresh={onSuccessRefresh} />);
		clickPromote();
		await waitFor(() =>
			expect(screen.getByTestId("promotion-status").textContent).toContain("zaten yazar"),
		);
		expect(onSuccessRefresh).toHaveBeenCalledTimes(1);
	});

	it("an UNAUTHORIZED denial does not trigger any refresh", async () => {
		h.state.promote = () => ({result: null, error: {code: "UNAUTHORIZED", message: "x"}});
		const onSuccessRefresh = vi.fn();
		render(<PromotionActions userId="u-1" onSuccessRefresh={onSuccessRefresh} />);
		clickPromote();
		await waitFor(() =>
			expect(screen.getByTestId("promotion-status").textContent).toContain("yetkin yok"),
		);
		expect(onSuccessRefresh).not.toHaveBeenCalled();
	});

	it("a thrown transport error does not trigger any refresh", async () => {
		h.state.promote = () => {
			throw new Error("boundary-class refusal");
		};
		const onSuccessRefresh = vi.fn();
		render(<PromotionActions userId="u-1" onSuccessRefresh={onSuccessRefresh} />);
		clickPromote();
		await waitFor(() =>
			expect(screen.getByTestId("promotion-status").textContent).toContain("işlem başarısız oldu"),
		);
		expect(onSuccessRefresh).not.toHaveBeenCalled();
	});

	it("renders fine with no refresh supplied (prop is optional)", async () => {
		render(<PromotionActions userId="u-1" />);
		clickPromote();
		await waitFor(() =>
			expect(screen.getByTestId("promotion-status").textContent).toContain("yazar oldu"),
		);
	});
});
