/**
 * Covers `readImperativeView` — the request → readView → cast read body the three
 * above-Suspense hooks used to each copy (#1420). The single `as` cast is the
 * load-bearing thing here (the #448 swallow site): `readView`'s static type drops
 * the selected scalars, so the `ok` case asserts a selected field reads back
 * through the cast. Pure (no DOM/React), per the issue's "pure-core unit test"
 * option.
 */
import {view} from "react-fate";
import {describe, expect, it, vi} from "vitest";
import {type ImperativeViewClient, readImperativeView} from "./useImperativeView";

const TestView = view<{__typename: "TestEntity"; id: string; name: string; count: number}>()({
	id: true,
	name: true,
	count: true,
});

function makeClient(request: ReturnType<typeof vi.fn>, readView: ReturnType<typeof vi.fn>) {
	return {request, readView} as ImperativeViewClient;
}

describe("readImperativeView", () => {
	it("reads the root ref and returns the cast-surfaced selection", async () => {
		const data = {__typename: "TestEntity", id: "1", name: "neo", count: 7};
		const request = vi.fn().mockResolvedValue({test: "ref-1"});
		const readView = vi.fn().mockResolvedValue({data, coverage: []});

		const result = await readImperativeView(makeClient(request, readView), "test", TestView);

		expect(result).toEqual(data);
		// The cast is the thing under test: the selected scalar reads back typed.
		expect(result?.count).toBe(7);
		expect(request).toHaveBeenCalledWith({test: {view: TestView}});
		expect(readView).toHaveBeenCalledWith(TestView, "ref-1");
	});

	it("returns null for a null root ref without reading a view (empty is not an error)", async () => {
		const request = vi.fn().mockResolvedValue({test: null});
		const readView = vi.fn();

		const result = await readImperativeView(makeClient(request, readView), "test", TestView);

		expect(result).toBeNull();
		expect(readView).not.toHaveBeenCalled();
	});

	it("forwards args to the request", async () => {
		const data = {__typename: "TestEntity", id: "9", name: "ada", count: 1};
		const request = vi.fn().mockResolvedValue({profile: "ref-9"});
		const readView = vi.fn().mockResolvedValue({data, coverage: []});

		await readImperativeView(makeClient(request, readView), "profile", TestView, {username: "ada"});

		expect(request).toHaveBeenCalledWith({profile: {view: TestView, args: {username: "ada"}}});
	});

	it("propagates a thrown read (the hook's catch maps it to error state)", async () => {
		const request = vi.fn().mockRejectedValue(new Error("boom"));
		const readView = vi.fn();

		await expect(
			readImperativeView(makeClient(request, readView), "test", TestView),
		).rejects.toThrow("boom");
	});
});
